import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseId } from '../../lib/net.js'
import { assertOwnsWorkoutExercise } from '../../lib/ownership.js'
import { exerciseSetInputSchema } from './schemas.js'
import * as exerciseSetService from './service.js'
import { idParams, routeDoc } from '../../openapi/docs.js'
import { exerciseSetSchema } from '../../openapi/responses.js'

/** Mounted at /api/workout-exercises/:workoutExerciseId/sets */
export async function exerciseSetsUnderWorkoutExerciseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'CLIENT'))

  app.get<{ Params: { workoutExerciseId: string } }>(
    '/',
    {
      schema: routeDoc({
        operationId: 'listExerciseSets',
        summary: 'The sets of a workout exercise',
        description: 'On their own plan.',
        tag: 'Exercise sets',
        roles: ['TRAINER', 'CLIENT'],
        params: idParams('workoutExerciseId'),
        ok: { status: 200, description: 'The sets.', schema: z.array(exerciseSetSchema) },
        errors: [403, 404],
      }),
    },
    async (req) => {
      const id = parseId(req.params.workoutExerciseId)
      await assertOwnsWorkoutExercise(req.user!, id)
      return exerciseSetService.listExerciseSets(id)
    },
  )

  app.post<{ Params: { workoutExerciseId: string } }>(
    '/',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'createExerciseSet',
        summary: 'Add a set to a workout exercise',
        description: 'On their own plan. `weight` and `loadPercentage` are decimal strings.',
        tag: 'Exercise sets',
        roles: ['TRAINER'],
        params: idParams('workoutExerciseId'),
        body: exerciseSetInputSchema,
        ok: { status: 201, description: 'The set.', schema: exerciseSetSchema },
        errors: [400, 403, 404],
      }),
    },
    async (req, reply) => {
      const workoutExerciseId = parseId(req.params.workoutExerciseId)
      await assertOwnsWorkoutExercise(req.user!, workoutExerciseId)
      const body = exerciseSetInputSchema.parse(req.body)
      reply.status(201)
      return exerciseSetService.createExerciseSet(workoutExerciseId, body)
    },
  )
}

/** Mounted at /api/exercise-sets */
export async function exerciseSetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'CLIENT'))

  app.patch<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'updateExerciseSet',
        summary: 'Update a set',
        description: 'On their own plan.',
        tag: 'Exercise sets',
        roles: ['TRAINER'],
        params: idParams('id'),
        body: exerciseSetInputSchema,
        ok: { status: 200, description: 'The set.', schema: exerciseSetSchema },
        errors: [400, 403, 404],
      }),
    },
    async (req) => {
      const id = parseId(req.params.id)
      const existing = await exerciseSetService.getExerciseSet(id)
      await assertOwnsWorkoutExercise(req.user!, existing.workoutExerciseId)
      const body = exerciseSetInputSchema.parse(req.body)
      return exerciseSetService.updateExerciseSet(id, body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'deleteExerciseSet',
        summary: 'Delete a set',
        description: 'On their own plan. 409 `PRECONDITION_FAILED` once a client recorded training under it.',
        tag: 'Exercise sets',
        roles: ['TRAINER'],
        params: idParams('id'),
        ok: { status: 204, description: 'Deleted; no body.' },
        errors: [403, 404, 409],
      }),
    },
    async (req, reply) => {
      const id = parseId(req.params.id)
      const existing = await exerciseSetService.getExerciseSet(id)
      await assertOwnsWorkoutExercise(req.user!, existing.workoutExerciseId)
      await exerciseSetService.deleteExerciseSet(id)
      reply.status(204)
    },
  )
}
