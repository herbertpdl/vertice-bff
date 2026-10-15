import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { status } from '@grpc/grpc-js'
import { buildApp } from '../app.js'
import { grpcCall, mapGrpcError, UPSTREAM_MESSAGES } from '../grpc/call.js'
import { bearer, fakeGrpcCall, ids } from './fakeUpstream.js'

// Keep the real mapGrpcError: the fake upstream raises its errors through it.
vi.mock('../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

/**
 * vertice-api refuses a delete that would remove a client's history (a workout log, a set log,
 * feedback) with FAILED_PRECONDITION (`HasRecordedDataException`, P1-05). The trainer's delete
 * routes must answer it as 409 `PRECONDITION_FAILED`, so the web can say "this has recorded
 * training and can't be deleted" rather than "fix the form" or "server error", and with the
 * BFF's fixed message: vertice-api's text names ids.
 */
const refusals: [url: string, rpc: string, upstream: string][] = [
  [`/api/training-plans/${ids.planA}`, 'DeleteTrainingPlan', `Training plan ${ids.planA} has workout logs and cannot be deleted`],
  [`/api/workouts/${ids.workoutA}`, 'DeleteWorkout', `Workout ${ids.workoutA} has workout logs and cannot be deleted`],
  [
    `/api/workout-exercises/${ids.workoutExerciseA}`,
    'DeleteWorkoutExercise',
    `Workout exercise ${ids.workoutExerciseA} has set logs and cannot be deleted`,
  ],
  [`/api/exercise-sets/${ids.exerciseSetA}`, 'DeleteExerciseSet', `Exercise set ${ids.exerciseSetA} has set logs and cannot be deleted`],
]
const cases = refusals.map(([url, rpc, upstream]) => ({ url, rpc, upstream }))

describe('deletes over recorded data', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(() => app.close())

  beforeEach(() => {
    grpcCallMock.mockReset()
    grpcCallMock.mockImplementation(async (client, method, request, options) => {
      const refused = cases.find((c) => c.rpc === method)
      if (refused) throw mapGrpcError({ code: status.FAILED_PRECONDITION, details: refused.upstream })
      return fakeGrpcCall(client, method, request, options)
    })
  })

  it.each(cases)('DELETE $url: $rpc refused upstream is 409 PRECONDITION_FAILED', async ({ url, rpc }) => {
    const res = await app.inject({ method: 'DELETE', url, headers: bearer('trainerA') })
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json()).toEqual({ error: { code: 'PRECONDITION_FAILED', message: UPSTREAM_MESSAGES.preconditionFailed } })
    expect(grpcCallMock.mock.calls.map(([, method]) => method)).toContain(rpc)
  })
})
