import { randomUUID } from 'node:crypto'
import * as userService from '../users/service.js'
import * as planService from '../training-plans/service.js'
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

export interface StudentOverview extends StudentSummary {
  currentPlan: CurrentPlanInfo | null
  lastWorkoutAt: string | null
  weekActivity: WeekActivityDay[]
}

const WEEKDAY_LABELS: WeekdayLabel[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

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
export async function listStudentsOverviewForTrainer(trainerId: number): Promise<StudentOverview[]> {
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
