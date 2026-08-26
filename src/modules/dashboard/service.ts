import * as planService from '../training-plans/service.js'
import * as userService from '../users/service.js'
import * as workoutService from '../workouts/service.js'
import * as sessionService from '../workout-sessions/service.js'
import * as feedbackService from '../feedback/service.js'
import { currentWeekStartDate } from '../../lib/dates.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

function daysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / MS_PER_DAY)
}

function isToday(isoTimestamp: string): boolean {
  return isoTimestamp.slice(0, 10) === new Date().toISOString().slice(0, 10)
}

/**
 * Aggregates everything the trainer dashboard needs into one call: stat
 * tiles, recent feedback, plans nearing their end date, and workouts
 * completed today across the trainer's whole roster. None of this is a
 * single vertice-api RPC — it's assembled here so the dashboard screen
 * doesn't have to orchestrate ~5 calls itself.
 */
export async function getTrainerDashboard(trainerId: number) {
  const plans = await planService.listTrainingPlans({ trainerId })
  const activeClientIds = [...new Set(plans.map((p) => p.clientId))]
  const today = new Date().toISOString().slice(0, 10)
  const activePlans = plans.filter((p) => p.startDate <= today && today <= p.endDate)
  const expiring = plans
    .filter((p) => daysUntil(p.endDate) >= 0 && daysUntil(p.endDate) <= 14)
    .sort((a, b) => daysUntil(a.endDate) - daysUntil(b.endDate))

  const weekStartDate = currentWeekStartDate()
  const [clients, recentFeedback, completedTodayLists] = await Promise.all([
    Promise.all(activeClientIds.map((id) => userService.getUser(id))),
    feedbackService.listWorkoutFeedbackEnriched(trainerId),
    Promise.all(
      plans.map((plan) =>
        sessionService.listWorkoutLogs({ clientId: plan.clientId, trainingPlanId: plan.id, weekStartDate }),
      ),
    ),
  ])
  const clientsById = new Map(clients.map((c) => [c.id, c]))

  const completedToday = (
    await Promise.all(
      completedTodayLists.flat().map(async (log) => {
        if (!log.completedAt || !isToday(log.completedAt)) return null
        const workout = await workoutService.getWorkout(log.workoutId)
        return {
          student: clientsById.get(log.clientId)?.name ?? 'Unknown',
          workout: workout.name,
          time: log.completedAt.slice(11, 16),
        }
      }),
    )
  ).filter((x): x is NonNullable<typeof x> => x !== null)

  const expiringPlans = expiring.map((p) => ({
    name: p.name,
    student: clientsById.get(p.clientId)?.name ?? 'Unknown',
    end: p.endDate,
    daysLeft: daysUntil(p.endDate),
  }))

  return {
    stats: {
      activeClients: activeClientIds.length,
      activePlans: activePlans.length,
      recentFeedbackCount: recentFeedback.length,
      expiringPlansCount: expiring.length,
    },
    recentFeedback: recentFeedback.slice(0, 5),
    expiringPlans,
    completedToday,
  }
}
