import { z } from 'zod'

// Length limits mirror vertice-api's purely to fail fast with field-level `details`;
// upstream is authoritative (blank-after-trim names, the http(s) URL rule and unknown
// group ids are only checked there).
export const exerciseInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(255).default(''),
  videoUrl: z.string().url().max(500).optional().or(z.literal('')),
  // Duplicates are dropped, not rejected; first occurrence wins so the order the
  // trainer picked (the first id may be the primary group) is preserved.
  muscleGroupIds: z
    .array(z.number().int().positive())
    .min(1)
    .transform((ids) => [...new Set(ids)]),
})

export type ExerciseInputBody = z.infer<typeof exerciseInputSchema>

// A web client sends `?muscleGroupId=&q=` literally on the default screen, so an empty
// value means "no filter" rather than a 400.
const emptyAsAbsent = (value: unknown) => (value === '' ? undefined : value)

export const exerciseListQuerySchema = z.object({
  muscleGroupId: z.preprocess(emptyAsAbsent, z.coerce.number().int().positive().optional()),
  q: z.preprocess(
    (value) => (typeof value === 'string' ? emptyAsAbsent(value.trim()) : value),
    z.string().min(1).max(100).optional(),
  ),
})

export type ExerciseListQuery = z.infer<typeof exerciseListQuerySchema>
