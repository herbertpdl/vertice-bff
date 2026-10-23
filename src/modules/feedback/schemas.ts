import { z } from 'zod'
import { boundedText } from '../../lib/validation.js'

export const FEEDBACK_RATINGS = ['VERY_HARD', 'HARD', 'JUST_RIGHT', 'EASY', 'VERY_EASY'] as const
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number]

export const submitFeedbackSchema = z.object({
  // Required: how hard the workout felt (vertice-api refuses feedback without one).
  rating: z.enum(FEEDBACK_RATINGS),
  // Optional, at most 2000 (`VARCHAR(2000)`); trimmed, "" when the client only rated.
  text: boundedText(2000).trim().default(''),
}).meta({ id: 'SubmitFeedbackRequest' })
