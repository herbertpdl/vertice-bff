import { z } from 'zod'
import { optionalIdQuery, utf16String } from '../../lib/validation.js'

/**
 * Query schemas of the admin read routes (admin-panel spec §2.2, B12). They mirror vertice-api's
 * `AdminService` bounds so a bad value is a field-level 400 with no upstream call; the API stays
 * authoritative (it refuses a malformed cursor itself).
 */

/** A client may send `?role=&q=` literally on the default screen: an empty value means "no filter". */
const emptyAsAbsent = (value: unknown) => (value === '' ? undefined : value)

/** The page sizes every admin list takes (R25, D26); absent is 25. */
export const ADMIN_PAGE_SIZES = [10, 25, 50] as const
export const ADMIN_DEFAULT_PAGE_SIZE = 25
/** An opaque cursor's bound: `nextCursor` of the previous page, checked upstream. */
export const ADMIN_CURSOR_MAX = 512
/** vertice-api's `search` bound (UTF-16 units, like Java's `String.length()`). */
export const ADMIN_SEARCH_MAX = 100

const limitQuery = z.preprocess(
  emptyAsAbsent,
  z.coerce
    .number()
    .refine((n) => (ADMIN_PAGE_SIZES as readonly number[]).includes(n), 'expected 10, 25 or 50')
    .optional()
    .transform((n) => n ?? ADMIN_DEFAULT_PAGE_SIZE),
)
const cursorQuery = z.preprocess(emptyAsAbsent, z.string().max(ADMIN_CURSOR_MAX).optional())

/** The directory's roles: trainers and clients only, admins are invisible (R16). */
export const DIRECTORY_ROLES = ['TRAINER', 'CLIENT'] as const
export const DIRECTORY_STATUSES = ['ACTIVE', 'SUSPENDED'] as const

/** `GET /admin/users` query. */
export const adminDirectoryQuerySchema = z.object({
  role: z.preprocess(emptyAsAbsent, z.enum(DIRECTORY_ROLES).optional()),
  status: z.preprocess(emptyAsAbsent, z.enum(DIRECTORY_STATUSES).optional()),
  q: z.preprocess(
    (value) => (typeof value === 'string' ? emptyAsAbsent(value.trim()) : value),
    utf16String(ADMIN_SEARCH_MAX).min(1).optional(),
  ),
  limit: limitQuery,
  cursor: cursorQuery,
})
export type AdminDirectoryQuery = z.infer<typeof adminDirectoryQuerySchema>

/** vertice-api's `AdminAction`, without the `ADMIN_ACTION_` prefix (spec §1). */
export const ADMIN_ACTIONS = [
  'VIEW_USER_PROFILE',
  'SUSPEND_USER',
  'REACTIVATE_USER',
  'SEND_FIRST_ACCESS_EMAIL',
  'SEND_PASSWORD_RESET_EMAIL',
  'END_RELATIONSHIP',
  'CHANGE_OWN_PASSWORD',
  'CREATE_STARTER_EXERCISE',
  'UPDATE_STARTER_EXERCISE',
  'DELETE_STARTER_EXERCISE',
  'PROMOTE_EXERCISE',
  'CREATE_MUSCLE_GROUP',
  'RENAME_MUSCLE_GROUP',
] as const
export type AdminAction = (typeof ADMIN_ACTIONS)[number]

/** `GET /admin/actions` query. */
export const adminActionsQuerySchema = z.object({
  adminId: optionalIdQuery,
  action: z.preprocess(emptyAsAbsent, z.enum(ADMIN_ACTIONS).optional()),
  targetUserId: optionalIdQuery,
  limit: limitQuery,
  cursor: cursorQuery,
})
export type AdminActionsQuery = z.infer<typeof adminActionsQuerySchema>

/** vertice-api's reason bound (D21): trimmed, then 1-500 UTF-16 units, as Java's `String.length()`. */
export const ADMIN_REASON_MAX = 500

/**
 * Body of `POST /admin/users/:id/suspend` and `/reactivate` (R39, R44, E20). Missing or blank is a
 * 400 with no upstream call. The reason goes to the history only: never logged here (B15).
 */
export const adminReasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .refine((value) => value.length <= ADMIN_REASON_MAX, `Too big: expected string to have <=${ADMIN_REASON_MAX} characters`)
    .meta({ maxLength: ADMIN_REASON_MAX })
    .describe('Why, for the action history (not shown to the user). Trimmed; 1-500 characters.'),
})
export type AdminReason = z.infer<typeof adminReasonSchema>

// ---- exercise curation (VRT-31, spec §2.4) ---------------------------------------------------------

/** `GET /admin/exercises` `scope`: absent is both (vertice-api's `CATALOG_SCOPE_UNSPECIFIED`). */
export const CATALOG_SCOPES = ['STARTER', 'PRIVATE'] as const
export type CatalogScope = (typeof CATALOG_SCOPES)[number]

/** The catalog search: trimmed, empty means no filter, at most 100 UTF-16 units (as the directory's). */
const searchQuery = z.preprocess(
  (value) => (typeof value === 'string' ? emptyAsAbsent(value.trim()) : value),
  utf16String(ADMIN_SEARCH_MAX).min(1).optional(),
)

/** `GET /admin/exercises` query. A group or owner that doesn't exist is an empty page upstream, not a 404. */
export const adminCatalogQuerySchema = z.object({
  scope: z.preprocess(emptyAsAbsent, z.enum(CATALOG_SCOPES).optional()),
  muscleGroupId: optionalIdQuery,
  ownerId: optionalIdQuery,
  q: searchQuery,
  limit: limitQuery,
  cursor: cursorQuery,
})
export type AdminCatalogQuery = z.infer<typeof adminCatalogQuerySchema>

/** `GET /admin/exercises/most-used` query (R22-R25). */
export const adminMostUsedQuerySchema = z.object({
  muscleGroupId: optionalIdQuery,
  limit: limitQuery,
  cursor: cursorQuery,
})
export type AdminMostUsedQuery = z.infer<typeof adminMostUsedQuerySchema>

/** vertice-api's `muscle_groups.name` bound (`VARCHAR(50)`), on the NFC-normalized, trimmed name. */
export const MUSCLE_GROUP_NAME_MAX = 50

/**
 * Body of `POST /admin/muscle-groups` and `PATCH /admin/muscle-groups/:id`. vertice-api normalizes
 * to NFC and trims before it checks 1-50 (D21), so the same steps run here first: a name a Mac
 * keyboard sends decomposed is not refused here for a length upstream would accept.
 */
export const muscleGroupNameSchema = z.object({
  name: z
    .string()
    .transform((value) => value.normalize('NFC').trim())
    .pipe(
      z
        .string()
        .min(1, 'must not be blank')
        .refine(
          (value) => value.length <= MUSCLE_GROUP_NAME_MAX,
          `Too big: expected string to have <=${MUSCLE_GROUP_NAME_MAX} characters`,
        ),
    )
    .meta({ minLength: 1, maxLength: MUSCLE_GROUP_NAME_MAX })
    .describe('Normalized to Unicode NFC and trimmed, then 1-50 characters. Unique ignoring case and accents.'),
}).meta({ id: 'MuscleGroupNameRequest' })
export type MuscleGroupName = z.infer<typeof muscleGroupNameSchema>

// ---- feature flags (feature-flags spec §2.2, FF7, FF8) -------------------------------------------

/** vertice-api's key format (API D4): uppercase snake case, starting with a letter. */
export const FEATURE_FLAG_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/
export const FEATURE_FLAG_KEY_MAX = 64

/** `:key` of the flag routes; checked before any upstream call. */
export const featureFlagKeySchema = z.string().regex(FEATURE_FLAG_KEY_PATTERN).max(FEATURE_FLAG_KEY_MAX)

/**
 * `:userId` of the flag routes: digits only, no leading zero, a safe integer (FF8). `0`, `-1`,
 * `01`, `1e3` and anything past 2^53 − 1 are a 400: a 20-digit number would otherwise lose
 * precision and land on another user. Not checked against any account (R17).
 */
export const featureFlagUserIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .transform(Number)
  .refine(Number.isSafeInteger, 'must be a safe integer')

/**
 * The body of both flag writes: the absolute target state, never a toggle (W4). `.strict()`: an
 * unknown field (a `reason`, a `toggle`) is a 400, so a client can't believe it sent something the
 * BFF dropped. `"true"` (a string) is a 400.
 */
export const featureFlagStateSchema = z.object({ enabled: z.boolean() }).strict()

export type FeatureFlagState = z.infer<typeof featureFlagStateSchema>
