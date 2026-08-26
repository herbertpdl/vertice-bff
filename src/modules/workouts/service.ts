import { workoutClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'
import * as workoutExerciseService from '../workout-exercises/service.js'
import * as exerciseSetService from '../exercise-sets/service.js'
import * as exerciseService from '../exercises/service.js'
import * as planService from '../training-plans/service.js'
import * as userService from '../users/service.js'

export type DayOfWeek =
  | 'MONDAY'
  | 'TUESDAY'
  | 'WEDNESDAY'
  | 'THURSDAY'
  | 'FRIDAY'
  | 'SATURDAY'
  | 'SUNDAY'

export interface Workout {
  id: number
  name: string
  trainingPlanId: number
  dayOfWeek: DayOfWeek
}

interface WorkoutResponse {
  id: string
  name: string
  trainingPlanId: string
  dayOfWeek: DayOfWeek
}

function toWorkout(r: WorkoutResponse): Workout {
  return { id: Number(r.id), name: r.name, trainingPlanId: Number(r.trainingPlanId), dayOfWeek: r.dayOfWeek }
}

export async function listWorkouts(trainingPlanId: number): Promise<Workout[]> {
  const res = await grpcCall<{ trainingPlanId: number }, { workouts: WorkoutResponse[] }>(
    workoutClient,
    'ListWorkouts',
    { trainingPlanId },
  )
  return res.workouts.map(toWorkout)
}

export async function getWorkout(id: number): Promise<Workout> {
  const res = await grpcCall<{ id: number }, WorkoutResponse>(workoutClient, 'GetWorkout', { id })
  return toWorkout(res)
}

export interface WorkoutInput {
  name: string
  dayOfWeek: DayOfWeek
}

export async function createWorkout(trainingPlanId: number, input: WorkoutInput): Promise<Workout> {
  const res = await grpcCall<WorkoutInput & { trainingPlanId: number }, WorkoutResponse>(
    workoutClient,
    'CreateWorkout',
    { ...input, trainingPlanId },
  )
  return toWorkout(res)
}

export async function updateWorkout(id: number, input: WorkoutInput): Promise<Workout> {
  const res = await grpcCall<{ id: number; workout: WorkoutInput }, WorkoutResponse>(
    workoutClient,
    'UpdateWorkout',
    { id, workout: input },
  )
  return toWorkout(res)
}

export async function deleteWorkout(id: number): Promise<void> {
  await grpcCall(workoutClient, 'DeleteWorkout', { id })
}

export interface CloneWorkoutInput {
  targetTrainingPlanId: number
  name: string
  dayOfWeek: DayOfWeek
}

export async function cloneWorkout(sourceWorkoutId: number, input: CloneWorkoutInput): Promise<Workout> {
  const res = await grpcCall<CloneWorkoutInput & { sourceWorkoutId: number }, WorkoutResponse>(
    workoutClient,
    'CloneWorkout',
    { ...input, sourceWorkoutId },
  )
  return toWorkout(res)
}

export interface RecentWorkoutSummary extends Workout {
  studentName: string
  planName: string
  exerciseCount: number
}

/**
 * Lists a trainer's workouts across every plan/student, for the workout
 * builder's "use an existing workout as a base" clone picker — no single
 * vertice-api RPC does this (ListWorkouts is scoped to one plan), so it's
 * assembled here by iterating the trainer's plans.
 *
 * Simplifications:
 * - Sorted by workout id descending as a proxy for "most recent" — Workout
 *   has no createdAt/updatedAt field to sort on.
 * - `exerciseCount` costs one extra list call per workout (not a full
 *   getFullWorkout fetch, which would also pull every set) — acceptable for
 *   a trainer's roster size, but would need pagination/caching at scale.
 */
export async function listRecentWorkoutsForTrainer(trainerId: number): Promise<RecentWorkoutSummary[]> {
  const plans = await planService.listTrainingPlans({ trainerId })
  const plansById = new Map(plans.map((p) => [p.id, p]))

  const clientIds = [...new Set(plans.map((p) => p.clientId))]
  const [workoutsByPlan, clients] = await Promise.all([
    Promise.all(plans.map((p) => listWorkouts(p.id))),
    Promise.all(clientIds.map((id) => userService.getUser(id))),
  ])
  const clientsById = new Map(clients.map((c) => [c.id, c]))
  const workouts = workoutsByPlan.flat()

  const enriched = await Promise.all(
    workouts.map(async (workout) => {
      const plan = plansById.get(workout.trainingPlanId)!
      const exercises = await workoutExerciseService.listWorkoutExercises(workout.id)
      return {
        ...workout,
        studentName: clientsById.get(plan.clientId)?.name ?? 'Unknown',
        planName: plan.name,
        exerciseCount: exercises.length,
      }
    }),
  )

  return enriched.sort((a, b) => b.id - a.id)
}

function shapeWorkoutExercise(
  we: workoutExerciseService.WorkoutExercise,
  exercise: exerciseService.Exercise,
  sets: exerciseSetService.ExerciseSet[],
) {
  return { ...we, exercise, sets }
}

/**
 * Single-call aggregate for screens that render an entire workout at once
 * (the trainer's workout builder, the client's "do workout" view): avoids the
 * frontend orchestrating N+1 requests across workout-exercises, the exercise
 * catalog, and exercise-sets.
 */
export async function getFullWorkout(workoutId: number) {
  const workout = await getWorkout(workoutId)
  const workoutExercises = await workoutExerciseService.listWorkoutExercises(workoutId)

  const exercises = await Promise.all(
    workoutExercises.map(async (we) => {
      const [exercise, sets] = await Promise.all([
        exerciseService.getExercise(we.exerciseId),
        exerciseSetService.listExerciseSets(we.id),
      ])
      return shapeWorkoutExercise(we, exercise, sets.sort((a, b) => a.setNumber - b.setNumber))
    }),
  )

  exercises.sort((a, b) => a.order - b.order)

  return { ...workout, exercises }
}
