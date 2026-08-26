import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { submitFeedbackSchema } from './schemas.js'
import * as feedbackService from './service.js'

/** Mounted at /api/workout-logs/:workoutLogId/feedback */
export async function submitFeedbackRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('CLIENT'))

  app.post<{ Params: { workoutLogId: string } }>('/', async (req, reply) => {
    const body = submitFeedbackSchema.parse(req.body)
    reply.status(201)
    return feedbackService.submitWorkoutFeedback(parseId(req.params.workoutLogId), body.text)
  })
}

/** Mounted at /api/feedback */
export async function feedbackRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'ADMIN'))

  app.get('/', async (req) => feedbackService.listWorkoutFeedbackEnriched(req.user!.id))
}
