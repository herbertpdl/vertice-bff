import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { exerciseInputSchema } from './schemas.js'
import * as exerciseService from './service.js'
import { getExerciseProgress } from '../workout-sessions/service.js'

export default async function exerciseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async () => exerciseService.listExercises())

  app.get<{ Params: { id: string } }>('/:id', async (req) => exerciseService.getExercise(parseId(req.params.id)))

  app.get<{ Params: { id: string }; Querystring: { clientId?: string } }>(
    '/:id/progress',
    async (req) => {
      const clientId = req.user!.role === 'CLIENT' ? req.user!.id : Number(req.query.clientId)
      return getExerciseProgress(parseId(req.params.id), clientId)
    },
  )

  app.post(
    '/',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req, reply) => {
      const body = exerciseInputSchema.parse(req.body)
      reply.status(201)
      return exerciseService.createExercise(body)
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req) => {
      const body = exerciseInputSchema.parse(req.body)
      return exerciseService.updateExercise(parseId(req.params.id), body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req, reply) => {
      await exerciseService.deleteExercise(parseId(req.params.id))
      reply.status(204)
    },
  )
}
