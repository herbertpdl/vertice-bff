import { z } from 'zod'

export const dayOfWeekSchema = z.enum([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
])

export const workoutInputSchema = z.object({
  name: z.string().min(1),
  dayOfWeek: dayOfWeekSchema,
})

export const cloneWorkoutSchema = z.object({
  targetTrainingPlanId: z.number().int().positive(),
  name: z.string().min(1),
  dayOfWeek: dayOfWeekSchema,
})
