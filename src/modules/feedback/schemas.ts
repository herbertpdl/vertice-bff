import { z } from 'zod'
import { boundedText } from '../../lib/validation.js'

export const FEEDBACK_RATINGS = ['VERY_HARD', 'HARD', 'JUST_RIGHT', 'EASY', 'VERY_EASY'] as const
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number]

export const submitFeedbackSchema = z.object({
  // Required: how hard the workout felt (vertice-api refuses feedback without one).
  rating: z.enum(FEEDBACK_RATINGS),
  // Optional, at most 2000 (`VARCHAR(2000)`); trimmed, "" when the client only rated.
  text: boundedText(2000).trim().default(''),
  // Optional idempotency key, generated once per feedback by the client: a resend with the same
  // key (its answer was lost) returns the feedback already stored instead of adding another.
  clientKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'expected 1-64 characters of [A-Za-z0-9_-]')
    .optional()
    .meta({ description: 'Idempotency key: a resend with the same key returns the stored feedback, not a duplicate.' }),
}).meta({ id: 'SubmitFeedbackRequest' })
