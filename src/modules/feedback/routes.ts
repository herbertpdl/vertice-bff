import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseId } from '../../lib/net.js'
import { assertOwnsWorkoutLog } from '../../lib/ownership.js'
import { submitFeedbackSchema } from './schemas.js'
import * as feedbackService from './service.js'
import { idParams, routeDoc } from '../../openapi/docs.js'
import { enrichedFeedbackSchema, workoutFeedbackSchema } from '../../openapi/responses.js'

/** Mounted at /api/workout-logs/:workoutLogId/feedback */
export async function submitFeedbackRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('CLIENT'))

  app.post<{ Params: { workoutLogId: string } }>(
    '/',
    {
      schema: routeDoc({
        operationId: 'submitWorkoutFeedback',
        summary: 'Send feedback on a workout log',
        description: 'On their own log. 409 unless the session is completed, or when it was finished automatically (no feedback then).',
        tag: 'Feedback',
        roles: ['CLIENT'],
        params: idParams('workoutLogId'),
        body: submitFeedbackSchema,
        ok: { status: 201, description: 'The feedback.', schema: workoutFeedbackSchema },
        errors: [403, 404, 409],
      }),
    },
    async (req, reply) => {
      const workoutLogId = parseId(req.params.workoutLogId)
      // Parse before the ownership lookup: a missing rating or an oversized text is refused without an upstream call.
      const body = submitFeedbackSchema.parse(req.body)
      await assertOwnsWorkoutLog(req.user!, workoutLogId)
      reply.status(201)
      return feedbackService.submitWorkoutFeedback(workoutLogId, body.rating, body.text, body.clientKey)
    },
  )
}

/** Mounted at /api/feedback */
export async function feedbackRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER'))

  app.get(
    '/',
    {
      schema: routeDoc({
        operationId: 'listFeedback',
        summary: 'The trainer’s feedback, newest first',
        description: 'Not scoped to one client: filter by `clientId` client-side.',
        tag: 'Feedback',
        roles: ['TRAINER'],
        ok: { status: 200, description: 'Feedback with client, workout and plan names.', schema: z.array(enrichedFeedbackSchema) },
        errors: [403],
      }),
    },
    async (req) => feedbackService.listWorkoutFeedbackEnriched(req.user!.id),
  )
}
