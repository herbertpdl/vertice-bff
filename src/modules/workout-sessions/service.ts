import { workoutSessionClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'
import * as workoutService from '../workouts/service.js'

export interface WorkoutLog {
  id: number
  workoutId: number
  clientId: number
  weekStartDate: string
  startedAt: string
  completedAt: string
}

interface WorkoutLogResponse {
  id: string
  workoutId: string
  clientId: string
  weekStartDate: string
  startedAt: string
  completedAt: string
}

function toWorkoutLog(r: WorkoutLogResponse): WorkoutLog {
  return {
    id: Number(r.id),
    workoutId: Number(r.workoutId),
    clientId: Number(r.clientId),
    weekStartDate: r.weekStartDate,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
  }
}

export interface SetLog {
  id: number
  workoutLogId: number
  exerciseSetId: number
  weight: string
  reps: number
  recordedAt: string
}

interface SetLogResponse {
  id: string
  workoutLogId: string
  exerciseSetId: string
  weight: string
  reps: number
  recordedAt: string
}

function toSetLog(r: SetLogResponse): SetLog {
  return {
    id: Number(r.id),
    workoutLogId: Number(r.workoutLogId),
    exerciseSetId: Number(r.exerciseSetId),
    weight: r.weight,
    reps: r.reps,
    recordedAt: r.recordedAt,
  }
}

export async function getOrStartWorkoutLog(
  workoutId: number,
  clientId: number,
  weekStartDate: string,
): Promise<WorkoutLog> {
  const res = await grpcCall<{ workoutId: number; clientId: number; weekStartDate: string }, WorkoutLogResponse>(
    workoutSessionClient,
    'GetOrStartWorkoutLog',
    { workoutId, clientId, weekStartDate },
  )
  return toWorkoutLog(res)
}

export async function recordSetLog(
  workoutLogId: number,
  exerciseSetId: number,
  weight: string,
  reps: number,
): Promise<SetLog> {
  const res = await grpcCall<
    { workoutLogId: number; exerciseSetId: number; weight: string; reps: number },
    SetLogResponse
  >(workoutSessionClient, 'RecordSetLog', { workoutLogId, exerciseSetId, weight, reps })
  return toSetLog(res)
}

export async function completeWorkoutLog(id: number): Promise<WorkoutLog> {
  const res = await grpcCall<{ id: number }, WorkoutLogResponse>(
    workoutSessionClient,
    'CompleteWorkoutLog',
    { id },
  )
  return toWorkoutLog(res)
}

/** vertice-api requires both trainingPlanId and weekStartDate on this RPC — it's scoped to one plan's one week, not a general listing. */
export async function listWorkoutLogs(filter: {
  clientId: number
  trainingPlanId: number
  weekStartDate: string
}): Promise<WorkoutLog[]> {
  const res = await grpcCall<
    { clientId: number; trainingPlanId: number; weekStartDate: string },
    { workoutLogs: WorkoutLogResponse[] }
  >(workoutSessionClient, 'ListWorkoutLogs', filter)
  return res.workoutLogs.map(toWorkoutLog)
}

export async function getLastSetLogs(clientId: number, workoutId: number): Promise<SetLog[]> {
  const res = await grpcCall<{ clientId: number; workoutId: number }, { setLogs: SetLogResponse[] }>(
    workoutSessionClient,
    'GetLastSetLogs',
    { clientId, workoutId },
  )
  return res.setLogs.map(toSetLog)
}

export interface ProgressPoint {
  weekStartDate: string
  weight: number
}

export async function getExerciseProgress(exerciseId: number, clientId: number): Promise<ProgressPoint[]> {
  const res = await grpcCall<
    { clientId: number; exerciseId: number },
    { points: { weekStartDate: string; weight: string }[] }
  >(workoutSessionClient, 'GetExerciseProgress', { clientId, exerciseId })
  return res.points.map((p) => ({ weekStartDate: p.weekStartDate, weight: Number(p.weight) }))
}

/**
 * Single-call aggregate for the client's "do workout" screen: the full
 * workout structure (exercises + sets + video), an in-progress or freshly
 * started log for this week, and the weights/reps recorded last time this
 * workout was performed — so the frontend can pre-fill "last time you did
 * 60kg" without orchestrating four separate requests.
 */
export async function getWorkoutSession(workoutId: number, clientId: number, weekStartDate: string) {
  const [workout, workoutLog, lastSetLogs] = await Promise.all([
    workoutService.getFullWorkout(workoutId),
    getOrStartWorkoutLog(workoutId, clientId, weekStartDate),
    getLastSetLogs(clientId, workoutId),
  ])

  const lastByExerciseSetId = new Map(lastSetLogs.map((log) => [log.exerciseSetId, log]))

  const exercises = workout.exercises.map((we) => ({
    ...we,
    sets: we.sets.map((set) => ({ ...set, lastPerformed: lastByExerciseSetId.get(set.id) ?? null })),
  }))

  return { ...workout, exercises, workoutLog }
}
