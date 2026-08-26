import * as userService from '../users/service.js'
import * as planService from '../training-plans/service.js'
import * as workoutService from '../workouts/service.js'
import * as sessionService from '../workout-sessions/service.js'
import { ForbiddenError } from '../../lib/errors.js'
import { currentWeekStartDate } from '../../lib/dates.js'

export interface StudentSummary extends userService.User {
  activePlanCount: number
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
