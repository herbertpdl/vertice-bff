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
