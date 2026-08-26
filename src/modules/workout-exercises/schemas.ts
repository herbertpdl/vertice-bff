import { z } from 'zod'

export const workoutExerciseCreateSchema = z.object({
  exerciseId: z.number().int().positive(),
  order: z.number().int().min(0),
  restSecondsBetweenSets: z.number().int().min(0).default(0),
  notes: z.string().default(''),
})

export const workoutExerciseUpdateSchema = z.object({
  order: z.number().int().min(0),
  restSecondsBetweenSets: z.number().int().min(0).default(0),
  notes: z.string().default(''),
})
