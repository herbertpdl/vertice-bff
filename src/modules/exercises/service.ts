import { exerciseClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'

export interface MuscleGroup {
  id: number
  name: string
}

export interface Exercise {
  id: number
  name: string
  description: string
  videoUrl: string
  /** Upstream order: primary group first, then the others by id. */
  muscleGroups: MuscleGroup[]
  /** Part of the shared starter set (read-only for every trainer). */
  isStarter: boolean
}

interface MuscleGroupResponse {
  id: string
  name: string
}

interface ExerciseResponse {
  id: string
  name: string
  description: string
  videoUrl: string
  muscleGroups: MuscleGroupResponse[]
  isStarter: boolean
}

export function toMuscleGroup(r: MuscleGroupResponse): MuscleGroup {
  return { id: Number(r.id), name: r.name }
}

export function toExercise(r: ExerciseResponse): Exercise {
  return {
    id: Number(r.id),
    name: r.name,
    description: r.description,
    videoUrl: r.videoUrl,
    muscleGroups: (r.muscleGroups ?? []).map(toMuscleGroup),
    isStarter: r.isStarter,
  }
}

export async function listMuscleGroups(): Promise<MuscleGroup[]> {
  const res = await grpcCall<object, { muscleGroups: MuscleGroupResponse[] }>(
    exerciseClient,
    'ListMuscleGroups',
    {},
  )
  return res.muscleGroups.map(toMuscleGroup)
}

export interface ExercisePage {
  exercises: Exercise[]
  /** Pass back as `cursor` for the next page; `null` on the last one. */
  nextCursor: string | null
}

export interface ExerciseListFilter {
  muscleGroupId?: number
  search?: string
  limit?: number
  cursor?: string
}

/**
 * One page, never the whole catalog. Upstream scopes the list to the caller (TRAINER: starter
 * set + own; ADMIN: starter set) and owns the ordering, search semantics and page bounds — the
 * page is returned as-is, never re-sorted or re-filtered here.
 */
export async function listExercises(filter: ExerciseListFilter = {}): Promise<ExercisePage> {
  const res = await grpcCall<
    { muscleGroupId: number; search: string; pageSize: number; pageToken: string },
    { exercises: ExerciseResponse[]; nextPageToken: string }
  >(exerciseClient, 'ListExercises', {
    muscleGroupId: filter.muscleGroupId ?? 0,
    search: filter.search ?? '',
    pageSize: filter.limit ?? 0,
    pageToken: filter.cursor ?? '',
  })
  return { exercises: res.exercises.map(toExercise), nextCursor: res.nextPageToken || null }
}

export async function getExercise(id: number): Promise<Exercise> {
  const res = await grpcCall<{ id: number }, ExerciseResponse>(exerciseClient, 'GetExercise', { id })
  return toExercise(res)
}

export interface ExerciseInput {
  name: string
  description: string
  videoUrl?: string
  muscleGroupIds: number[]
}

interface ExerciseRequest {
  name: string
  description: string
  videoUrl: string
  muscleGroupIds: number[]
}

function toExerciseRequest(input: ExerciseInput): ExerciseRequest {
  return {
    name: input.name,
    description: input.description,
    videoUrl: input.videoUrl ?? '',
    muscleGroupIds: input.muscleGroupIds,
  }
}

export async function createExercise(input: ExerciseInput): Promise<Exercise> {
  const res = await grpcCall<ExerciseRequest, ExerciseResponse>(
    exerciseClient,
    'CreateExercise',
    toExerciseRequest(input),
  )
  return toExercise(res)
}

export async function updateExercise(id: number, input: ExerciseInput): Promise<Exercise> {
  const res = await grpcCall<{ id: number; exercise: ExerciseRequest }, ExerciseResponse>(
    exerciseClient,
    'UpdateExercise',
    { id, exercise: toExerciseRequest(input) },
  )
  return toExercise(res)
}

export async function deleteExercise(id: number): Promise<void> {
  await grpcCall(exerciseClient, 'DeleteExercise', { id })
}
