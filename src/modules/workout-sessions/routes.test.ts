import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { status } from '@grpc/grpc-js'
import { buildApp } from '../../app.js'
import { grpcCall, mapGrpcError } from '../../grpc/call.js'
import { bearer, fakeGrpcCall, ids } from '../../test/fakeUpstream.js'

vi.mock('../../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)
const upstreamRequest = (rpc: string) => grpcCallMock.mock.calls.find(([, method]) => method === rpc)?.[2]

/** Answers `rpc` with `answer` (or throws it, for an Error) and everything else from the fake upstream. */
function override(rpc: string, answer: unknown) {
  grpcCallMock.mockImplementation(async (client, method, request, options) => {
    if (method === rpc) {
      if (answer instanceof Error) throw answer
      return answer as never
    }
    return fakeGrpcCall(client, method, request, options)
  })
}

beforeEach(() => {
  grpcCallMock.mockReset()
  grpcCallMock.mockImplementation(fakeGrpcCall)
})

describe('client workout lifecycle routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({ rateLimits: { globalMax: 1_000_000, authMax: 1_000_000 } })
    await app.ready()
  })
  afterAll(() => app.close())

  const send = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, as: Parameters<typeof bearer>[0], payload?: object) =>
    app.inject({ method, url, headers: bearer(as), ...(payload ? { payload } : {}) })

  describe('GET /workouts/:id/session', () => {
    it('answers the session with its status and, per set, what this session recorded', async () => {
      override('ListSetLogs', {
        setLogs: [
          { id: '9', workoutLogId: String(ids.workoutLogA), exerciseSetId: String(ids.exerciseSetA), weight: '', reps: 10, recordedAt: '2026-10-21T10:00:00Z' },
        ],
      })
      const res = await send('GET', `/api/workouts/${ids.workoutA}/session`, 'clientA')
      expect(res.statusCode, res.body).toBe(200)
      const body = res.json()
      expect(body.workoutLog).toMatchObject({ id: ids.workoutLogA, status: 'IN_PROGRESS', completionKind: '' })
      const set = body.exercises[0].sets.find((s: { id: number }) => s.id === ids.exerciseSetA)
      expect(set.current).toMatchObject({ exerciseSetId: ids.exerciseSetA, weight: '' })
      expect(upstreamRequest('ListSetLogs')).toEqual({ workoutLogId: ids.workoutLogA })
    })

    it('reads a log from an API without statuses from completedAt', async () => {
      override('GetOrStartWorkoutLog', {
        id: String(ids.workoutLogA),
        workoutId: String(ids.workoutA),
        clientId: String(ids.clientA),
        weekStartDate: '2026-10-19',
        startedAt: '2026-10-19T10:00:00Z',
        completedAt: '2026-10-19T11:00:00Z',
        status: 'WORKOUT_LOG_STATUS_UNSPECIFIED',
        completionKind: 'COMPLETION_KIND_UNSPECIFIED',
      })
      const res = await send('GET', `/api/workouts/${ids.workoutA}/session`, 'clientA')
      expect(res.json().workoutLog).toMatchObject({ status: 'COMPLETED', completionKind: '' })
    })
  })

  describe('POST /workouts/:id/session/restart', () => {
    it('starts a redo as the caller and answers the session shape', async () => {
      const res = await send('POST', `/api/workouts/${ids.workoutA}/session/restart`, 'clientA')
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json().workoutLog.id).toBe(901)
      expect(upstreamRequest('RestartWorkoutLog')).toMatchObject({ workoutId: ids.workoutA, clientId: ids.clientA })
    })

    it('is the client’s own: a trainer gets 403', async () => {
      const res = await send('POST', `/api/workouts/${ids.workoutA}/session/restart`, 'trainerA')
      expect(res.statusCode).toBe(403)
      expect(upstreamRequest('RestartWorkoutLog')).toBeUndefined()
    })
  })

  describe('DELETE /workout-sessions/:id and /sets/:setId', () => {
    it('discards the session and unticks a set', async () => {
      expect((await send('DELETE', `/api/workout-sessions/${ids.workoutLogA}`, 'clientA')).statusCode).toBe(204)
      expect(upstreamRequest('DiscardWorkoutLog')).toEqual({ id: ids.workoutLogA })
      const untick = await send('DELETE', `/api/workout-sessions/${ids.workoutLogA}/sets/${ids.exerciseSetA}`, 'clientA')
      expect(untick.statusCode, untick.body).toBe(204)
      expect(upstreamRequest('DeleteSetLog')).toEqual({ workoutLogId: ids.workoutLogA, exerciseSetId: ids.exerciseSetA })
    })

    it('answers 409 when the session is already completed', async () => {
      override('DiscardWorkoutLog', mapGrpcError({ code: status.FAILED_PRECONDITION, details: 'completed' }))
      const res = await send('DELETE', `/api/workout-sessions/${ids.workoutLogA}`, 'clientA')
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('PRECONDITION_FAILED')
    })

    it('records a set without a weight', async () => {
      const res = await send('POST', `/api/workout-sessions/${ids.workoutLogA}/sets`, 'clientA', {
        exerciseSetId: ids.exerciseSetA,
        weight: '',
        reps: 10,
      })
      expect(res.statusCode, res.body).toBe(201)
      expect(upstreamRequest('RecordSetLog')).toMatchObject({ weight: '' })
    })
  })

  describe('POST /workout-logs/:id/feedback', () => {
    it('sends the rating upstream and answers it without the proto prefix', async () => {
      const res = await send('POST', `/api/workout-logs/${ids.workoutLogA}/feedback`, 'clientA', { rating: 'HARD' })
      expect(res.statusCode, res.body).toBe(201)
      expect(upstreamRequest('SubmitWorkoutFeedback')).toEqual({
        workoutLogId: ids.workoutLogA,
        rating: 'FEEDBACK_RATING_HARD',
        text: '',
      })
      expect(res.json()).toMatchObject({ rating: 'HARD', text: '', replaced: false })
    })
  })

  describe('trainer contacts', () => {
    it("gives a client their trainer's card", async () => {
      const res = await send('GET', '/api/auth/me/trainer', 'clientA')
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ name: 'Trainer A', email: '', whatsapp: '11987654321', instagram: '' })
      expect(upstreamRequest('GetClientTrainer')).toEqual({ clientId: ids.clientA })
    })

    it('answers 404 to a client without an active trainer', async () => {
      override('GetClientTrainer', mapGrpcError({ code: status.NOT_FOUND, details: 'no trainer' }))
      const res = await send('GET', '/api/auth/me/trainer', 'clientA')
      expect(res.statusCode).toBe(404)
    })

    it('lets a trainer set contacts; an omitted one stays out of the upstream request', async () => {
      const res = await send('PATCH', '/api/auth/me', 'trainerA', { whatsapp: '(11) 98765-4321', showWhatsapp: true })
      expect(res.statusCode, res.body).toBe(200)
      const user = (upstreamRequest('UpdateUser') as { user: Record<string, unknown> }).user
      expect(user).toMatchObject({ whatsapp: '11987654321', showWhatsapp: true })
      expect(user).not.toHaveProperty('instagram')
      expect(user).not.toHaveProperty('showEmail')
    })

    it('refuses contacts from a client, with no upstream write', async () => {
      const res = await send('PATCH', '/api/auth/me', 'clientA', { instagram: '@marina' })
      expect(res.statusCode).toBe(400)
      expect(upstreamRequest('UpdateUser')).toBeUndefined()
    })
  })
})
