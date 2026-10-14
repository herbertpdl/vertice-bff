import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { assertOwnsPlan } from '../../lib/ownership.js'
import { trainingPlanInputSchema, trainingPlanUpdateSchema } from './schemas.js'
import * as planService from './service.js'
import * as workoutService from '../workouts/service.js'
import { assertIsTrainersClient } from '../clients/service.js'

export default async function trainingPlanRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  // A plan is always one trainer's and one client's. ADMIN has no defined product yet (P1-02),
  // so it gets a 403 here instead of the cross-tenant bypass it used to have.
  app.addHook('preHandler', app.requireRole('TRAINER', 'CLIENT'))

  app.get<{ Querystring: { clientId?: string } }>('/', async (req) => {
    const user = req.user!
    if (user.role === 'CLIENT') return planService.listTrainingPlans({ clientId: user.id })
    return planService.listTrainingPlans({
      trainerId: user.id,
      clientId: req.query.clientId ? Number(req.query.clientId) : undefined,
    })
  })

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const plan = await planService.getTrainingPlan(parseId(req.params.id))
    assertOwnsPlan(req.user!, plan)
    const workouts = await workoutService.listWorkouts(plan.id)
    return { ...plan, workouts }
  })

  app.post(
    '/',
    { preHandler: app.requireRole('TRAINER') },
    async (req, reply) => {
      const body = trainingPlanInputSchema.parse(req.body)
      await assertIsTrainersClient(req.user!.id, body.clientId)
      reply.status(201)
      return planService.createTrainingPlan(req.user!.id, body)
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER') },
    async (req) => {
      const existing = await planService.getTrainingPlan(parseId(req.params.id))
      assertOwnsPlan(req.user!, existing)
      const body = trainingPlanUpdateSchema.parse(req.body)
      return planService.updateTrainingPlan(existing.id, { ...body, clientId: existing.clientId })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER') },
    async (req, reply) => {
      const existing = await planService.getTrainingPlan(parseId(req.params.id))
      assertOwnsPlan(req.user!, existing)
      await planService.deleteTrainingPlan(existing.id)
      reply.status(204)
    },
  )
}
