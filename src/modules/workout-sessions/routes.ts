import type { FastifyInstance } from 'fastify'
import { parseId, parseRequiredId } from '../../lib/net.js'
import { ForbiddenError } from '../../lib/errors.js'
import {
  assertExerciseSetInWorkout,
  assertOwnsPlan,
  assertOwnsWorkout,
  assertOwnsWorkoutLog,
  assertPlanBelongsToClient,
} from '../../lib/ownership.js'
import { currentWeekStartDate } from '../../lib/dates.js'
import { recordSetLogSchema } from './schemas.js'
import * as sessionService from './service.js'
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
      const clientId = user.role === 'CLIENT' ? user.id : parseRequiredId(req.query.clientId, 'clientId')

      const plan = await assertOwnsWorkout(user, workoutId)
      if (user.role === 'TRAINER') {
        // assertOwnsWorkout already confirmed the plan belongs to this trainer;
        // the requested client must also belong to that same plan.
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
      const clientId = user.role === 'CLIENT' ? user.id : parseRequiredId(req.query.clientId, 'clientId')
      const trainingPlanId = parseRequiredId(req.query.trainingPlanId, 'trainingPlanId')

      if (user.role === 'TRAINER') {
        await assertIsTrainersClient(user.id, clientId)
      }
      // The plan must be the caller's and must belong to the requested client, so a
      // trainer cannot read their client's logs under a plan another trainer wrote.
      const plan = await planService.getTrainingPlan(trainingPlanId)
      assertOwnsPlan(user, plan)
      assertPlanBelongsToClient(plan, clientId)

      return sessionService.listWorkoutLogs({
        clientId,
        trainingPlanId,
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
    const log = await assertOwnsWorkoutLog(req.user!, workoutLogId)
    const body = recordSetLogSchema.parse(req.body)
    await assertExerciseSetInWorkout(body.exerciseSetId, log.workoutId)
    reply.status(201)
    return sessionService.recordSetLog(workoutLogId, body.exerciseSetId, body.weight, body.reps)
  })

  app.post<{ Params: { workoutLogId: string } }>('/:workoutLogId/complete', async (req) => {
    const workoutLogId = parseId(req.params.workoutLogId)
    await assertOwnsWorkoutLog(req.user!, workoutLogId)
    return sessionService.completeWorkoutLog(workoutLogId)
  })
}
