import { randomUUID } from 'node:crypto'
import * as userService from '../users/service.js'
import * as planService from '../training-plans/service.js'
import * as workoutService from '../workouts/service.js'
import * as sessionService from '../workout-sessions/service.js'
import { trainerClientClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'
import { ForbiddenError } from '../../lib/errors.js'
import { currentWeekStartDate } from '../../lib/dates.js'

export interface ClientSummary extends userService.User {
  activePlanCount: number
}

export interface ClientCreateInput {
  name: string
  email: string
  cpf?: string
  password?: string
}

/**
 * Creates a CLIENT user and links them to the trainer's roster via
 * vertice-api's TrainerClientService.CreateClientForTrainer RPC — this is
 * the source of truth for the trainer/client relationship (User has no
 * direct trainer/client link of its own). The design's "Novo aluno" flow is
 * invite-based (name/email/cpf only, no password field) — there is no
 * email-invite system in this stack yet, so when no password is supplied we
 * generate one server-side. The client never sees it; a real invite/reset
 * flow would replace this later.
 */
export async function createClient(trainerId: number, input: ClientCreateInput): Promise<userService.User> {
  const res = await grpcCall<
    { trainerId: number; name: string; email: string; password: string; cpf: string },
    userService.UserResponse
  >(trainerClientClient, 'CreateClientForTrainer', {
    trainerId,
    name: input.name,
    email: input.email,
    password: input.password ?? randomUUID(),
    cpf: input.cpf ?? '',
  })
  return userService.toUser(res)
}

export interface CurrentPlanInfo {
  id: number
  name: string
  endDate: string
}

export type WeekdayLabel = 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY'

export interface WeekActivityDay {
  date: string
  dayOfWeek: WeekdayLabel
  completed: boolean
}

export interface ClientRosterEntry extends ClientSummary {
  currentPlan: CurrentPlanInfo | null
  lastWorkoutAt: string | null
  weekActivity: WeekActivityDay[]
}

const WEEKDAY_LABELS: WeekdayLabel[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']

/**
 * Roster view for the clients list screen: extends the plain client summary
 * with each client's current (date-active) training plan, their most recent
 * workout completion, and which weekdays this week had a completed workout
 * (5 dots: Monday–Friday).
 *
 * The base roster — who counts as "this trainer's client" — comes from
 * vertice-api's TrainerClientService.ListClientsForTrainer RPC, not from
 * training plans; a freshly-created client with zero plans still shows up
 * here. Training plans are only used to *enrich* each roster member: a
 * client absent from the plans-derived maps below simply falls back to
 * activePlanCount 0 / currentPlan null / lastWorkoutAt null / an all-empty
 * week strip, rather than being dropped.
 *
 * Simplification: vertice-api's ListWorkoutLogs RPC is scoped to one
 * trainingPlanId + one weekStartDate at a time — there's no general "give me
 * this client's workout history" query. Mirroring the dashboard module's
 * completedToday logic, this only looks at the *current* week's logs across
 * all of the trainer's plans. A client whose last completed workout falls in
 * an earlier week shows `lastWorkoutAt: null` / an all-empty week strip here,
 * rather than a stale older date — we only surface activity we can actually
 * confirm.
 */
export async function listClientsOverviewForTrainer(trainerId: number): Promise<ClientRosterEntry[]> {
  const today = new Date().toISOString().slice(0, 10)
  const weekStartDate = currentWeekStartDate()
  const weekDates = WEEKDAY_LABELS.map((dayOfWeek, i) => ({ dayOfWeek, date: addDays(weekStartDate, i) }))

  const [rosterRes, plans] = await Promise.all([
    grpcCall<{ trainerId: number }, { clients: userService.UserResponse[] }>(
      trainerClientClient,
      'ListClientsForTrainer',
      { trainerId },
    ),
    planService.listTrainingPlans({ trainerId }),
  ])
  const roster = rosterRes.clients.map(userService.toUser)

  const countByClient = new Map<number, number>()
  const plansByClient = new Map<number, planService.TrainingPlan[]>()
  for (const plan of plans) {
    countByClient.set(plan.clientId, (countByClient.get(plan.clientId) ?? 0) + 1)
    plansByClient.set(plan.clientId, [...(plansByClient.get(plan.clientId) ?? []), plan])
  }

  const logsByPlan = await Promise.all(
    plans.map((plan) =>
      sessionService.listWorkoutLogs({ clientId: plan.clientId, trainingPlanId: plan.id, weekStartDate }),
    ),
  )

  const logsByClient = new Map<number, sessionService.WorkoutLog[]>()
  plans.forEach((plan, i) => {
    const completedLogs = (logsByPlan[i] ?? []).filter((log) => log.completedAt)
    logsByClient.set(plan.clientId, [...(logsByClient.get(plan.clientId) ?? []), ...completedLogs])
  })

  return roster.map((client) => {
    const clientPlans = plansByClient.get(client.id) ?? []
    const [activePlan] = clientPlans
      .filter((p) => p.startDate <= today && today <= p.endDate)
      .sort((a, b) => (a.startDate < b.startDate ? 1 : -1)) // most recently started active plan wins

    const logs = (logsByClient.get(client.id) ?? []).sort((a, b) => (a.completedAt > b.completedAt ? -1 : 1))
    const lastWorkoutAt = logs[0]?.completedAt || null

    const completedDates = new Set(logs.map((log) => log.completedAt.slice(0, 10)))
    const weekActivity = weekDates.map((d) => ({ ...d, completed: completedDates.has(d.date) }))

    return {
      ...client,
      activePlanCount: countByClient.get(client.id) ?? 0,
      currentPlan: activePlan ? { id: activePlan.id, name: activePlan.name, endDate: activePlan.endDate } : null,
      lastWorkoutAt,
      weekActivity,
    }
  })
}

/** Confirms `clientId` is actually one of `trainerId`'s clients via vertice-api's TrainerClientService. */
export async function assertIsTrainersClient(trainerId: number, clientId: number): Promise<void> {
  const res = await grpcCall<{ trainerId: number; clientId: number }, { isClient: boolean }>(
    trainerClientClient,
    'IsTrainersClient',
    { trainerId, clientId },
  )
  if (!res.isClient) {
    throw new ForbiddenError('This client is not one of your clients')
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const ADHERENCE_LOOKBACK_WEEKS = 4

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  return new Date(d.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10)
}

// (shared by both the weekly-activity roster view above and the adherence calc below)

export interface ClientOverview {
  student: userService.User
  activePlan: {
    id: number
    name: string
    level: planService.PlanLevel
    startDate: string
    endDate: string
  } | null
  thisWeek: { completed: number; total: number }
  lastWorkoutAt: string | null
  adherence4Weeks: number | null
}

/**
 * Aggregates the "4-tile" header stats for the client detail screen: the
 * client's currently active plan (the one whose date range contains today —
 * if more than one somehow overlaps, the most recently started one wins),
 * this week's completed-vs-total workout count for that plan, the most
 * recent completed-workout timestamp, and a trailing-4-week adherence %.
 *
 * Adherence is an approximation: vertice-api's ListWorkoutLogs RPC is scoped
 * to one training plan + one ISO week (no general history query), so we
 * treat the plan's workout list as the weekly schedule and re-fetch it for
 * each of the last 4 Mondays (currentWeekStartDate and the 3 before it),
 * clamped to weeks that fall on/after the plan's start date. Adherence % =
 * (completed logs across those weeks) / (workouts-per-week * weeks elapsed),
 * capped at 100. "Last workout" is the latest completedAt found in that same
 * lookback window, not a true all-time value, since there's no cheaper way
 * to get it from the current API surface.
 */
export async function getClientOverview(trainerId: number, studentId: number): Promise<ClientOverview> {
  const [student, plans] = await Promise.all([
    userService.getUser(studentId),
    planService.listTrainingPlans({ trainerId, clientId: studentId }),
  ])

  const today = new Date().toISOString().slice(0, 10)
  const activePlan = plans
    .filter((p) => p.startDate <= today && today <= p.endDate)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0]

  if (!activePlan) {
    return {
      student,
      activePlan: null,
      thisWeek: { completed: 0, total: 0 },
      lastWorkoutAt: null,
      adherence4Weeks: null,
    }
  }

  const workouts = await workoutService.listWorkouts(activePlan.id)
  const total = workouts.length

  const currentWeekStart = currentWeekStartDate()
  const weekStarts = Array.from({ length: ADHERENCE_LOOKBACK_WEEKS }, (_, i) => addDays(currentWeekStart, -7 * i))
  const weekStartsElapsed = weekStarts.filter((ws) => ws >= activePlan.startDate)

  const logsByWeek = await Promise.all(
    weekStartsElapsed.map((weekStartDate) =>
      sessionService.listWorkoutLogs({ clientId: studentId, trainingPlanId: activePlan.id, weekStartDate }),
    ),
  )

  const thisWeekLogs = logsByWeek[weekStartsElapsed.indexOf(currentWeekStart)] ?? []
  const thisWeekCompleted = thisWeekLogs.filter((log) => log.completedAt).length

  const allCompletedAt = logsByWeek.flat().map((log) => log.completedAt).filter(Boolean)
  const lastWorkoutAt = allCompletedAt.length > 0 ? allCompletedAt.sort().at(-1)! : null

  const scheduledTotal = total * weekStartsElapsed.length
  const completedTotal = logsByWeek.flat().filter((log) => log.completedAt).length
  const adherence4Weeks = scheduledTotal > 0 ? Math.min(100, Math.round((completedTotal / scheduledTotal) * 100)) : null

  return {
    student,
    activePlan: {
      id: activePlan.id,
      name: activePlan.name,
      level: activePlan.level,
      startDate: activePlan.startDate,
      endDate: activePlan.endDate,
    },
    thisWeek: { completed: thisWeekCompleted, total },
    lastWorkoutAt,
    adherence4Weeks,
  }
}
