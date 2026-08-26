import { z } from 'zod'

export const muscleGroupSchema = z.enum(['CHEST', 'BACK', 'LEGS', 'SHOULDERS', 'ARMS', 'CORE', 'CARDIO'])

export const exerciseInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  videoUrl: z.string().url().optional().or(z.literal('')),
  muscleGroup: muscleGroupSchema,
})

export type ExerciseInputBody = z.infer<typeof exerciseInputSchema>
