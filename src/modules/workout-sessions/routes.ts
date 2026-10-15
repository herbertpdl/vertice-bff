import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { isoDateSchema } from '../../lib/validation.js'
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
import { idParams, idQuery, routeDoc } from '../../openapi/docs.js'
import { setLogSchema, workoutLogSchema, workoutSessionSchema } from '../../openapi/responses.js'

/** Mounted at /api/workouts/:workoutId/session */
export async function workoutSessionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'CLIENT'))

  app.get<{ Params: { workoutId: string }; Querystring: { weekStartDate?: string; clientId?: string } }>(
    '/',
    {
      schema: routeDoc({
        operationId: 'getWorkoutSession',
        summary: 'The “do a workout” screen in one call',
        description:
          'Starts (or resumes) the week’s log and merges in what was recorded last time per set ' +
          '(`lastPerformed`). A CLIENT’s `clientId` is ignored; a TRAINER must pass the client of the workout’s plan.',
        tag: 'Workout sessions',
        roles: ['TRAINER', 'CLIENT'],
        params: idParams('workoutId'),
        query: z.object({
          weekStartDate: isoDateSchema.optional().describe('Defaults to the current week’s Monday.'),
          clientId: idQuery('Required for a TRAINER.'),
        }),
        ok: { status: 200, description: 'The workout, its sets with last results, and the week’s log.', schema: workoutSessionSchema },
        errors: [403, 404],
      }),
    },
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
    {
      schema: routeDoc({
        operationId: 'listWorkoutLogs',
        summary: 'Which workouts were done in a week',
        description:
          'Vertice-api scopes this to one plan and one week, so `trainingPlanId` is required. A CLIENT’s ' +
          '`clientId` is ignored; a TRAINER must pass one of their clients. The plan must belong to that client and to the caller.',
        tag: 'Workout sessions',
        roles: ['TRAINER', 'CLIENT'],
        query: z.object({
          trainingPlanId: z.number().int().positive().describe('Required.'),
          weekStartDate: isoDateSchema.optional().describe('Defaults to the current week’s Monday.'),
          clientId: idQuery('Required for a TRAINER.'),
        }),
        ok: { status: 200, description: 'The logs of that week.', schema: z.array(workoutLogSchema) },
        errors: [403, 404],
      }),
    },
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

  app.post<{ Params: { workoutLogId: string } }>(
    '/:workoutLogId/sets',
    {
      schema: routeDoc({
        operationId: 'recordSetLog',
        summary: 'Record one set’s actual performance',
        description:
          'On their own log. `exerciseSetId` must be a set of the log’s workout; a missing set gets the same 400, ' +
          'so the answer never tells “someone else’s set” from “no such set”.',
        tag: 'Workout sessions',
        roles: ['CLIENT'],
        params: idParams('workoutLogId'),
        body: recordSetLogSchema,
        ok: { status: 201, description: 'The set log.', schema: setLogSchema },
        errors: [403, 404, 409],
      }),
    },
    async (req, reply) => {
      const workoutLogId = parseId(req.params.workoutLogId)
      const log = await assertOwnsWorkoutLog(req.user!, workoutLogId)
      const body = recordSetLogSchema.parse(req.body)
      await assertExerciseSetInWorkout(body.exerciseSetId, log.workoutId)
      reply.status(201)
      return sessionService.recordSetLog(workoutLogId, body.exerciseSetId, body.weight, body.reps)
    },
  )

  app.post<{ Params: { workoutLogId: string } }>(
    '/:workoutLogId/complete',
    {
      schema: routeDoc({
        operationId: 'completeWorkoutLog',
        summary: 'Mark a workout log done',
        description: 'On their own log.',
        tag: 'Workout sessions',
        roles: ['CLIENT'],
        params: idParams('workoutLogId'),
        ok: { status: 200, description: 'The completed log.', schema: workoutLogSchema },
        errors: [403, 404],
      }),
    },
    async (req) => {
      const workoutLogId = parseId(req.params.workoutLogId)
      await assertOwnsWorkoutLog(req.user!, workoutLogId)
      return sessionService.completeWorkoutLog(workoutLogId)
    },
  )
}
