import type { FastifyInstance } from 'fastify'
import * as dashboardService from './service.js'

export default async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'ADMIN'))

  app.get('/', async (req) => dashboardService.getTrainerDashboard(req.user!.id))
}
