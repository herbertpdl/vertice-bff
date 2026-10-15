import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseId } from '../../lib/net.js'
import { assertOwnsPlan } from '../../lib/ownership.js'
import { trainingPlanInputSchema, trainingPlanListQuerySchema, trainingPlanUpdateSchema } from './schemas.js'
import * as planService from './service.js'
import * as workoutService from '../workouts/service.js'
import { assertIsTrainersClient } from '../clients/service.js'
import { idParams, idQuery, routeDoc } from '../../openapi/docs.js'
import { trainingPlanDetailSchema, trainingPlanSchema } from '../../openapi/responses.js'

export default async function trainingPlanRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  // A plan is always one trainer's and one client's. ADMIN has no defined product yet (P1-02),
  // so it gets a 403 here instead of the cross-tenant bypass it used to have.
  app.addHook('preHandler', app.requireRole('TRAINER', 'CLIENT'))

  app.get<{ Querystring: { clientId?: string } }>(
    '/',
    {
      schema: routeDoc({
        operationId: 'listTrainingPlans',
        summary: 'List training plans',
        description:
          'A CLIENT gets their own plans (`clientId` is ignored); a TRAINER their own, optionally ' +
          'filtered by `clientId`.',
        tag: 'Training plans',
        roles: ['TRAINER', 'CLIENT'],
        query: z.object({ clientId: idQuery('A TRAINER’s filter.') }),
        ok: { status: 200, description: 'The plans.', schema: z.array(trainingPlanSchema) },
        errors: [403],
      }),
    },
    async (req) => {
      const user = req.user!
      if (user.role === 'CLIENT') return planService.listTrainingPlans({ clientId: user.id })
      const { clientId } = trainingPlanListQuerySchema.parse(req.query)
      return planService.listTrainingPlans({ trainerId: user.id, clientId })
    },
  )

  app.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: routeDoc({
        operationId: 'getTrainingPlan',
        summary: 'A training plan with its workouts',
        description: 'On their own plan.',
        tag: 'Training plans',
        roles: ['TRAINER', 'CLIENT'],
        params: idParams('id'),
        ok: { status: 200, description: 'The plan and its workouts.', schema: trainingPlanDetailSchema },
        errors: [403, 404],
      }),
    },
    async (req) => {
      const plan = await planService.getTrainingPlan(parseId(req.params.id))
      assertOwnsPlan(req.user!, plan)
      const workouts = await workoutService.listWorkouts(plan.id)
      return { ...plan, workouts }
    },
  )

  app.post(
    '/',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'createTrainingPlan',
        summary: 'Create a training plan',
        description:
          'For one of their clients (403 otherwise). vertice-api also requires an active trainer-client ' +
          'link: without one it is 409 `PRECONDITION_FAILED`.',
        tag: 'Training plans',
        roles: ['TRAINER'],
        body: trainingPlanInputSchema,
        ok: { status: 201, description: 'The plan.', schema: trainingPlanSchema },
        errors: [403, 409],
      }),
    },
    async (req, reply) => {
      const body = trainingPlanInputSchema.parse(req.body)
      await assertIsTrainersClient(req.user!.id, body.clientId)
      reply.status(201)
      return planService.createTrainingPlan(req.user!.id, body)
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'updateTrainingPlan',
        summary: 'Update a training plan',
        description: 'Your own plan. A plan’s client is fixed at creation: a `clientId` in the body is ignored.',
        tag: 'Training plans',
        roles: ['TRAINER'],
        params: idParams('id'),
        body: trainingPlanUpdateSchema,
        ok: { status: 200, description: 'The plan.', schema: trainingPlanSchema },
        errors: [403, 404],
      }),
    },
    async (req) => {
      const existing = await planService.getTrainingPlan(parseId(req.params.id))
      assertOwnsPlan(req.user!, existing)
      const body = trainingPlanUpdateSchema.parse(req.body)
      return planService.updateTrainingPlan(existing.id, { ...body, clientId: existing.clientId })
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'deleteTrainingPlan',
        summary: 'Delete a training plan',
        description: 'Your own plan. 409 `PRECONDITION_FAILED` once a client recorded training under it.',
        tag: 'Training plans',
        roles: ['TRAINER'],
        params: idParams('id'),
        ok: { status: 204, description: 'Deleted; no body.' },
        errors: [403, 404, 409],
      }),
    },
    async (req, reply) => {
      const existing = await planService.getTrainingPlan(parseId(req.params.id))
      assertOwnsPlan(req.user!, existing)
      await planService.deleteTrainingPlan(existing.id)
      reply.status(204)
    },
  )
}
