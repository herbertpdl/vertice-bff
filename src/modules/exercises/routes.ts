import type { FastifyInstance } from 'fastify'
import { parseId, parseRequiredId } from '../../lib/net.js'
import { exerciseInputSchema, exerciseListQuerySchema } from './schemas.js'
import * as exerciseService from './service.js'
import { getExerciseProgress } from '../workout-sessions/service.js'
import { assertIsTrainersClient } from '../clients/service.js'

// Exercise visibility (starter set vs. a trainer's private exercises), the starter-set
// refusals and the in-use delete refusal are enforced by vertice-api from the forwarded
// caller identity — deliberately no exercise-ownership helper here (spec D10).
export default async function exerciseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', { preHandler: app.requireRole('TRAINER', 'ADMIN') }, async (req) => {
    const query = exerciseListQuerySchema.parse(req.query)
    return exerciseService.listExercises({ muscleGroupId: query.muscleGroupId, search: query.q })
  })

  // No role gate on purpose: a CLIENT may read an exercise inside one of their own
  // workouts, and only upstream can tell.
  app.get<{ Params: { id: string } }>('/:id', async (req) => exerciseService.getExercise(parseId(req.params.id)))

  app.get<{ Params: { id: string }; Querystring: { clientId?: string } }>(
    '/:id/progress',
    async (req) => {
      const user = req.user!
      const exerciseId = parseId(req.params.id)
      // A CLIENT only ever sees their own history; anyone else must name the client.
      const clientId = user.role === 'CLIENT' ? user.id : parseRequiredId(req.query.clientId, 'clientId')
      if (user.role === 'TRAINER') await assertIsTrainersClient(user.id, clientId)
      return getExerciseProgress(exerciseId, clientId)
    },
  )

  app.post(
    '/',
    { preHandler: app.requireRole('TRAINER') },
    async (req, reply) => {
      const body = exerciseInputSchema.parse(req.body)
      reply.status(201)
      return exerciseService.createExercise(body)
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER') },
    async (req) => {
      const body = exerciseInputSchema.parse(req.body)
      return exerciseService.updateExercise(parseId(req.params.id), body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER') },
    async (req, reply) => {
      await exerciseService.deleteExercise(parseId(req.params.id))
      reply.status(204)
    },
  )
}

/** `GET /muscle-groups` — reference data for any authenticated role. */
export async function muscleGroupRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async () => exerciseService.listMuscleGroups())
}
