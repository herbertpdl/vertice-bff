import { z } from 'zod'

/**
 * Field rules shared by the request schemas. They mirror vertice-api's validation (its PR #70 is
 * the table of record) so a bad value is a field-level 400 here, before any upstream call; the API
 * stays authoritative. String lengths count UTF-16 code units, like Java's `String.length()`, so
 * `.max(n)` is the same bound at both layers.
 */

/**
 * A required text: not blank, at most `max` characters. The bound is checked on the raw value, as
 * vertice-api's `@Size` is, and the stored value is trimmed.
 */
export const requiredText = (max: number) => z.string().max(max).trim().min(1)

/** An optional free text with a column bound (`VARCHAR(255)` for notes and descriptions). */
export const boundedText = (max: number) => z.string().max(max)

/** A calendar date, `YYYY-MM-DD`, that exists (2026-02-30 is not one). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number]
    const date = new Date(Date.UTC(y, m - 1, d))
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  }, 'not a calendar date')

/** `weight`: at most 4 integer digits and 2 decimals (`NUMERIC(6,2)`). */
export const WEIGHT_PATTERN = /^\d{1,4}(\.\d{1,2})?$/
/** `loadPercentage`: at most 3 integer digits and 2 decimals (`NUMERIC(5,2)`). */
export const LOAD_PERCENTAGE_PATTERN = /^\d{1,3}(\.\d{1,2})?$/

/** An optional decimal; an empty string means "unset", as upstream reads it. */
export const optionalDecimal = (pattern: RegExp, message: string) =>
  z.string().regex(pattern, message).or(z.literal('')).optional()

export const weightMessage = 'expected a number with up to 4 integer digits and 2 decimals'
export const loadPercentageMessage = 'expected a number with up to 3 integer digits and 2 decimals'

/** Integer bounds vertice-api enforces on every write RPC. */
export const orderNumber = z.number().int().min(1).max(1000)
export const repsCount = z.number().int().min(0).max(1000)
export const durationSeconds = z.number().int().min(0).max(86_400)
export const restSeconds = z.number().int().min(0).max(3600)

/** Caps vertice-api enforces on the nested RPCs and on the per-item creates. */
export const MAX_EXERCISES_PER_WORKOUT = 20
export const MAX_SETS_PER_EXERCISE = 10

/** A query-string id: absent or empty is "no value" (a client may send `?clientId=` literally). */
const emptyAsAbsent = (value: unknown) => (value === '' ? undefined : value)
export const optionalIdQuery = z.preprocess(
  emptyAsAbsent,
  z
    .string()
    .regex(/^\d{1,15}$/, 'expected a positive integer')
    .transform(Number)
    .refine((id) => id > 0, 'expected a positive integer')
    .optional(),
)
