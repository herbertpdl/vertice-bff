import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { ForbiddenError, ValidationError } from '../../lib/errors.js'
import { assertOwnsWorkout } from '../../lib/ownership.js'
import { currentWeekStartDate } from '../../lib/dates.js'
import { recordSetLogSchema } from './schemas.js'
import * as sessionService from './service.js'
import * as workoutService from '../workouts/service.js'
import * as planService from '../training-plans/service.js'
import { assertIsTrainersClient } from '../clients/service.js'

/** Mounted at /api/workouts/:workoutId/session */
export async function workoutSessionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.get<{ Params: { workoutId: string }; Querystring: { weekStartDate?: string; clientId?: string } }>(
    '/',
    async (req) => {
      const workoutId = parseId(req.params.workoutId)
      const user = req.user!
      const clientId = user.role === 'CLIENT' ? user.id : Number(req.query.clientId)
      if (!clientId) throw new ValidationError('clientId is required for trainers')

      await assertOwnsWorkout(user, workoutId)
      if (user.role === 'TRAINER') {
        // assertOwnsWorkout already confirmed the plan belongs to this trainer;
        // the requested client must also belong to that same plan.
        const workout = await workoutService.getWorkout(workoutId)
        const plan = await planService.getTrainingPlan(workout.trainingPlanId)
        if (plan.clientId !== clientId) throw new ForbiddenError('That client is not assigned to this workout')
      }

      const weekStartDate = req.query.weekStartDate ?? currentWeekStartDate()
      return sessionService.getWorkoutSession(workoutId, clientId, weekStartDate)
    },
  )
}

/** Mounted at /api/workout-logs */
export async function workoutLogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.get<{ Querystring: { trainingPlanId?: string; weekStartDate?: string; clientId?: string } }>(
    '/',
    async (req) => {
      const user = req.user!
      const clientId = user.role === 'CLIENT' ? user.id : Number(req.query.clientId)
      if (!clientId) throw new ValidationError('clientId is required for trainers')
      if (!req.query.trainingPlanId) throw new ValidationError('trainingPlanId is required')

      if (user.role === 'TRAINER') {
        await assertIsTrainersClient(user.id, clientId)
      }

      return sessionService.listWorkoutLogs({
        clientId,
        trainingPlanId: Number(req.query.trainingPlanId),
        weekStartDate: req.query.weekStartDate ?? currentWeekStartDate(),
      })
    },
  )
}

/** Mounted at /api/workout-sessions */
export async function workoutSessionActionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('CLIENT'))

  app.post<{ Params: { workoutLogId: string } }>('/:workoutLogId/sets', async (req, reply) => {
    const workoutLogId = parseId(req.params.workoutLogId)
    const body = recordSetLogSchema.parse(req.body)
    reply.status(201)
    return sessionService.recordSetLog(workoutLogId, body.exerciseSetId, body.weight, body.reps)
  })

  app.post<{ Params: { workoutLogId: string } }>('/:workoutLogId/complete', async (req) => {
    return sessionService.completeWorkoutLog(parseId(req.params.workoutLogId))
  })
}
