import { ForbiddenError } from './errors.js'
import type { AuthUser } from './jwt.js'
import * as planService from '../modules/training-plans/service.js'
import * as workoutService from '../modules/workouts/service.js'
import * as workoutExerciseService from '../modules/workout-exercises/service.js'
import type { TrainingPlan } from '../modules/training-plans/service.js'

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
