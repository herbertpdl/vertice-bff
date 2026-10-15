import { z } from 'zod'
import { boundedText, isoDateSchema, optionalIdQuery, requiredText } from '../../lib/validation.js'

export const planLevelSchema = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED'])

const trainingPlanBaseSchema = z.object({
  name: requiredText(255),
  description: boundedText(255).default(''),
  clientId: z.number().int().positive(),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  level: planLevelSchema,
})

// ISO dates compare as strings; vertice-api refuses an end before the start too.
const endNotBeforeStart = (plan: { startDate: string; endDate: string }) => plan.endDate >= plan.startDate
const endNotBeforeStartIssue = { message: 'endDate must not be before startDate', path: ['endDate'] }

export const trainingPlanInputSchema = trainingPlanBaseSchema.refine(endNotBeforeStart, endNotBeforeStartIssue)

export type TrainingPlanInputBody = z.infer<typeof trainingPlanInputSchema>

/**
 * PATCH body: the create body minus `clientId`. A plan's client is fixed at creation, so the
 * route forwards the stored `clientId` upstream instead. A `clientId` sent anyway is stripped by
 * Zod (unknown keys are dropped) and ignored, not rejected, so a caller echoing the full plan
 * back still succeeds without being able to reassign it.
 */
export const trainingPlanUpdateSchema = trainingPlanBaseSchema
  .omit({ clientId: true })
  .refine(endNotBeforeStart, endNotBeforeStartIssue)

export type TrainingPlanUpdateBody = z.infer<typeof trainingPlanUpdateSchema>

/** `GET /training-plans` query: a TRAINER may filter by one of their clients. */
export const trainingPlanListQuerySchema = z.object({ clientId: optionalIdQuery })
