import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { assertOwnsWorkoutLog } from '../../lib/ownership.js'
import { submitFeedbackSchema } from './schemas.js'
import * as feedbackService from './service.js'

/** Mounted at /api/workout-logs/:workoutLogId/feedback */
export async function submitFeedbackRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('CLIENT'))

  app.post<{ Params: { workoutLogId: string } }>('/', async (req, reply) => {
    const workoutLogId = parseId(req.params.workoutLogId)
    await assertOwnsWorkoutLog(req.user!, workoutLogId)
    const body = submitFeedbackSchema.parse(req.body)
    reply.status(201)
    return feedbackService.submitWorkoutFeedback(workoutLogId, body.text)
  })
}

/** Mounted at /api/feedback */
export async function feedbackRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER'))

  app.get('/', async (req) => feedbackService.listWorkoutFeedbackEnriched(req.user!.id))
}
