import { z } from 'zod'

export const planLevelSchema = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED'])

export const trainingPlanInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  clientId: z.number().int().positive(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  level: planLevelSchema,
})

export type TrainingPlanInputBody = z.infer<typeof trainingPlanInputSchema>
