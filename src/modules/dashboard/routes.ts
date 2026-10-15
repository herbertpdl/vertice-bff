import type { FastifyInstance } from 'fastify'
import * as dashboardService from './service.js'
import { routeDoc } from '../../openapi/docs.js'
import { dashboardSchema } from '../../openapi/responses.js'

export default async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER'))

  app.get(
    '/',
    {
      schema: routeDoc({
        operationId: 'getDashboard',
        summary: 'The trainer dashboard',
        description: 'Stat tiles, recent feedback, plans nearing their end and workouts completed today, in one call.',
        tag: 'Dashboard',
        roles: ['TRAINER'],
        ok: { status: 200, description: 'The dashboard.', schema: dashboardSchema },
        errors: [403],
      }),
    },
    async (req) => dashboardService.getTrainerDashboard(req.user!.id),
  )
}
