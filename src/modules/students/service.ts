import { randomUUID } from 'node:crypto'
import * as userService from '../users/service.js'
import * as planService from '../training-plans/service.js'
import * as workoutService from '../workouts/service.js'
import * as sessionService from '../workout-sessions/service.js'
import { ForbiddenError } from '../../lib/errors.js'
import { currentWeekStartDate } from '../../lib/dates.js'

export interface StudentSummary extends userService.User {
  activePlanCount: number
}

export interface StudentCreateInput {
  name: string
  email: string
  cpf?: string
  password?: string
}

/**
 * Creates a CLIENT user for a trainer's roster. The design's "Novo aluno"
 * flow is invite-based (name/email/cpf only, no password field) — there is
 * no email-invite system in this stack yet, so when no password is supplied
 * we generate one server-side. The client never sees it; a real invite/reset
 * flow would replace this later.
 */
export async function createStudent(input: StudentCreateInput): Promise<userService.User> {
  return userService.createUser({
    name: input.name,
    email: input.email,
    cpf: input.cpf,
    password: input.password ?? randomUUID(),
    role: 'CLIENT',
  })
}

/** A trainer's roster is derived from the distinct clients across their training plans — User has no direct trainer/client link. */
export async function listStudentsForTrainer(trainerId: number): Promise<StudentSummary[]> {
  const plans = await planService.listTrainingPlans({ trainerId })
  const countByClient = new Map<number, number>()
  for (const plan of plans) {
    countByClient.set(plan.clientId, (countByClient.get(plan.clientId) ?? 0) + 1)
  }

  const clients = await Promise.all([...countByClient.keys()].map((id) => userService.getUser(id)))
  return clients.map((client) => ({ ...client, activePlanCount: countByClient.get(client.id) ?? 0 }))
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

export interface StudentRosterEntry extends StudentSummary {
  currentPlan: CurrentPlanInfo | null
  lastWorkoutAt: string | null
  weekActivity: WeekActivityDay[]
}

const WEEKDAY_LABELS: WeekdayLabel[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']

/**
 * Roster view for the students list screen: extends the plain student
 * summary with each student's current (date-active) training plan, their
 * most recent workout completion, and which weekdays this week had a
 * completed workout (5 dots: Monday–Friday).
 *
 * Simplification: vertice-api's ListWorkoutLogs RPC is scoped to one
 * trainingPlanId + one weekStartDate at a time — there's no general "give me
 * this client's workout history" query. Mirroring the dashboard module's
 * completedToday logic, this only looks at the *current* week's logs across
 * all of the trainer's plans. A student whose last completed workout falls
 * in an earlier week shows `lastWorkoutAt: null` / an all-empty week strip
 * here, rather than a stale older date — we only surface activity we can
 * actually confirm.
 */
export async function listStudentsOverviewForTrainer(trainerId: number): Promise<StudentRosterEntry[]> {
  const plans = await planService.listTrainingPlans({ trainerId })
  const today = new Date().toISOString().slice(0, 10)
  const weekStartDate = currentWeekStartDate()
  const weekDates = WEEKDAY_LABELS.map((dayOfWeek, i) => ({ dayOfWeek, date: addDays(weekStartDate, i) }))

  const countByClient = new Map<number, number>()
  const plansByClient = new Map<number, planService.TrainingPlan[]>()
  for (const plan of plans) {
    countByClient.set(plan.clientId, (countByClient.get(plan.clientId) ?? 0) + 1)
    plansByClient.set(plan.clientId, [...(plansByClient.get(plan.clientId) ?? []), plan])
  }
  const clientIds = [...countByClient.keys()]

  const [clients, logsByPlan] = await Promise.all([
    Promise.all(clientIds.map((id) => userService.getUser(id))),
    Promise.all(
      plans.map((plan) =>
        sessionService.listWorkoutLogs({ clientId: plan.clientId, trainingPlanId: plan.id, weekStartDate }),
      ),
    ),
  ])

  const logsByClient = new Map<number, sessionService.WorkoutLog[]>()
  plans.forEach((plan, i) => {
    const completedLogs = (logsByPlan[i] ?? []).filter((log) => log.completedAt)
    logsByClient.set(plan.clientId, [...(logsByClient.get(plan.clientId) ?? []), ...completedLogs])
  })

  return clients.map((client) => {
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

export async function assertIsTrainersClient(trainerId: number, clientId: number): Promise<void> {
  const plans = await planService.listTrainingPlans({ trainerId, clientId })
  if (plans.length === 0) {
    throw new ForbiddenError('This client is not one of your students')
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const ADHERENCE_LOOKBACK_WEEKS = 4

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  return new Date(d.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10)
}

// (shared by both the weekly-activity roster view above and the adherence calc below)

export interface StudentOverview {
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
 * Aggregates the "4-tile" header stats for the student detail screen: the
 * student's currently active plan (the one whose date range contains today —
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
export async function getStudentOverview(trainerId: number, studentId: number): Promise<StudentOverview> {
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
