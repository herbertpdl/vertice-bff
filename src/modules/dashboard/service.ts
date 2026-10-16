import * as planService from '../training-plans/service.js'
import * as userService from '../users/service.js'
import * as workoutService from '../workouts/service.js'
import * as sessionService from '../workout-sessions/service.js'
import * as feedbackService from '../feedback/service.js'
import {
  businessDateOf,
  currentWeekStartDate,
  daysBetween,
  todayInBusinessZone,
} from '../../lib/dates.js'

const EXPIRING_WITHIN_DAYS = 14

/**
 * Aggregates everything the trainer dashboard needs into one call: stat
 * tiles, recent feedback, plans nearing their end date, and workouts
 * completed today across the trainer's whole roster. None of this is a
 * single vertice-api RPC — it's assembled here so the dashboard screen
 * doesn't have to orchestrate ~5 calls itself.
 *
 * Every "today" here is the business day in `America/Sao_Paulo` (`lib/dates.ts`): which plans are
 * active, which week's logs to fetch, and which completions count as today's. A plan's dates and a
 * log's `weekStartDate` are business dates, so they compare against it as plain strings.
 */
export async function getTrainerDashboard(trainerId: number) {
  const plans = await planService.listTrainingPlans({ trainerId })
  const activeClientIds = [...new Set(plans.map((p) => p.clientId))]
  const today = todayInBusinessZone()
  const activePlans = plans.filter((p) => p.startDate <= today && today <= p.endDate)
  // Whole calendar days between two business dates — not milliseconds from "now" to a date, which
  // made a plan ending today look expired from 21:00 local onwards.
  const daysLeft = new Map(plans.map((p) => [p.id, daysBetween(today, p.endDate)]))
  const expiring = plans
    .filter((p) => daysLeft.get(p.id)! >= 0 && daysLeft.get(p.id)! <= EXPIRING_WITHIN_DAYS)
    .sort((a, b) => daysLeft.get(a.id)! - daysLeft.get(b.id)!)

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
        // The business day the client completed it on, not `completedAt.slice(0, 10)`: that is the
        // UTC day, so an evening workout counts as tomorrow's.
        if (!log.completedAt || businessDateOf(log.completedAt) !== today) return null
        const workout = await workoutService.getWorkout(log.workoutId)
        return {
          student: clientsById.get(log.clientId)?.name ?? 'Unknown',
          workout: workout.name,
          // The instant itself: the client formats the clock in the zone it wants. There is no
          // pre-formatted `time` beside it any more — it carried its zone implicitly.
          completedAt: log.completedAt,
        }
      }),
    )
  ).filter((x): x is NonNullable<typeof x> => x !== null)

  const expiringPlans = expiring.map((p) => ({
    name: p.name,
    student: clientsById.get(p.clientId)?.name ?? 'Unknown',
    end: p.endDate,
    daysLeft: daysLeft.get(p.id)!,
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
