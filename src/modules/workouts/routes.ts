import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseId } from '../../lib/net.js'
import { assertCanUseExercises, assertOwnsPlan, assertOwnsWorkout } from '../../lib/ownership.js'
import { workoutInputSchema, workoutCreateSchema, cloneWorkoutSchema, workoutListQuerySchema } from './schemas.js'
import * as workoutService from './service.js'
import * as planService from '../training-plans/service.js'
import { idParams, routeDoc } from '../../openapi/docs.js'
import { fullWorkoutSchema, recentWorkoutSummarySchema, workoutSchema } from '../../openapi/responses.js'

/** Mounted at /api/training-plans/:planId/workouts */
export async function workoutsUnderPlanRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'CLIENT'))

  app.get<{ Params: { planId: string } }>(
    '/',
    {
      schema: routeDoc({
        operationId: 'listPlanWorkouts',
        summary: 'The workouts of a plan',
        description: 'On their own plan.',
        tag: 'Workouts',
        roles: ['TRAINER', 'CLIENT'],
        params: idParams('planId'),
        ok: { status: 200, description: 'The workouts.', schema: z.array(workoutSchema) },
        errors: [403, 404],
      }),
    },
    async (req) => {
      const plan = await planService.getTrainingPlan(parseId(req.params.planId))
      assertOwnsPlan(req.user!, plan)
      return workoutService.listWorkouts(plan.id)
    },
  )

  app.post<{ Params: { planId: string } }>(
    '/',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'createWorkout',
        summary: 'Create a workout, with its exercises and sets',
        description:
          'On their own plan. `exercises` is optional (omitted or `[]` creates an empty workout), at most 20, ' +
          'each with at most 10 `sets`. List position is the order. All or nothing. Every `exerciseId` must be visible to the ' +
          'trainer (the starter set or their own): another trainer’s private exercise and a nonexistent id both get 400.',
        tag: 'Workouts',
        roles: ['TRAINER'],
        params: idParams('planId'),
        body: workoutCreateSchema,
        ok: { status: 201, description: 'The workout with every new exercise and set id.', schema: fullWorkoutSchema },
        errors: [400, 403, 404],
      }),
    },
    async (req, reply) => {
      const plan = await planService.getTrainingPlan(parseId(req.params.planId))
      assertOwnsPlan(req.user!, plan)
      // Body may carry a nested `exercises` tree; responds with FullWorkout.
      const body = workoutCreateSchema.parse(req.body)
      await assertCanUseExercises(body.exercises.map((e) => e.exerciseId))
      reply.status(201)
      return workoutService.createWorkout(plan.id, body)
    },
  )
}

/** Mounted at /api/workouts */
export async function workoutRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'CLIENT'))

  // Only `?recent=true` is supported today — it powers the workout builder's
  // clone picker (the trainer's workouts across every plan/student). There is
  // no unfiltered "list all workouts" mode.
  app.get<{ Querystring: { recent?: string } }>(
    '/',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'listRecentWorkouts',
        summary: 'The trainer’s workouts across every plan',
        description:
          'Powers the clone picker. `recent=true` is the only supported mode (anything else is a 400). ' +
          'Sorted by workout id descending.',
        tag: 'Workouts',
        roles: ['TRAINER'],
        query: workoutListQuerySchema,
        ok: { status: 200, description: 'The workouts, with student, plan and exercise count.', schema: z.array(recentWorkoutSummarySchema) },
        errors: [400, 403],
      }),
    },
    async (req) => {
      workoutListQuerySchema.parse(req.query)
      return workoutService.listRecentWorkoutsForTrainer(req.user!.id)
    },
  )

  app.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: routeDoc({
        operationId: 'getWorkout',
        summary: 'One workout',
        description: 'On their own plan.',
        tag: 'Workouts',
        roles: ['TRAINER', 'CLIENT'],
        params: idParams('id'),
        ok: { status: 200, description: 'The workout.', schema: workoutSchema },
        errors: [403, 404],
      }),
    },
    async (req) => {
      const id = parseId(req.params.id)
      await assertOwnsWorkout(req.user!, id)
      return workoutService.getWorkout(id)
    },
  )

  app.get<{ Params: { id: string } }>(
    '/:id/full',
    {
      schema: routeDoc({
        operationId: 'getFullWorkout',
        summary: 'A workout with its exercises and sets',
        description: 'On their own plan. One call renders a whole workout; sorted by `order` and `setNumber`.',
        tag: 'Workouts',
        roles: ['TRAINER', 'CLIENT'],
        params: idParams('id'),
        ok: { status: 200, description: 'The workout tree.', schema: fullWorkoutSchema },
        errors: [403, 404],
      }),
    },
    async (req) => {
      const id = parseId(req.params.id)
      await assertOwnsWorkout(req.user!, id)
      return workoutService.getFullWorkout(id)
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'updateWorkout',
        summary: 'Rename a workout or move it to another day',
        description: 'On their own plan.',
        tag: 'Workouts',
        roles: ['TRAINER'],
        params: idParams('id'),
        body: workoutInputSchema,
        ok: { status: 200, description: 'The workout.', schema: workoutSchema },
        errors: [400, 403, 404],
      }),
    },
    async (req) => {
      const id = parseId(req.params.id)
      await assertOwnsWorkout(req.user!, id)
      const body = workoutInputSchema.parse(req.body)
      return workoutService.updateWorkout(id, body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'deleteWorkout',
        summary: 'Delete a workout',
        description: 'On their own plan. 409 `PRECONDITION_FAILED` once a client recorded training under it.',
        tag: 'Workouts',
        roles: ['TRAINER'],
        params: idParams('id'),
        ok: { status: 204, description: 'Deleted; no body.' },
        errors: [403, 404, 409],
      }),
    },
    async (req, reply) => {
      const id = parseId(req.params.id)
      await assertOwnsWorkout(req.user!, id)
      await workoutService.deleteWorkout(id)
      reply.status(204)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/:id/clone',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'cloneWorkout',
        summary: 'Clone a workout into a plan',
        description: 'The source workout and the target plan must both be the trainer’s. Copies the exercises and sets.',
        tag: 'Workouts',
        roles: ['TRAINER'],
        params: idParams('id'),
        body: cloneWorkoutSchema,
        ok: { status: 201, description: 'The new workout.', schema: workoutSchema },
        errors: [400, 403, 404],
      }),
    },
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
