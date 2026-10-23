import { workoutFeedbackClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'
import * as userService from '../users/service.js'
import * as workoutService from '../workouts/service.js'
import * as planService from '../training-plans/service.js'
import { FEEDBACK_RATINGS, type FeedbackRating } from './schemas.js'

export interface WorkoutFeedback {
  id: number
  workoutLogId: number
  workoutId: number
  trainingPlanId: number
  clientId: number
  text: string
  rating: FeedbackRating | null
  replaced: boolean
  createdAt: string
}

interface WorkoutFeedbackResponse {
  id: string
  workoutLogId: string
  workoutId: string
  trainingPlanId: string
  clientId: string
  text: string
  /** `FEEDBACK_RATING_*` (proto enum as a string); `UNSPECIFIED` on old feedback. */
  rating?: string
  replaced?: boolean
  createdAt: string
}

/** The rating without its proto prefix; null for feedback given before ratings existed. */
function toRating(value: string | undefined): FeedbackRating | null {
  const rating = value?.replace(/^FEEDBACK_RATING_/, '')
  return (FEEDBACK_RATINGS as readonly string[]).includes(rating ?? '') ? (rating as FeedbackRating) : null
}

function toFeedback(r: WorkoutFeedbackResponse): WorkoutFeedback {
  return {
    id: Number(r.id),
    workoutLogId: Number(r.workoutLogId),
    workoutId: Number(r.workoutId),
    trainingPlanId: Number(r.trainingPlanId),
    clientId: Number(r.clientId),
    text: r.text,
    rating: toRating(r.rating),
    replaced: r.replaced ?? false,
    createdAt: r.createdAt,
  }
}

export async function submitWorkoutFeedback(
  workoutLogId: number,
  rating: FeedbackRating,
  text: string,
): Promise<WorkoutFeedback> {
  const res = await grpcCall<{ workoutLogId: number; rating: string; text: string }, WorkoutFeedbackResponse>(
    workoutFeedbackClient,
    'SubmitWorkoutFeedback',
    { workoutLogId, rating: `FEEDBACK_RATING_${rating}`, text },
  )
  return toFeedback(res)
}

export async function listWorkoutFeedback(trainerId: number): Promise<WorkoutFeedback[]> {
  const res = await grpcCall<{ trainerId: number }, { workoutFeedback: WorkoutFeedbackResponse[] }>(
    workoutFeedbackClient,
    'ListWorkoutFeedback',
    { trainerId },
  )
  return res.workoutFeedback.map(toFeedback)
}

export interface EnrichedFeedback extends WorkoutFeedback {
  clientName: string
  workoutName: string
  trainingPlanName: string
}

/** Joins client/workout/plan names onto raw feedback rows for list screens (avoids N+1 fetches on the frontend). */
export async function listWorkoutFeedbackEnriched(trainerId: number): Promise<EnrichedFeedback[]> {
  const feedback = await listWorkoutFeedback(trainerId)
  feedback.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return Promise.all(
    feedback.map(async (item) => {
      const [client, workout, plan] = await Promise.all([
        userService.getUser(item.clientId),
        workoutService.getWorkout(item.workoutId),
        planService.getTrainingPlan(item.trainingPlanId),
      ])
      return { ...item, clientName: client.name, workoutName: workout.name, trainingPlanName: plan.name }
    }),
  )
}
