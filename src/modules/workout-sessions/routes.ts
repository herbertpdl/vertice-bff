import type { FastifyInstance } from 'fastify'
import { parseId, requireQueryId } from '../../lib/net.js'
import {
  assertExerciseSetInWorkout,
  assertOwnsPlan,
  assertOwnsWorkout,
  assertOwnsWorkoutLog,
  assertPlanBelongsToClient,
} from '../../lib/ownership.js'
import { currentWeekStartDate } from '../../lib/dates.js'
import { recordSetLogSchema, weekStartDateQuerySchema, workoutLogListQuerySchema } from './schemas.js'
import * as sessionService from './service.js'
import * as planService from '../training-plans/service.js'
import { assertIsTrainersClient } from '../clients/service.js'

/** Mounted at /api/workouts/:workoutId/session */
export async function workoutSessionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'CLIENT'))

  app.get<{ Params: { workoutId: string }; Querystring: { weekStartDate?: string; clientId?: string } }>(
    '/',
    async (req) => {
      const workoutId = parseId(req.params.workoutId)
      const user = req.user!
      const query = weekStartDateQuerySchema.parse(req.query)
      const clientId = user.role === 'CLIENT' ? user.id : requireQueryId(query.clientId, 'clientId')

      const plan = await assertOwnsWorkout(user, workoutId)
      // assertOwnsWorkout already confirmed the plan is the caller's; for a TRAINER the
      // requested client must also be that plan's (a CLIENT's clientId is their own).
      assertPlanBelongsToClient(plan, clientId)

      const weekStartDate = query.weekStartDate ?? currentWeekStartDate()
      return sessionService.getWorkoutSession(workoutId, clientId, weekStartDate)
    },
  )
}

/** Mounted at /api/workout-logs */
export async function workoutLogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'CLIENT'))

  app.get<{ Querystring: { trainingPlanId?: string; weekStartDate?: string; clientId?: string } }>(
    '/',
    async (req) => {
      const user = req.user!
      const query = workoutLogListQuerySchema.parse(req.query)
      const clientId = user.role === 'CLIENT' ? user.id : requireQueryId(query.clientId, 'clientId')
      const trainingPlanId = requireQueryId(query.trainingPlanId, 'trainingPlanId')

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
        weekStartDate: query.weekStartDate ?? currentWeekStartDate(),
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
