import { z } from 'zod'
import { youtubeVideoId } from '../../lib/youtube.js'
import { boundedText, optionalIdQuery, requiredText, utf16String } from '../../lib/validation.js'

// Limits mirror vertice-api's purely to fail fast with field-level `details`; upstream is
// authoritative (unknown group ids are only checked there).
export const exerciseInputSchema = z.object({
  name: requiredText(255),
  description: boundedText(255).default(''),
  // A YouTube video only (R61, as vertice-api): the client app plays it in an embedded player. An
  // http(s) URL by construction, so a `javascript:` or `data:` link is never stored.
  videoUrl: utf16String(500)
    .refine((url) => youtubeVideoId(url) !== null, 'expected a YouTube video link (youtube.com or youtu.be)')
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
  // Page size (vertice-api: 30 when absent, never more than 50). Above 50 is a 400 here rather
  // than silently lowered, so a client never believes it got more than one page.
  limit: z.preprocess(emptyAsAbsent, z.coerce.number().int().min(1).max(50).optional()),
  // `nextCursor` from the previous page, sent with the same filter. Opaque: vertice-api checks it.
  cursor: z.preprocess(emptyAsAbsent, z.string().max(64).optional()),
})

export type ExerciseListQuery = z.infer<typeof exerciseListQuerySchema>

/** `GET /exercises/:id/progress` query: a TRAINER names the client; a CLIENT's value is ignored. */
export const exerciseProgressQuerySchema = z.object({ clientId: optionalIdQuery })
