import { ForbiddenError, HttpError, ValidationError } from './errors.js'
import type { AuthUser } from './jwt.js'
import * as planService from '../modules/training-plans/service.js'
import * as workoutService from '../modules/workouts/service.js'
import * as workoutExerciseService from '../modules/workout-exercises/service.js'
import * as exerciseSetService from '../modules/exercise-sets/service.js'
import * as exerciseService from '../modules/exercises/service.js'
import * as sessionService from '../modules/workout-sessions/service.js'
import type { TrainingPlan } from '../modules/training-plans/service.js'
import type { WorkoutLog } from '../modules/workout-sessions/service.js'

export function assertOwnsPlan(user: AuthUser, plan: TrainingPlan): void {
  const owns =
    (user.role === 'TRAINER' && plan.trainerId === user.id) ||
    (user.role === 'CLIENT' && plan.clientId === user.id) ||
    user.role === 'ADMIN'
  if (!owns) throw new ForbiddenError('You do not have access to this training plan')
}

/** Used next to `assertOwnsPlan` when a route also names the client: the plan must be that client's. */
export function assertPlanBelongsToClient(plan: TrainingPlan, clientId: number): void {
  if (plan.clientId !== clientId) throw new ForbiddenError('That training plan does not belong to this client')
}

export async function assertOwnsWorkout(user: AuthUser, workoutId: number): Promise<TrainingPlan> {
  const workout = await workoutService.getWorkout(workoutId)
  const plan = await planService.getTrainingPlan(workout.trainingPlanId)
  assertOwnsPlan(user, plan)
  return plan
}

export async function assertOwnsWorkoutExercise(user: AuthUser, workoutExerciseId: number): Promise<void> {
  const we = await workoutExerciseService.getWorkoutExercise(workoutExerciseId)
  await assertOwnsWorkout(user, we.workoutId)
}

/**
 * A CLIENT must be the log's own client. Anyone else goes through the plan of
 * the log's workout (TRAINER must own it, ADMIN bypasses), like `assertOwnsWorkout`.
 */
export async function assertOwnsWorkoutLog(user: AuthUser, workoutLogId: number): Promise<WorkoutLog> {
  const log = await sessionService.getWorkoutLog(workoutLogId)
  if (user.role === 'CLIENT') {
    if (log.clientId !== user.id) throw new ForbiddenError('You do not have access to this workout log')
    return log
  }
  await assertOwnsWorkout(user, log.workoutId)
  return log
}

/**
 * The set must be one of the workout's own sets. Answered with 400 whether the
 * set is missing, refused upstream, sits in another of the caller's workouts or
 * in someone else's, so the response never tells those apart. vertice-api
 * enforces the same rule (FAILED_PRECONDITION); this check only gives the client
 * a clean error first.
 */
export async function assertExerciseSetInWorkout(exerciseSetId: number, workoutId: number): Promise<void> {
  const message = 'exerciseSetId does not belong to this workout log'
  const we = await withoutExistenceOracle(message, async () => {
    const set = await exerciseSetService.getExerciseSet(exerciseSetId)
    return workoutExerciseService.getWorkoutExercise(set.workoutExerciseId)
  })
  if (we.workoutId !== workoutId) throw new ValidationError(message)
}

/**
 * Every exercise a TRAINER puts into a workout must be visible to them (the
 * shared starter set or their own). Each distinct id is looked up through
 * `GetExercise` with the caller's forwarded token, so vertice-api applies its
 * own visibility rule. vertice-api's workout-exercise writes do not check it
 * yet, so this is the only guard until they do. Missing and not-visible get the
 * same 400 (like `assertExerciseSetInWorkout`), so the answer is no existence
 * oracle for other trainers' private exercises. ADMIN skips the check.
 */
export async function assertCanUseExercises(user: AuthUser, exerciseIds: number[]): Promise<void> {
  if (user.role !== 'TRAINER') return
  await Promise.all(
    [...new Set(exerciseIds)].map((id) =>
      withoutExistenceOracle(`exerciseId ${id} is not available to you`, () => exerciseService.getExercise(id)),
    ),
  )
}

/**
 * Runs an upstream lookup and answers both "not found" (404) and "not yours"
 * (403) with the same 400 `message`, so a caller cannot probe which ids exist.
 * Matches on the status code, not the class, so it holds for every HttpError
 * `mapGrpcError` can build. Anything else (e.g. 503) passes through.
 */
async function withoutExistenceOracle<T>(message: string, lookup: () => Promise<T>): Promise<T> {
  try {
    return await lookup()
  } catch (err) {
    if (err instanceof HttpError && (err.statusCode === 403 || err.statusCode === 404)) {
      throw new ValidationError(message)
    }
    throw err
  }
}
