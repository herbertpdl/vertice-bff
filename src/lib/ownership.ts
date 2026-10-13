import { ForbiddenError, NotFoundError, ValidationError } from './errors.js'
import type { AuthUser } from './jwt.js'
import * as planService from '../modules/training-plans/service.js'
import * as workoutService from '../modules/workouts/service.js'
import * as workoutExerciseService from '../modules/workout-exercises/service.js'
import * as exerciseSetService from '../modules/exercise-sets/service.js'
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
 * set is missing, sits in another of the caller's workouts or in someone else's,
 * so the response never tells those apart. vertice-api enforces the same rule
 * (FAILED_PRECONDITION); this check only gives the client a clean error first.
 */
export async function assertExerciseSetInWorkout(exerciseSetId: number, workoutId: number): Promise<void> {
  const invalid = () => new ValidationError('exerciseSetId does not belong to this workout log')
  try {
    const set = await exerciseSetService.getExerciseSet(exerciseSetId)
    const we = await workoutExerciseService.getWorkoutExercise(set.workoutExerciseId)
    if (we.workoutId !== workoutId) throw invalid()
  } catch (err) {
    if (err instanceof NotFoundError) throw invalid()
    throw err
  }
}
