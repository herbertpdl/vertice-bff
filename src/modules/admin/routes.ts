import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseId } from '../../lib/net.js'
import { idParams, idQuery, routeDoc } from '../../openapi/docs.js'
import {
  adminActionAdminsSchema,
  adminActionPageSchema,
  adminDashboardSchema,
  adminDirectoryPageSchema,
  adminUserProfileSchema,
} from '../../openapi/responses.js'
import {
  ADMIN_ACTIONS,
  ADMIN_CURSOR_MAX,
  ADMIN_PAGE_SIZES,
  ADMIN_SEARCH_MAX,
  adminActionsQuerySchema,
  adminDirectoryQuerySchema,
  DIRECTORY_ROLES,
  DIRECTORY_STATUSES,
} from './schemas.js'
import * as adminService from './service.js'

// Documentation of the shared paging query (B12); the handlers parse with `./schemas.ts`.
const limitDoc = z
  .union(ADMIN_PAGE_SIZES.map((n) => z.literal(n)))
  .optional()
  .describe('Page size: 10, 25 or 50; 25 when absent. Anything else is a 400.')
const cursorDoc = z
  .string()
  .max(ADMIN_CURSOR_MAX)
  .optional()
  .describe('`nextCursor` of the previous page, sent with the same filters. Opaque; a malformed one is a 400.')

/**
 * The admin panel's routes, at `/api/admin` (admin-panel spec B7). The two hooks are the plugin's,
 * not each route's, so no route can be registered here without them: every route under it is
 * ADMIN-only, and a TRAINER or CLIENT token is a 403 by role before any upstream call (pinned in
 * `route-authorization.test.ts`). Admin sign-in (`/api/admin/auth`) is a sibling plugin, so its
 * public steps are not behind these hooks.
 *
 * VRT-24: the read routes (spec §2.2), one `AdminService` RPC each, with the caller's admin token.
 * vertice-api re-checks ADMIN and the second-factor claims (D6) on every call.
 */
export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('ADMIN'))

  app.get(
    '/dashboard',
    {
      schema: routeDoc({
        operationId: 'getAdminDashboard',
        summary: 'The admin dashboard',
        description:
          'Totals, 7- and 30-day activity, completed workouts and 12 weeks of sign-ups, in one upstream call. ' +
          'Windows are business days in America/Sao_Paulo ("7 days" is today and the 6 before). Admins are never ' +
          'counted; suspended accounts are.',
        tag: 'Admin',
        roles: ['ADMIN'],
        ok: { status: 200, description: 'The dashboard figures.', schema: adminDashboardSchema },
        errors: [403],
      }),
    },
    async () => adminService.getDashboard(),
  )

  app.get(
    '/users',
    {
      schema: routeDoc({
        operationId: 'listAdminUsers',
        summary: 'One page of the user directory',
        description:
          'Trainers and clients (never admins), ordered by name then id, in upstream order: do not re-sort ' +
          'client-side. Empty `role`, `status` or `q` means no filter. Follow `nextCursor` with the same filters.',
        tag: 'Admin',
        roles: ['ADMIN'],
        query: z.object({
          role: z.enum(DIRECTORY_ROLES).optional().describe('Absent: trainers and clients.'),
          status: z.enum(DIRECTORY_STATUSES).optional().describe('Absent: active and suspended.'),
          q: z
            .string()
            .max(ADMIN_SEARCH_MAX)
            .optional()
            .describe('Case-insensitive substring of the name or e-mail, trimmed; at most 100 characters.'),
          limit: limitDoc,
          cursor: cursorDoc,
        }),
        ok: { status: 200, description: 'One page of users.', schema: adminDirectoryPageSchema },
        errors: [403],
      }),
    },
    async (req) => adminService.listDirectoryUsers(adminDirectoryQuerySchema.parse(req.query)),
  )

  app.get<{ Params: { id: string } }>(
    '/users/:id',
    {
      schema: routeDoc({
        operationId: 'getAdminUserProfile',
        summary: 'A trainer’s or client’s profile',
        description:
          'A union on `role`: `AdminTrainerProfile` or `AdminClientProfile`. The CPF is masked (`***.***.***-NN`) ' +
          'or null, never in full; no logs, weights, feedback or plan contents. **Not a pure read:** every call ' +
          'writes a `VIEW_USER_PROFILE` entry to the action history, so fetch it once per screen visit — never ' +
          'refetch it on focus, poll it or prefetch it. The response is `Cache-Control: no-store`. A missing or ' +
          'deleted user, or an admin (yourself included), is 404.',
        tag: 'Admin',
        roles: ['ADMIN'],
        params: idParams('id'),
        ok: { status: 200, description: 'The profile.', schema: adminUserProfileSchema },
        errors: [403, 404],
      }),
    },
    async (req) => adminService.getUserProfile(parseId(req.params.id)),
  )

  app.get(
    '/actions',
    {
      schema: routeDoc({
        operationId: 'listAdminActions',
        summary: 'One page of the admin action history',
        description:
          'Every admin’s actions, newest first. Empty filters mean any. Follow `nextCursor` with the same filters.',
        tag: 'Admin',
        roles: ['ADMIN'],
        query: z.object({
          adminId: idQuery('Entries by this admin (see `GET /api/admin/actions/admins`).'),
          action: z.enum(ADMIN_ACTIONS).optional().describe('Entries of this action only.'),
          targetUserId: idQuery('Entries about this user (deleted accounts included).'),
          limit: limitDoc,
          cursor: cursorDoc,
        }),
        ok: { status: 200, description: 'One page of history entries.', schema: adminActionPageSchema },
        errors: [403],
      }),
    },
    async (req) => adminService.listActions(adminActionsQuerySchema.parse(req.query)),
  )

  app.get(
    '/actions/admins',
    {
      schema: routeDoc({
        operationId: 'listAdminActionAdmins',
        summary: 'Admins that appear in the action history',
        description: 'Authors of at least one history entry, by name: the options of the history’s admin filter.',
        tag: 'Admin',
        roles: ['ADMIN'],
        ok: { status: 200, description: 'The admins.', schema: adminActionAdminsSchema },
        errors: [403],
      }),
    },
    async () => adminService.listActionAdmins(),
  )
}
