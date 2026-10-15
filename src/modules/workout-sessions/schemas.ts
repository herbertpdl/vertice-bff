import { z } from 'zod'
import { isoDateSchema, optionalIdQuery, repsCount, WEIGHT_PATTERN, weightMessage } from '../../lib/validation.js'

export const recordSetLogSchema = z.object({
  exerciseSetId: z.number().int().positive(),
  // Required here (a log without a weight is not a log), unlike a set's optional weight.
  weight: z.string().regex(WEIGHT_PATTERN, weightMessage),
  reps: repsCount,
})

/** `GET /workouts/:workoutId/session` query. A CLIENT's `clientId` is ignored (their own is used). */
export const weekStartDateQuerySchema = z.object({
  weekStartDate: isoDateSchema.optional(),
  clientId: optionalIdQuery,
})

/** `GET /workout-logs` query. `trainingPlanId` is required; `clientId` only for a TRAINER. */
export const workoutLogListQuerySchema = weekStartDateQuerySchema.extend({
  trainingPlanId: optionalIdQuery,
})
