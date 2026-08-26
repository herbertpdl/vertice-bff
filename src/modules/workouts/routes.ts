import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { assertOwnsPlan, assertOwnsWorkout } from '../../lib/ownership.js'
import { workoutInputSchema, cloneWorkoutSchema } from './schemas.js'
import * as workoutService from './service.js'
import * as planService from '../training-plans/service.js'

/** Mounted at /api/training-plans/:planId/workouts */
export async function workoutsUnderPlanRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.get<{ Params: { planId: string } }>('/', async (req) => {
    const plan = await planService.getTrainingPlan(parseId(req.params.planId))
    assertOwnsPlan(req.user!, plan)
    return workoutService.listWorkouts(plan.id)
  })

  app.post<{ Params: { planId: string } }>(
    '/',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req, reply) => {
      const plan = await planService.getTrainingPlan(parseId(req.params.planId))
      assertOwnsPlan(req.user!, plan)
      const body = workoutInputSchema.parse(req.body)
      reply.status(201)
      return workoutService.createWorkout(plan.id, body)
    },
  )
}

/** Mounted at /api/workouts */
export async function workoutRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const id = parseId(req.params.id)
    await assertOwnsWorkout(req.user!, id)
    return workoutService.getWorkout(id)
  })

  app.get<{ Params: { id: string } }>('/:id/full', async (req) => {
    const id = parseId(req.params.id)
    await assertOwnsWorkout(req.user!, id)
    return workoutService.getFullWorkout(id)
  })

  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req) => {
      const id = parseId(req.params.id)
      await assertOwnsWorkout(req.user!, id)
      const body = workoutInputSchema.parse(req.body)
      return workoutService.updateWorkout(id, body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req, reply) => {
      const id = parseId(req.params.id)
      await assertOwnsWorkout(req.user!, id)
      await workoutService.deleteWorkout(id)
      reply.status(204)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/:id/clone',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req, reply) => {
      const id = parseId(req.params.id)
      await assertOwnsWorkout(req.user!, id)
      const body = cloneWorkoutSchema.parse(req.body)
      const targetPlan = await planService.getTrainingPlan(body.targetTrainingPlanId)
      assertOwnsPlan(req.user!, targetPlan)
      reply.status(201)
      return workoutService.cloneWorkout(id, body)
    },
  )
}
