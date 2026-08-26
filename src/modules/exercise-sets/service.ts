import { exerciseSetClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'

export type SetStrategy =
  | 'STRAIGHT'
  | 'WARM_UP'
  | 'BACKOFF'
  | 'DROPSET'
  | 'REST_PAUSE'
  | 'CLUSTER'
  | 'AMRAP'
  | 'ISOMETRIC_HOLD'
  | 'FAILURE'

export interface ExerciseSet {
  id: number
  workoutExerciseId: number
  setNumber: number
  reps: number
  durationSeconds: number
  weight: string
  loadPercentage: string
  strategy: SetStrategy
  restSeconds: number
  notes: string
}

interface ExerciseSetResponse {
  id: string
  workoutExerciseId: string
  setNumber: number
  reps: number
  durationSeconds: number
  weight: string
  loadPercentage: string
  strategy: SetStrategy
  restSeconds: number
  notes: string
}

function toExerciseSet(r: ExerciseSetResponse): ExerciseSet {
  return {
    id: Number(r.id),
    workoutExerciseId: Number(r.workoutExerciseId),
    setNumber: r.setNumber,
    reps: r.reps,
    durationSeconds: r.durationSeconds,
    weight: r.weight,
    loadPercentage: r.loadPercentage,
    strategy: r.strategy,
    restSeconds: r.restSeconds,
    notes: r.notes,
  }
}

export async function getExerciseSet(id: number): Promise<ExerciseSet> {
  const res = await grpcCall<{ id: number }, ExerciseSetResponse>(exerciseSetClient, 'GetExerciseSet', {
    id,
  })
  return toExerciseSet(res)
}

export async function listExerciseSets(workoutExerciseId: number): Promise<ExerciseSet[]> {
  const res = await grpcCall<{ workoutExerciseId: number }, { exerciseSets: ExerciseSetResponse[] }>(
    exerciseSetClient,
    'ListExerciseSets',
    { workoutExerciseId },
  )
  return res.exerciseSets.map(toExerciseSet)
}

export interface ExerciseSetInput {
  setNumber: number
  reps?: number
  durationSeconds?: number
  weight?: string
  loadPercentage?: string
  strategy: SetStrategy
  restSeconds?: number
  notes?: string
}

function withDefaults(input: ExerciseSetInput) {
  return {
    setNumber: input.setNumber,
    reps: input.reps ?? 0,
    durationSeconds: input.durationSeconds ?? 0,
    weight: input.weight ?? '',
    loadPercentage: input.loadPercentage ?? '',
    strategy: input.strategy,
    restSeconds: input.restSeconds ?? 0,
    notes: input.notes ?? '',
  }
}

export async function createExerciseSet(
  workoutExerciseId: number,
  input: ExerciseSetInput,
): Promise<ExerciseSet> {
  const res = await grpcCall<ReturnType<typeof withDefaults> & { workoutExerciseId: number }, ExerciseSetResponse>(
    exerciseSetClient,
    'CreateExerciseSet',
    { ...withDefaults(input), workoutExerciseId },
  )
  return toExerciseSet(res)
}

export async function updateExerciseSet(id: number, input: ExerciseSetInput): Promise<ExerciseSet> {
  const res = await grpcCall<{ id: number; exerciseSet: ReturnType<typeof withDefaults> }, ExerciseSetResponse>(
    exerciseSetClient,
    'UpdateExerciseSet',
    { id, exerciseSet: withDefaults(input) },
  )
  return toExerciseSet(res)
}

export async function deleteExerciseSet(id: number): Promise<void> {
  await grpcCall(exerciseSetClient, 'DeleteExerciseSet', { id })
}
