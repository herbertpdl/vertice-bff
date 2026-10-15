import { z } from 'zod'
import { boundedText, optionalIdQuery, requiredText, utf16String } from '../../lib/validation.js'

// Limits mirror vertice-api's purely to fail fast with field-level `details`; upstream is
// authoritative (unknown group ids are only checked there).
export const exerciseInputSchema = z.object({
  name: requiredText(255),
  description: boundedText(255).default(''),
  // http(s) only (`^https?://\S+$`, as vertice-api): the catalog is shared, so a `javascript:` or
  // `data:` link must never be stored.
  videoUrl: utf16String(500)
    .regex(/^https?:\/\/\S+$/, 'expected an http(s) URL')
    .optional()
    .or(z.literal('')),
  // Duplicates are dropped, not rejected; first occurrence wins so the order the
  // trainer picked (the first id may be the primary group) is preserved.
  muscleGroupIds: z
    .array(z.number().int().positive())
    .min(1)
    .transform((ids) => [...new Set(ids)]),
}).meta({ id: 'ExerciseRequest' })

export type ExerciseInputBody = z.infer<typeof exerciseInputSchema>

// A web client sends `?muscleGroupId=&q=` literally on the default screen, so an empty
// value means "no filter" rather than a 400.
const emptyAsAbsent = (value: unknown) => (value === '' ? undefined : value)

export const exerciseListQuerySchema = z.object({
  muscleGroupId: z.preprocess(emptyAsAbsent, z.coerce.number().int().positive().optional()),
  q: z.preprocess(
    (value) => (typeof value === 'string' ? emptyAsAbsent(value.trim()) : value),
    utf16String(100).min(1).optional(),
  ),
})

export type ExerciseListQuery = z.infer<typeof exerciseListQuerySchema>

/** `GET /exercises/:id/progress` query: a TRAINER names the client; a CLIENT's value is ignored. */
export const exerciseProgressQuerySchema = z.object({ clientId: optionalIdQuery })
