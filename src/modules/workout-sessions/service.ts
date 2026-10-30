import { workoutSessionClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'
import * as workoutService from '../workouts/service.js'

export type WorkoutLogStatus = 'IN_PROGRESS' | 'COMPLETED' | 'SUPERSEDED'
export type CompletionKind = 'CLIENT' | 'AUTO' | ''

export interface WorkoutLog {
  id: number
  workoutId: number
  clientId: number
  weekStartDate: string
  startedAt: string
  completedAt: string
  status: WorkoutLogStatus
  completionKind: CompletionKind
}

interface WorkoutLogResponse {
  id: string
  workoutId: string
  clientId: string
  weekStartDate: string
  startedAt: string
  completedAt: string
  /** `WORKOUT_LOG_STATUS_*` (proto enum as a string). */
  status: string
  /** `COMPLETION_KIND_*`. */
  completionKind: string
}

/**
 * The status without its proto prefix. A log from an API that predates statuses says
 * `UNSPECIFIED`: read it from `completedAt`, as those logs were.
 */
function toStatus(r: WorkoutLogResponse): WorkoutLogStatus {
  const status = r.status?.replace(/^WORKOUT_LOG_STATUS_/, '')
  if (status === 'IN_PROGRESS' || status === 'COMPLETED' || status === 'SUPERSEDED') return status
  return r.completedAt ? 'COMPLETED' : 'IN_PROGRESS'
}

function toCompletionKind(r: WorkoutLogResponse): CompletionKind {
  const kind = r.completionKind?.replace(/^COMPLETION_KIND_/, '')
  return kind === 'CLIENT' || kind === 'AUTO' ? kind : ''
}

function toWorkoutLog(r: WorkoutLogResponse): WorkoutLog {
  return {
    id: Number(r.id),
    workoutId: Number(r.workoutId),
    clientId: Number(r.clientId),
    weekStartDate: r.weekStartDate,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    status: toStatus(r),
    completionKind: toCompletionKind(r),
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

/** One log by id (404 when missing), so routes can check who owns it before writing into it. */
export async function getWorkoutLog(id: number): Promise<WorkoutLog> {
  const res = await grpcCall<{ id: number }, WorkoutLogResponse>(workoutSessionClient, 'GetWorkoutLog', { id })
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

/** A redo next to the week's completed session (or the one already in progress). */
export async function restartWorkoutLog(
  workoutId: number,
  clientId: number,
  weekStartDate: string,
): Promise<WorkoutLog> {
  const res = await grpcCall<{ workoutId: number; clientId: number; weekStartDate: string }, WorkoutLogResponse>(
    workoutSessionClient,
    'RestartWorkoutLog',
    { workoutId, clientId, weekStartDate },
  )
  return toWorkoutLog(res)
}

/** Deletes a session in progress and its set logs. */
export async function discardWorkoutLog(id: number): Promise<void> {
  await grpcCall<{ id: number }, unknown>(workoutSessionClient, 'DiscardWorkoutLog', { id })
}

/** Unticks a set of a session in progress (a no-op when it wasn't ticked). */
export async function deleteSetLog(workoutLogId: number, exerciseSetId: number): Promise<void> {
  await grpcCall<{ workoutLogId: number; exerciseSetId: number }, unknown>(workoutSessionClient, 'DeleteSetLog', {
    workoutLogId,
    exerciseSetId,
  })
}

export async function listSetLogs(workoutLogId: number): Promise<SetLog[]> {
  const res = await grpcCall<{ workoutLogId: number }, { setLogs: SetLogResponse[] }>(
    workoutSessionClient,
    'ListSetLogs',
    { workoutLogId },
  )
  return res.setLogs.map(toSetLog)
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

export interface ProgressExercise {
  id: number
  name: string
}

/**
 * The exercises `getExerciseProgress` has points for, most recently trained first (upstream's
 * order and visibility: a TRAINER only sees exercises their catalog shows). Bounded by the
 * client's history, not the catalog, so it is never paged.
 */
export async function listProgressExercises(clientId: number): Promise<ProgressExercise[]> {
  const res = await grpcCall<{ clientId: number }, { exercises: { id: string; name: string }[] }>(
    workoutSessionClient,
    'ListProgressExercises',
    { clientId },
  )
  return res.exercises.map((e) => ({ id: Number(e.id), name: e.name }))
}

/**
 * Single-call aggregate for the client's "do workout" screen: the full
 * workout structure (exercises + sets + video), an in-progress or freshly
 * started log for this week, and the weights/reps recorded last time this
 * workout was performed — so the frontend can pre-fill "last time you did
 * 60kg" without orchestrating four separate requests.
 */
export async function getWorkoutSession(workoutId: number, clientId: number, weekStartDate: string) {
  return composeSession(workoutId, clientId, getOrStartWorkoutLog(workoutId, clientId, weekStartDate))
}

/** The same aggregate over a redo of the week's completed workout (`RestartWorkoutLog`). */
export async function restartWorkoutSession(workoutId: number, clientId: number, weekStartDate: string) {
  return composeSession(workoutId, clientId, restartWorkoutLog(workoutId, clientId, weekStartDate))
}

/**
 * The workout, the session, what was recorded last time per set (`lastPerformed`) and what this
 * session recorded (`current`, so a session resumes on another device).
 */
async function composeSession(workoutId: number, clientId: number, session: Promise<WorkoutLog>) {
  const [workout, workoutLog, lastSetLogs] = await Promise.all([
    workoutService.getFullWorkout(workoutId),
    session,
    getLastSetLogs(clientId, workoutId),
  ])
  const currentSetLogs = await listSetLogs(workoutLog.id)

  const lastByExerciseSetId = new Map(lastSetLogs.map((log) => [log.exerciseSetId, log]))
  const currentByExerciseSetId = new Map(currentSetLogs.map((log) => [log.exerciseSetId, log]))

  const exercises = workout.exercises.map((we) => ({
    ...we,
    sets: we.sets.map((set) => ({
      ...set,
      lastPerformed: lastByExerciseSetId.get(set.id) ?? null,
      current: currentByExerciseSetId.get(set.id) ?? null,
    })),
  }))

  return { ...workout, exercises, workoutLog }
}
