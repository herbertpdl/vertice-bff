import { z } from 'zod'

export const exerciseInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  videoUrl: z.string().url().optional().or(z.literal('')),
})

export type ExerciseInputBody = z.infer<typeof exerciseInputSchema>
