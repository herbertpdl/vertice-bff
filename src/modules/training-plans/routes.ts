import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { assertOwnsPlan } from '../../lib/ownership.js'
import { trainingPlanInputSchema } from './schemas.js'
import * as planService from './service.js'
import * as workoutService from '../workouts/service.js'

export default async function trainingPlanRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.get<{ Querystring: { clientId?: string } }>('/', async (req) => {
    const user = req.user!
    if (user.role === 'CLIENT') return planService.listTrainingPlans({ clientId: user.id })
    if (user.role === 'TRAINER') {
      return planService.listTrainingPlans({
        trainerId: user.id,
        clientId: req.query.clientId ? Number(req.query.clientId) : undefined,
      })
    }
    return planService.listTrainingPlans({})
  })

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const plan = await planService.getTrainingPlan(parseId(req.params.id))
    assertOwnsPlan(req.user!, plan)
    const workouts = await workoutService.listWorkouts(plan.id)
    return { ...plan, workouts }
  })

  app.post(
    '/',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req, reply) => {
      const body = trainingPlanInputSchema.parse(req.body)
      reply.status(201)
      return planService.createTrainingPlan(req.user!.id, body)
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req) => {
      const existing = await planService.getTrainingPlan(parseId(req.params.id))
      assertOwnsPlan(req.user!, existing)
      const body = trainingPlanInputSchema.parse(req.body)
      return planService.updateTrainingPlan(existing.id, body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req, reply) => {
      const existing = await planService.getTrainingPlan(parseId(req.params.id))
      assertOwnsPlan(req.user!, existing)
      await planService.deleteTrainingPlan(existing.id)
      reply.status(204)
    },
  )
}
