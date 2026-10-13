import { beforeEach, describe, expect, it, vi } from 'vitest'
import { grpcCall } from '../grpc/call.js'
import { ForbiddenError } from './errors.js'
import type { AuthUser } from './jwt.js'
import { requestContext } from './request-context.js'
import { assertCanUseExercises, assertExerciseSetInWorkout, assertOwnsWorkoutLog } from './ownership.js'
import { bearer, fakeGrpcCall, ids, userOf, type Actor } from '../test/fakeUpstream.js'

vi.mock('../grpc/call.js', () => ({ grpcCall: vi.fn() }))
const grpcCallMock = vi.mocked(grpcCall)

const user = (actor: Actor): AuthUser => ({ ...userOf(actor), email: `user${userOf(actor).id}@vertice.test` })

/** Runs `fn` the way a request would: with the caller's verified token in the request context. */
const asCaller = <T>(actor: Actor, fn: () => Promise<T>) =>
  requestContext.run({ bearerToken: bearer(actor).authorization.slice('Bearer '.length) }, fn)

const upstreamMethods = () => grpcCallMock.mock.calls.map(([, method]) => method)

beforeEach(() => {
  grpcCallMock.mockReset()
  grpcCallMock.mockImplementation(fakeGrpcCall)
})

describe('assertOwnsWorkoutLog', () => {
  it("lets a TRAINER through on a log under their own plan and returns the log", async () => {
    const log = await assertOwnsWorkoutLog(user('trainerA'), ids.workoutLogA)
    expect(log).toMatchObject({ id: ids.workoutLogA, workoutId: ids.workoutA, clientId: ids.clientA })
    expect(upstreamMethods()).toEqual(['GetWorkoutLog', 'GetWorkout', 'GetTrainingPlan'])
  })

  it("refuses a TRAINER on a log under another trainer's plan", async () => {
    await expect(assertOwnsWorkoutLog(user('trainerA'), ids.workoutLogB)).rejects.toThrow(ForbiddenError)
    await expect(assertOwnsWorkoutLog(user('trainerB'), ids.workoutLogA)).rejects.toThrow(ForbiddenError)
  })

  it("decides a CLIENT on the log's clientId alone", async () => {
    await expect(assertOwnsWorkoutLog(user('clientA'), ids.workoutLogA)).resolves.toMatchObject({ id: ids.workoutLogA })
    await expect(assertOwnsWorkoutLog(user('clientA'), ids.workoutLogB)).rejects.toThrow(ForbiddenError)
    expect(upstreamMethods().every((m) => m === 'GetWorkoutLog')).toBe(true)
  })

  it('lets an ADMIN through on any log', async () => {
    await expect(assertOwnsWorkoutLog(user('admin'), ids.workoutLogB)).resolves.toMatchObject({ id: ids.workoutLogB })
  })
})

describe('assertExerciseSetInWorkout', () => {
  it('answers a refused set lookup with the same 400 as a missing or foreign one', async () => {
    const expected = { statusCode: 400, message: 'exerciseSetId does not belong to this workout log' }
    grpcCallMock.mockImplementationOnce(async () => {
      throw new ForbiddenError('You do not have access to exercise set 400')
    })
    await expect(assertExerciseSetInWorkout(ids.exerciseSetA, ids.workoutA)).rejects.toMatchObject(expected)
    await expect(assertExerciseSetInWorkout(9999, ids.workoutA)).rejects.toMatchObject(expected)
    await expect(assertExerciseSetInWorkout(ids.exerciseSetB, ids.workoutA)).rejects.toMatchObject(expected)
    await expect(assertExerciseSetInWorkout(ids.exerciseSetA, ids.workoutA)).resolves.toBeUndefined()
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

  it('skips the lookup for an ADMIN', async () => {
    await asCaller('admin', () => assertCanUseExercises(user('admin'), [ids.privateExerciseB]))
    expect(grpcCallMock).not.toHaveBeenCalled()
  })
})
