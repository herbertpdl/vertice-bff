import { workoutExerciseClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'

export interface WorkoutExercise {
  id: number
  workoutId: number
  exerciseId: number
  order: number
  restSecondsBetweenSets: number
  notes: string
}

interface WorkoutExerciseResponse {
  id: string
  workoutId: string
  exerciseId: string
  order: number
  restSecondsBetweenSets: number
  notes: string
}

function toWorkoutExercise(r: WorkoutExerciseResponse): WorkoutExercise {
  return {
    id: Number(r.id),
    workoutId: Number(r.workoutId),
    exerciseId: Number(r.exerciseId),
    order: r.order,
    restSecondsBetweenSets: r.restSecondsBetweenSets,
    notes: r.notes,
  }
}

export async function listWorkoutExercises(workoutId: number): Promise<WorkoutExercise[]> {
  const res = await grpcCall<{ workoutId: number }, { workoutExercises: WorkoutExerciseResponse[] }>(
    workoutExerciseClient,
    'ListWorkoutExercises',
    { workoutId },
  )
  return res.workoutExercises.map(toWorkoutExercise)
}

export async function getWorkoutExercise(id: number): Promise<WorkoutExercise> {
  const res = await grpcCall<{ id: number }, WorkoutExerciseResponse>(
    workoutExerciseClient,
    'GetWorkoutExercise',
    { id },
  )
  return toWorkoutExercise(res)
}

export interface WorkoutExerciseCreateInput {
  exerciseId: number
  order: number
  restSecondsBetweenSets: number
  notes?: string
}

export async function createWorkoutExercise(
  workoutId: number,
  input: WorkoutExerciseCreateInput,
): Promise<WorkoutExercise> {
  const res = await grpcCall<WorkoutExerciseCreateInput & { workoutId: number }, WorkoutExerciseResponse>(
    workoutExerciseClient,
    'CreateWorkoutExercise',
    { ...input, notes: input.notes ?? '', workoutId },
  )
  return toWorkoutExercise(res)
}

export interface WorkoutExerciseUpdateInput {
  order: number
  restSecondsBetweenSets: number
  notes?: string
}

export async function updateWorkoutExercise(
  id: number,
  input: WorkoutExerciseUpdateInput,
): Promise<WorkoutExercise> {
  const res = await grpcCall<
    { id: number; workoutExercise: WorkoutExerciseUpdateInput },
    WorkoutExerciseResponse
  >(workoutExerciseClient, 'UpdateWorkoutExercise', {
    id,
    workoutExercise: { ...input, notes: input.notes ?? '' },
  })
  return toWorkoutExercise(res)
}

export async function deleteWorkoutExercise(id: number): Promise<void> {
  await grpcCall(workoutExerciseClient, 'DeleteWorkoutExercise', { id })
}
