import { exerciseClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'

export interface Exercise {
  id: number
  name: string
  description: string
  videoUrl: string
}

interface ExerciseResponse {
  id: string
  name: string
  description: string
  videoUrl: string
}

function toExercise(r: ExerciseResponse): Exercise {
  return { id: Number(r.id), name: r.name, description: r.description, videoUrl: r.videoUrl }
}

export async function listExercises(): Promise<Exercise[]> {
  const res = await grpcCall<object, { exercises: ExerciseResponse[] }>(
    exerciseClient,
    'ListExercises',
    {},
  )
  return res.exercises.map(toExercise)
}

export async function getExercise(id: number): Promise<Exercise> {
  const res = await grpcCall<{ id: number }, ExerciseResponse>(exerciseClient, 'GetExercise', { id })
  return toExercise(res)
}

export interface ExerciseInput {
  name: string
  description: string
  videoUrl?: string
}

export async function createExercise(input: ExerciseInput): Promise<Exercise> {
  const res = await grpcCall<ExerciseInput, ExerciseResponse>(exerciseClient, 'CreateExercise', {
    name: input.name,
    description: input.description,
    videoUrl: input.videoUrl ?? '',
  })
  return toExercise(res)
}

export async function updateExercise(id: number, input: ExerciseInput): Promise<Exercise> {
  const res = await grpcCall<{ id: number; exercise: ExerciseInput }, ExerciseResponse>(
    exerciseClient,
    'UpdateExercise',
    { id, exercise: { name: input.name, description: input.description, videoUrl: input.videoUrl ?? '' } },
  )
  return toExercise(res)
}

export async function deleteExercise(id: number): Promise<void> {
  await grpcCall(exerciseClient, 'DeleteExercise', { id })
}
