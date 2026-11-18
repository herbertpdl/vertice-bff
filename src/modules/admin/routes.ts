import type { FastifyInstance } from 'fastify'

/**
 * The admin panel's routes, at `/api/admin` (admin-panel spec B7). The two hooks are the plugin's,
 * not each route's, so no route can be registered here without them: every route under it is
 * ADMIN-only, and a TRAINER or CLIENT token is a 403 by role before any upstream call (pinned in
 * `route-authorization.test.ts`). Admin sign-in (`/api/admin/auth`) is a sibling plugin, so its
 * public steps are not behind these hooks. The read routes arrive in VRT-24.
 */
export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('ADMIN'))
}
