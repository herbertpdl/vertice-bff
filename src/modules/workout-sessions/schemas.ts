import { z } from 'zod'

export const recordSetLogSchema = z.object({
  exerciseSetId: z.number().int().positive(),
  weight: z.string().min(1),
  reps: z.number().int().min(0),
})

export const weekStartDateQuerySchema = z.object({
  weekStartDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .optional(),
})
