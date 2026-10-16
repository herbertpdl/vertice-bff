import type { FastifyBaseLogger } from 'fastify'
import * as userService from '../users/service.js'
import * as planService from '../training-plans/service.js'
import * as workoutService from '../workouts/service.js'
import * as sessionService from '../workout-sessions/service.js'
import { trainerClientClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'
import { ForbiddenError, PreconditionFailedError } from '../../lib/errors.js'
import { addDays, businessDateOf, currentWeekStartDate, todayInBusinessZone } from '../../lib/dates.js'
import { maskCpf } from '../../lib/cpf.js'

/**
 * One client as the detail screens see them (`GET /clients/:id`, the overview's `student`,
 * `PATCH /clients/:id`, `POST /clients`). `cpf` is masked (`***.***.***-25`) unless the trainer
 * asked for it with `GET /clients/:id?reveal=cpf`.
 */
export interface ClientDetail {
  id: number
  name: string
  email: string
  cpf: string
  role: userService.Role
}

export function toClientDetail(user: userService.User, { revealCpf = false } = {}): ClientDetail {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    cpf: revealCpf ? user.cpf : maskCpf(user.cpf),
    role: user.role,
  }
}

export interface ClientCreateInput {
  name: string
  email: string
  cpf?: string
}

export interface CreatedClient extends ClientDetail {
  /**
   * First-access token for the client to choose a password; the web builds the link from it.
   * `null` when the client was created but the token couldn't be issued: the trainer re-issues
   * it with `POST /clients/:id/setup-token`.
   */
  setup: userService.PasswordSetupToken | null
}

/**
 * Creates a CLIENT user and links them to the trainer's roster via
 * vertice-api's TrainerClientService.CreateClientForTrainer RPC — this is
 * the source of truth for the trainer/client relationship (User has no
 * direct trainer/client link of its own). The client is created without a
 * password (the design's "Novo aluno" flow has no password field), then a
 * password setup token is issued for the trainer to share. There is no email
 * delivery in this stack yet, so the token travels in the response.
 *
 * The token is issued after the create: if that second call fails the client
 * already exists, so the create still succeeds, with `setup: null`, rather
 * than inviting a retry that would hit the duplicate-email 409.
 */
export async function createClient(
  trainerId: number,
  input: ClientCreateInput,
  log: FastifyBaseLogger,
): Promise<CreatedClient> {
  const res = await grpcCall<
    { trainerId: number; name: string; email: string; password: string; cpf: string },
    userService.UserResponse
  >(trainerClientClient, 'CreateClientForTrainer', {
    trainerId,
    name: input.name,
    email: input.email,
    password: '', // none: the client sets it with the setup token
    cpf: input.cpf ?? '',
  })
  const client = toClientDetail(userService.toUser(res))

  let setup: userService.PasswordSetupToken | null = null
  try {
    setup = await userService.createPasswordSetupToken(client.id)
  } catch (err) {
    log.warn({ err, clientId: client.id }, 'Client created, but issuing the password setup token failed')
  }
  return { ...client, setup }
}

/**
 * Re-issues a client's first-access token (the previous one stops working). Only while the
 * client has no password: once they chose one, a trainer-issued link would let the trainer
 * reset it and take over the account. (Password reset is P1-06.) Legacy clients, created with
 * a random password before setup tokens, don't count as "without password"; ops issues theirs
 * (`npm run ops:issue-setup-tokens`).
 */
export async function reissueSetupToken(clientId: number): Promise<userService.PasswordSetupToken> {
  const pending = await userService.listUsersWithoutPassword('CLIENT')
  if (!pending.some((user) => user.id === clientId)) {
    throw new PreconditionFailedError('This client has already set a password')
  }
  return userService.createPasswordSetupToken(clientId)
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

/**
 * One roster entry (`GET /clients`). Built field by field, never spread from the upstream user, so
 * nothing upstream sends (email, CPF, CREF) reaches the list (P1-03). The detail routes carry the
 * email; the roster only needs the id and name.
 */
export interface ClientSummary {
  id: number
  name: string
  activePlanCount: number
  currentPlan: CurrentPlanInfo | null
  lastWorkoutAt: string | null
  weekActivity: WeekActivityDay[]
}

const WEEKDAY_LABELS: WeekdayLabel[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']

/**
 * Roster view for the clients list screen: each client's id and name (see
 * `ClientSummary`: no email, no CPF) with their current (date-active) training plan, their most recent
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
 *
 * "Today", "this week" and each dot's day are the business zone's (`lib/dates.ts`), so the strip
 * matches the days the client lived in São Paulo rather than UTC's.
 */
export async function listClientsOverviewForTrainer(trainerId: number): Promise<ClientSummary[]> {
  const today = todayInBusinessZone()
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

    // The business day each completion happened on, so a Friday-evening workout lights up Friday's
    // dot and not Saturday's (`completedAt.slice(0, 10)` is the UTC day).
    const completedDates = new Set(logs.map((log) => businessDateOf(log.completedAt)))
    const weekActivity = weekDates.map((d) => ({ ...d, completed: completedDates.has(d.date) }))

    return {
      id: client.id,
      name: client.name,
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

/**
 * Ends the trainer's active relationship with the client (`EndTrainerClientRelationship`, sets
 * `ended_at`). The client drops off the roster and the trainer loses what the active link grants
 * (detail view, progress, setup links, new plans); the plans they wrote stay readable to both.
 */
export async function endRelationship(trainerId: number, clientId: number): Promise<void> {
  await grpcCall(trainerClientClient, 'EndTrainerClientRelationship', { trainerId, clientId })
}

const ADHERENCE_LOOKBACK_WEEKS = 4

export interface ClientOverview {
  /** CPF always masked here; the reveal is `GET /clients/:id?reveal=cpf`. */
  student: ClientDetail
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
 * client's currently active plan (the one whose date range contains today in
 * the business zone — if more than one somehow overlaps, the most recently
 * started one wins),
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
  const [user, plans] = await Promise.all([
    userService.getUser(studentId),
    planService.listTrainingPlans({ trainerId, clientId: studentId }),
  ])

  const student = toClientDetail(user)
  const today = todayInBusinessZone()
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
