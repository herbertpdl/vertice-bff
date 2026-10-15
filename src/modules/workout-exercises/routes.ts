import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseId } from '../../lib/net.js'
import { assertCanUseExercises, assertOwnsWorkout, assertOwnsWorkoutExercise } from '../../lib/ownership.js'
import { workoutExerciseCreateSchema, workoutExerciseUpdateSchema } from './schemas.js'
import { replaceWorkoutExercisesSchema } from '../workouts/schemas.js'
import * as workoutExerciseService from './service.js'
import * as workoutService from '../workouts/service.js'
import { idParams, routeDoc } from '../../openapi/docs.js'
import { fullWorkoutSchema, workoutExerciseSchema } from '../../openapi/responses.js'

/** Mounted at /api/workouts/:workoutId/exercises */
export async function workoutExercisesUnderWorkoutRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'CLIENT'))

  app.get<{ Params: { workoutId: string } }>(
    '/',
    {
      schema: routeDoc({
        operationId: 'listWorkoutExercises',
        summary: 'The exercises of a workout',
        description: 'On their own plan.',
        tag: 'Workout exercises',
        roles: ['TRAINER', 'CLIENT'],
        params: idParams('workoutId'),
        ok: { status: 200, description: 'The workout exercises.', schema: z.array(workoutExerciseSchema) },
        errors: [403, 404],
      }),
    },
    async (req) => {
      const workoutId = parseId(req.params.workoutId)
      await assertOwnsWorkout(req.user!, workoutId)
      return workoutExerciseService.listWorkoutExercises(workoutId)
    },
  )

  app.post<{ Params: { workoutId: string } }>(
    '/',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'addWorkoutExercise',
        summary: 'Add an exercise to a workout',
        description:
          'On their own plan. `exerciseId` must be visible to the trainer (the starter set or their own): ' +
          'another trainer’s private exercise and a nonexistent id both get 400.',
        tag: 'Workout exercises',
        roles: ['TRAINER'],
        params: idParams('workoutId'),
        body: workoutExerciseCreateSchema,
        ok: { status: 201, description: 'The workout exercise.', schema: workoutExerciseSchema },
        errors: [400, 403, 404],
      }),
    },
    async (req, reply) => {
      const workoutId = parseId(req.params.workoutId)
      await assertOwnsWorkout(req.user!, workoutId)
      const body = workoutExerciseCreateSchema.parse(req.body)
      await assertCanUseExercises([body.exerciseId])
      reply.status(201)
      return workoutExerciseService.createWorkoutExercise(workoutId, body)
    },
  )

  // Full replace of the workout's exercise/set tree ("this is now the whole
  // list"). Lives here rather than in workoutRoutes as `/:id/exercises` so the
  // same path is not registered twice with differently named params. Delegates
  // to the workouts service because the RPC is on WorkoutService.
  app.put<{ Params: { workoutId: string } }>(
    '/',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'replaceWorkoutExercises',
        summary: 'Replace the whole exercise and set tree of a workout',
        description:
          'On their own plan. Full replace, not merge: `[]` empties the workout. Upstream deletes and recreates ' +
          'the tree, so every `WorkoutExercise` and `ExerciseSet` id in the response is new. 409 `PRECONDITION_FAILED` once any ' +
          'set under the workout has recorded client data. All or nothing.',
        tag: 'Workout exercises',
        roles: ['TRAINER'],
        params: idParams('workoutId'),
        body: replaceWorkoutExercisesSchema,
        ok: { status: 200, description: 'The workout with its new tree.', schema: fullWorkoutSchema },
        errors: [400, 403, 404, 409],
      }),
    },
    async (req) => {
      const workoutId = parseId(req.params.workoutId)
      await assertOwnsWorkout(req.user!, workoutId)
      const body = replaceWorkoutExercisesSchema.parse(req.body)
      await assertCanUseExercises(body.exercises.map((e) => e.exerciseId))
      return workoutService.replaceWorkoutExercises(workoutId, body.exercises)
    },
  )
}

/** Mounted at /api/workout-exercises */
export async function workoutExerciseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'CLIENT'))

  app.patch<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'updateWorkoutExercise',
        summary: 'Update a workout exercise',
        description: 'On their own plan.',
        tag: 'Workout exercises',
        roles: ['TRAINER'],
        params: idParams('id'),
        body: workoutExerciseUpdateSchema,
        ok: { status: 200, description: 'The workout exercise.', schema: workoutExerciseSchema },
        errors: [400, 403, 404],
      }),
    },
    async (req) => {
      const id = parseId(req.params.id)
      await assertOwnsWorkoutExercise(req.user!, id)
      const body = workoutExerciseUpdateSchema.parse(req.body)
      return workoutExerciseService.updateWorkoutExercise(id, body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'deleteWorkoutExercise',
        summary: 'Remove an exercise from a workout',
        description: 'On their own plan. 409 `PRECONDITION_FAILED` once a client recorded training under it.',
        tag: 'Workout exercises',
        roles: ['TRAINER'],
        params: idParams('id'),
        ok: { status: 204, description: 'Deleted; no body.' },
        errors: [403, 404, 409],
      }),
    },
    async (req, reply) => {
      const id = parseId(req.params.id)
      await assertOwnsWorkoutExercise(req.user!, id)
      await workoutExerciseService.deleteWorkoutExercise(id)
      reply.status(204)
    },
  )
}
