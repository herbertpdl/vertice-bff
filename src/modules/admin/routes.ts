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
  adminUserResultSchema,
} from '../../openapi/responses.js'
import {
  ADMIN_ACTIONS,
  ADMIN_CURSOR_MAX,
  ADMIN_PAGE_SIZES,
  ADMIN_SEARCH_MAX,
  adminActionsQuerySchema,
  adminDirectoryQuerySchema,
  adminReasonSchema,
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
 * VRT-28: suspension, account e-mails and ending a relationship (spec §2.3), each with an
 * `audit: "admin.<action>"` line (actor and target ids; never the reason, B15).
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

  for (const [action, suspend] of [
    ['suspend', true],
    ['reactivate', false],
  ] as const) {
    app.post<{ Params: { id: string } }>(
      `/users/:id/${action}`,
      {
        schema: routeDoc({
          operationId: suspend ? 'suspendAdminUser' : 'reactivateAdminUser',
          summary: suspend ? 'Suspend a trainer or client' : 'Reactivate a suspended trainer or client',
          description: suspend
            ? 'Every session of the user ends at their next request (401 `UNAUTHENTICATED`) and their sign-in answers ' +
              '403 `ACCOUNT_SUSPENDED` until reactivated. Their data, plans and roster are untouched; no e-mail is sent. ' +
              'Writes a `SUSPEND_USER` history entry with the reason. Already suspended: 409 `PRECONDITION_FAILED` ' +
              '(refetch the profile). A missing or deleted user, or an admin, is 404.'
            : 'The user can sign in again; sessions from before the suspension stay void. No e-mail is sent. Writes a ' +
              '`REACTIVATE_USER` history entry with the reason. Not suspended: 409 `PRECONDITION_FAILED` (refetch the ' +
              'profile). A missing or deleted user, or an admin, is 404.',
          tag: 'Admin',
          roles: ['ADMIN'],
          params: idParams('id'),
          body: adminReasonSchema,
          ok: { status: 200, description: 'The user’s directory row after the change.', schema: adminUserResultSchema },
          errors: [403, 404, 409],
        }),
      },
      async (req) => {
        const id = parseId(req.params.id)
        const { reason } = adminReasonSchema.parse(req.body)
        const result = await adminService.setSuspended(id, suspend, reason)
        req.log.info({ audit: `admin.user.${action}`, actorId: req.user!.id, targetUserId: id }, `User ${action}d by an admin`)
        return result
      },
    )
  }

  for (const [path, operationId, kind] of [
    ['first-access-email', 'sendAdminFirstAccessEmail', 'first_access_email'],
    ['password-reset-email', 'sendAdminPasswordResetEmail', 'password_reset_email'],
  ] as const) {
    const firstAccess = kind === 'first_access_email'
    app.post<{ Params: { id: string } }>(
      `/users/:id/${path}`,
      {
        schema: routeDoc({
          operationId,
          summary: firstAccess
            ? 'E-mail a client a new first-access link'
            : 'E-mail a trainer or client a password-reset link',
          description:
            (firstAccess
              ? 'For a client: a new single-use link to choose their password. A trainer, a missing or a deleted user is 404. '
              : 'A single-use link to the “Definir senha” page; redeeming it sets the password and ends every session. ' +
                'A missing or deleted user, or an admin, is 404. ') +
            'No body. 204 on an accepted send: the link never reaches the admin. Limits per user: 1 per minute and 5 per ' +
            '24 hours, 429 `RATE_LIMITED` with `Retry-After`. While e-mails are switched off upstream, 409 ' +
            '`PRECONDITION_FAILED` (“envio indisponível”); when every send attempt failed, 503 `UPSTREAM_UNAVAILABLE` ' +
            '(try again later). Writes a history entry only for an accepted send.',
          tag: 'Admin',
          roles: ['ADMIN'],
          params: idParams('id'),
          ok: { status: 204, description: 'The e-mail was accepted for sending.' },
          errors: [403, 404, 409, 429],
        }),
      },
      async (req, reply) => {
        const id = parseId(req.params.id)
        await (firstAccess ? adminService.sendFirstAccessEmail(id) : adminService.sendPasswordResetEmail(id))
        req.log.info({ audit: `admin.user.${kind}`, actorId: req.user!.id, targetUserId: id }, 'Account e-mail sent by an admin')
        reply.status(204)
      },
    )
  }

  app.delete<{ Params: { trainerId: string; clientId: string } }>(
    '/relationships/:trainerId/:clientId',
    {
      schema: routeDoc({
        operationId: 'endAdminRelationship',
        summary: 'End a trainer–client relationship',
        description:
          'Both ids, from the profile on screen. Only the relationship ends: both accounts, the plans and every log stay; ' +
          'the trainer loses access to the client, the client keeps reading the plans. Writes an `END_RELATIONSHIP` ' +
          'history entry. No active relationship for the pair is 404.',
        tag: 'Admin',
        roles: ['ADMIN'],
        params: idParams('trainerId', 'clientId'),
        ok: { status: 204, description: 'The relationship ended.' },
        errors: [403, 404],
      }),
    },
    async (req, reply) => {
      const trainerId = parseId(req.params.trainerId)
      const clientId = parseId(req.params.clientId)
      await adminService.endRelationship(trainerId, clientId)
      req.log.info(
        { audit: 'admin.relationship.end', actorId: req.user!.id, trainerId, clientId },
        'Relationship ended by an admin',
      )
      reply.status(204)
    },
  )
}
