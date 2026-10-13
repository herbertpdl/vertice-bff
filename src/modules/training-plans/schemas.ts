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

/**
 * PATCH body: the create body minus `clientId`. A plan's client is fixed at creation, so the
 * route forwards the stored `clientId` upstream instead. A `clientId` sent anyway is stripped by
 * Zod (unknown keys are dropped) and ignored, not rejected, so a caller echoing the full plan
 * back still succeeds without being able to reassign it.
 */
export const trainingPlanUpdateSchema = trainingPlanInputSchema.omit({ clientId: true })

export type TrainingPlanUpdateBody = z.infer<typeof trainingPlanUpdateSchema>
