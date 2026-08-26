import { z } from 'zod'

export const submitFeedbackSchema = z.object({
  text: z.string().min(1),
})
