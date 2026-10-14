import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as grpc from '@grpc/grpc-js'
import { grpcCall, mapGrpcError } from '../grpc/call.js'
import { ForbiddenError } from './errors.js'
import type { AuthUser } from './jwt.js'
import { requestContext } from './request-context.js'
import { assertCanUseExercises, assertExerciseSetInWorkout, assertOwnsWorkoutLog } from './ownership.js'
import { bearer, fakeGrpcCall, ids, userOf, type Actor } from '../test/fakeUpstream.js'

// Keep the real mapGrpcError: the fake upstream raises its errors through it.
vi.mock('../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

const user = (actor: Actor): AuthUser => ({ id: userOf(actor).id, role: userOf(actor).role })

/** Runs `fn` the way a request would: with the caller's verified token in the request context. */
const asCaller = <T>(actor: Actor, fn: () => Promise<T>) =>
  requestContext.run({ bearerToken: bearer(actor).authorization.slice('Bearer '.length) }, fn)

/** `assertOwnsWorkoutLog` as `actor`, inside that actor's request context. */
const ownsLog = (actor: Actor, workoutLogId: number) =>
  asCaller(actor, () => assertOwnsWorkoutLog(user(actor), workoutLogId))

const upstreamMethods = () => grpcCallMock.mock.calls.map(([, method]) => method)

beforeEach(() => {
  grpcCallMock.mockReset()
  grpcCallMock.mockImplementation(fakeGrpcCall)
})

describe('assertOwnsWorkoutLog', () => {
  it("lets a TRAINER through on a log under their own plan and returns the log", async () => {
    const log = await ownsLog('trainerA', ids.workoutLogA)
    expect(log).toMatchObject({ id: ids.workoutLogA, workoutId: ids.workoutA, clientId: ids.clientA })
    expect(upstreamMethods()).toEqual(['GetWorkoutLog', 'GetWorkout', 'GetTrainingPlan'])
  })

  it("refuses a TRAINER on a log under another trainer's plan", async () => {
    await expect(ownsLog('trainerA', ids.workoutLogB)).rejects.toThrow(ForbiddenError)
    await expect(ownsLog('trainerB', ids.workoutLogA)).rejects.toThrow(ForbiddenError)
  })

  it("decides a CLIENT on the log's clientId alone", async () => {
    await expect(ownsLog('clientA', ids.workoutLogA)).resolves.toMatchObject({ id: ids.workoutLogA })
    await expect(ownsLog('clientA', ids.workoutLogB)).rejects.toThrow(ForbiddenError)
    expect(upstreamMethods().every((m) => m === 'GetWorkoutLog')).toBe(true)
  })

  it('lets an ADMIN through on any log', async () => {
    await expect(ownsLog('admin', ids.workoutLogB)).resolves.toMatchObject({ id: ids.workoutLogB })
  })
})

describe('assertExerciseSetInWorkout', () => {
  it('answers a refused set lookup with the same 400 as a missing or foreign one', async () => {
    const expected = { statusCode: 400, message: 'exerciseSetId does not belong to this workout log' }
    const inWorkoutA = (exerciseSetId: number) =>
      asCaller('trainerA', () => assertExerciseSetInWorkout(exerciseSetId, ids.workoutA))
    grpcCallMock.mockImplementationOnce(async () => {
      throw mapGrpcError({ code: grpc.status.PERMISSION_DENIED, details: 'You do not have access to exercise set 400' })
    })
    await expect(inWorkoutA(ids.exerciseSetA)).rejects.toMatchObject(expected)
    await expect(inWorkoutA(9999)).rejects.toMatchObject(expected)
    await expect(inWorkoutA(ids.exerciseSetB)).rejects.toMatchObject(expected)
    await expect(inWorkoutA(ids.exerciseSetA)).resolves.toBeUndefined()
  })
})

describe('assertCanUseExercises', () => {
  it('lets a TRAINER use the starter set and their own private exercises, looking each id up once', async () => {
    await asCaller('trainerB', () =>
      assertCanUseExercises(user('trainerB'), [ids.exercise, ids.privateExerciseB, ids.exercise]),
    )
    expect(upstreamMethods()).toEqual(['GetExercise', 'GetExercise'])
  })

  it("answers another trainer's private exercise and a missing one with the same 400", async () => {
    const run = (exerciseId: number) =>
      asCaller('trainerA', () => assertCanUseExercises(user('trainerA'), [ids.exercise, exerciseId]))
    await expect(run(ids.privateExerciseB)).rejects.toMatchObject({
      statusCode: 400,
      message: `exerciseId ${ids.privateExerciseB} is not available to you`,
    })
    await expect(run(9999)).rejects.toMatchObject({ statusCode: 400, message: 'exerciseId 9999 is not available to you' })
  })

  it('turns a real upstream PERMISSION_DENIED, mapped by mapGrpcError, into the same 400 as NOT_FOUND', async () => {
    const answers: unknown[] = []
    for (const code of [grpc.status.PERMISSION_DENIED, grpc.status.NOT_FOUND]) {
      grpcCallMock.mockImplementationOnce(async () => {
        throw mapGrpcError({ code, details: 'You do not have access to exercise 7' })
      })
      answers.push(
        await asCaller('trainerA', () => assertCanUseExercises(user('trainerA'), [7])).catch((err: unknown) => err),
      )
    }
    for (const err of answers) {
      expect(err).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'exerciseId 7 is not available to you' })
    }
  })

  it('lets an upstream outage through instead of hiding it as a 400', async () => {
    grpcCallMock.mockImplementationOnce(async () => {
      throw mapGrpcError({ code: grpc.status.UNAVAILABLE, details: '' })
    })
    await expect(
      asCaller('trainerA', () => assertCanUseExercises(user('trainerA'), [ids.exercise])),
    ).rejects.toMatchObject({ statusCode: 503 })
  })

  it('skips the lookup for an ADMIN', async () => {
    await asCaller('admin', () => assertCanUseExercises(user('admin'), [ids.privateExerciseB]))
    expect(grpcCallMock).not.toHaveBeenCalled()
  })
})
