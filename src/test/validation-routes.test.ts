import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { grpcCall } from '../grpc/call.js'
import { bearer, fakeGrpcCall, ids, isWriteRpc, type Actor } from './fakeUpstream.js'

// Input bounds (P1-09, mirroring vertice-api's PR #70) at the route: every case below must be a
// 400 VALIDATION_ERROR from Zod and no write RPC may reach vertice-api. Routes that look a
// resource up for ownership before parsing the body (as they all do) read from the in-memory
// upstream; the reads are fine, the writes are what must not happen. Schema-level detail lives in
// each module's `schemas.test.ts`.
vi.mock('../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

describe('input bounds at the routes', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(() => app.close())
  beforeEach(() => {
    grpcCallMock.mockReset()
    grpcCallMock.mockImplementation(fakeGrpcCall)
  })

  const writes = () => grpcCallMock.mock.calls.map(([, method]) => method as string).filter(isWriteRpc)

  async function expectRefused(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    as: Actor,
    payload?: unknown,
    field?: string,
  ) {
    const res = await app.inject({ method, url, headers: bearer(as), payload: payload as never })
    expect(res.statusCode, res.body).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    if (field) expect(res.json().error.details.fieldErrors[field], res.body).toBeDefined()
    expect(writes()).toEqual([])
  }

  describe('feedback', () => {
    const url = `/api/workout-logs/${ids.workoutLogA}/feedback`

    it('a 10 KB text is a 400 at the BFF, with no upstream call', async () => {
      await expectRefused('POST', url, 'clientA', { rating: 'HARD', text: 'x'.repeat(10 * 1024) }, 'text')
    })

    it('a text of 2001 characters is a 400, one of 2000 gets past validation', async () => {
      await expectRefused('POST', url, 'clientA', { rating: 'HARD', text: 'x'.repeat(2001) }, 'text')
      const res = await app.inject({
        method: 'POST',
        url,
        headers: bearer('clientA'),
        payload: { rating: 'HARD', text: 'x'.repeat(2000) },
      })
      expect(res.statusCode, res.body).toBe(201)
    })

    it('a missing rating is a 400', async () => {
      await expectRefused('POST', url, 'clientA', { text: 'Pesado' }, 'rating')
    })
  })

  describe('register and login', () => {
    const register = {
      name: 'Nova',
      email: 'nova@vertice.test',
      password: 'secret-123',
      role: 'trainerA',
      acceptedTermsVersion: 'v1',
    }
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as never })

    it('register without a CPF, or with a bad check digit, is a 400', async () => {
      for (const cpf of [undefined, '', '52998224726']) {
        const res = await post('/api/auth/register', { ...register, cpf })
        expect(res.statusCode, res.body).toBe(400)
        expect(res.json().error.details.fieldErrors.cpf).toBeDefined()
      }
      expect(grpcCallMock).not.toHaveBeenCalled() // public route: refused before any upstream call
    })

    it('register with a 73-byte password is a 400', async () => {
      const res = await post('/api/auth/register', { ...register, cpf: '52998224725', password: 'a'.repeat(73) })
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json().error.details.fieldErrors.password).toBeDefined()
      expect(grpcCallMock).not.toHaveBeenCalled() // public route: refused before any upstream call
    })

    it('login stays lenient on the policy but refuses a huge password before hashing it', async () => {
      const res = await post('/api/auth/login', { email: 'a@vertice.test', password: 'p'.repeat(1001) })
      expect(res.statusCode, res.body).toBe(400)
      expect(grpcCallMock).not.toHaveBeenCalled() // public route: refused before any upstream call
    })
  })

  describe('clients', () => {
    it('POST /clients refuses a CPF with a bad check digit and an oversized name', async () => {
      await expectRefused('POST', '/api/clients', 'trainerA', { name: 'Ana', email: 'a@vertice.test', cpf: '52998224726' }, 'cpf')
      await expectRefused('POST', '/api/clients', 'trainerA', { name: 'a'.repeat(256), email: 'a@vertice.test' }, 'name')
    })

    it('PATCH /clients/:id refuses a CPF of the wrong length', async () => {
      await expectRefused('PATCH', `/api/clients/${ids.clientA}`, 'trainerA', { name: 'Ana', email: 'a@vertice.test', cpf: '5299822472' }, 'cpf')
    })
  })

  describe('training plans', () => {
    const plan = { name: 'Plano', clientId: ids.clientA, startDate: '2026-11-01', endDate: '2027-01-31', level: 'BEGINNER' }

    it('POST refuses an end before the start', async () => {
      await expectRefused('POST', '/api/training-plans', 'trainerA', { ...plan, endDate: '2026-10-31' }, 'endDate')
    })

    it('POST refuses an oversized name and description', async () => {
      await expectRefused('POST', '/api/training-plans', 'trainerA', { ...plan, name: 'a'.repeat(256) }, 'name')
      await expectRefused('POST', '/api/training-plans', 'trainerA', { ...plan, description: 'd'.repeat(256) }, 'description')
    })

    it('GET ?clientId=abc is a 400 instead of NaN going upstream', async () => {
      await expectRefused('GET', '/api/training-plans?clientId=abc', 'trainerA', undefined, 'clientId')
    })
  })

  describe('exercises', () => {
    const exercise = { name: 'Remada', muscleGroupIds: [1] }

    it.each(['javascript:alert(1)', 'data:text/html,x', 'ftp://v.test/a'])('POST refuses the video link %s', async (videoUrl) => {
      await expectRefused('POST', '/api/exercises', 'trainerA', { ...exercise, videoUrl }, 'videoUrl')
    })

    it('GET /:id/progress refuses a malformed clientId', async () => {
      await expectRefused('GET', `/api/exercises/${ids.exercise}/progress?clientId=abc`, 'trainerA', undefined, 'clientId')
    })
  })

  describe('workouts and their children', () => {
    it('a workout name that is blank is a 400', async () => {
      await expectRefused('POST', `/api/training-plans/${ids.planA}/workouts`, 'trainerA', { name: '   ', dayOfWeek: 'MONDAY' }, 'name')
    })

    it('21 exercises or 11 sets are a 400 before any upstream call', async () => {
      const entry = (sets: unknown[] = []) => ({ exerciseId: 1, sets })
      await expectRefused(
        'POST',
        `/api/training-plans/${ids.planA}/workouts`,
        'trainerA',
        { name: 'A', dayOfWeek: 'MONDAY', exercises: Array.from({ length: 21 }, () => entry()) },
        'exercises',
      )
      await expectRefused(
        'PUT',
        `/api/workouts/${ids.workoutA}/exercises`,
        'trainerA',
        { exercises: [entry(Array.from({ length: 11 }, () => ({ reps: 8 })))] },
        'exercises',
      )
    })

    it('a nested set with a 5-digit weight is a 400', async () => {
      await expectRefused('PUT', `/api/workouts/${ids.workoutA}/exercises`, 'trainerA', { exercises: [{ exerciseId: 1, sets: [{ weight: '10000' }] }] }, 'exercises')
    })

    it('POST /workouts/:id/exercises refuses order 0 and over-long notes', async () => {
      await expectRefused('POST', `/api/workouts/${ids.workoutA}/exercises`, 'trainerA', { exerciseId: 1, order: 0 }, 'order')
      await expectRefused('POST', `/api/workouts/${ids.workoutA}/exercises`, 'trainerA', { exerciseId: 1, order: 1, notes: 'n'.repeat(256) }, 'notes')
    })

    it('PATCH /workout-exercises/:id refuses order 0', async () => {
      await expectRefused('PATCH', `/api/workout-exercises/${ids.workoutExerciseA}`, 'trainerA', { order: 0 }, 'order')
    })

    it('POST /workout-exercises/:id/sets refuses an out-of-range set', async () => {
      const set = { setNumber: 1, strategy: 'STRAIGHT' }
      await expectRefused('POST', `/api/workout-exercises/${ids.workoutExerciseA}/sets`, 'trainerA', { ...set, reps: 1001 }, 'reps')
      await expectRefused('POST', `/api/workout-exercises/${ids.workoutExerciseA}/sets`, 'trainerA', { ...set, loadPercentage: '1000' }, 'loadPercentage')
      await expectRefused('POST', `/api/workout-exercises/${ids.workoutExerciseA}/sets`, 'trainerA', { ...set, notes: 'n'.repeat(256) }, 'notes')
    })

    it('GET /workouts refuses anything but ?recent=true', async () => {
      await expectRefused('GET', '/api/workouts?recent=yes', 'trainerA')
    })
  })

  describe('workout sessions and logs', () => {
    it('refuses a set log with a bad weight or too many reps', async () => {
      await expectRefused('POST', `/api/workout-sessions/${ids.workoutLogA}/sets`, 'clientA', { exerciseSetId: ids.exerciseSetA, weight: '1.234', reps: 5 }, 'weight')
      await expectRefused('POST', `/api/workout-sessions/${ids.workoutLogA}/sets`, 'clientA', { exerciseSetId: ids.exerciseSetA, weight: '20', reps: 1001 }, 'reps')
    })

    it.each([`/api/workouts/${ids.workoutA}/session`, `/api/workout-logs?trainingPlanId=${ids.planA}&clientId=${ids.clientA}`])(
      'GET %s parses weekStartDate with Zod',
      async (base) => {
        const sep = base.includes('?') ? '&' : '?'
        await expectRefused('GET', `${base}${sep}weekStartDate=2026-13-45`, 'trainerA', undefined, 'weekStartDate')
        await expectRefused('GET', `${base}${sep}weekStartDate=yesterday`, 'trainerA', undefined, 'weekStartDate')
      },
    )

    it('GET /workout-logs refuses a malformed trainingPlanId and clientId', async () => {
      await expectRefused('GET', `/api/workout-logs?clientId=${ids.clientA}&trainingPlanId=x`, 'trainerA', undefined, 'trainingPlanId')
      await expectRefused('GET', `/api/workout-logs?trainingPlanId=${ids.planA}&clientId=-3`, 'trainerA', undefined, 'clientId')
    })

    it('GET /workout-logs still needs the ids a TRAINER names', async () => {
      await expectRefused('GET', `/api/workout-logs?trainingPlanId=${ids.planA}`, 'trainerA')
    })
  })
})
