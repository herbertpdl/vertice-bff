import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseId, requireQueryId } from '../../lib/net.js'
import { exerciseInputSchema, exerciseListQuerySchema, exerciseProgressQuerySchema } from './schemas.js'
import * as exerciseService from './service.js'
import { getExerciseProgress } from '../workout-sessions/service.js'
import { assertIsTrainersClient } from '../clients/service.js'
import { idParams, idQuery, routeDoc } from '../../openapi/docs.js'
import { exerciseSchema, muscleGroupSchema, progressPointSchema } from '../../openapi/responses.js'

// Exercise visibility (starter set vs. a trainer's private exercises), the starter-set
// refusals and the in-use delete refusal are enforced by vertice-api from the forwarded
// caller identity — deliberately no exercise-ownership helper here (spec D10).
export default async function exerciseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  // The catalog read stays open to ADMIN (upstream returns the starter set): it is generic,
  // not trainer-scoped.
  app.get(
    '/',
    {
      preHandler: app.requireRole('TRAINER', 'ADMIN'),
      schema: routeDoc({
        operationId: 'listExercises',
        summary: 'List the exercise catalog',
        description:
          'A trainer sees the starter set and their own exercises; an ADMIN the starter set only. ' +
          'In upstream order: do not re-sort client-side. An empty `muscleGroupId` or `q` means no filter.',
        tag: 'Exercises',
        roles: ['TRAINER', 'ADMIN'],
        query: z.object({
          muscleGroupId: idQuery('Exercises with this group as primary or secondary.'),
          q: z.string().max(100).optional().describe('Case-insensitive name search, trimmed.'),
        }),
        ok: { status: 200, description: 'The exercises.', schema: z.array(exerciseSchema) },
        errors: [400, 403, 404],
      }),
    },
    async (req) => {
      const query = exerciseListQuerySchema.parse(req.query)
      return exerciseService.listExercises({ muscleGroupId: query.muscleGroupId, search: query.q })
    },
  )

  // No role gate on purpose: a CLIENT may read an exercise inside one of their own
  // workouts, and only upstream can tell.
  app.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: routeDoc({
        operationId: 'getExercise',
        summary: 'One exercise',
        description:
          'Vertice-api decides visibility. A TRAINER sees the starter set and their own, an ADMIN the starter set, ' +
          'a CLIENT only an exercise used by a workout in one of their plans.',
        tag: 'Exercises',
        params: idParams('id'),
        ok: { status: 200, description: 'The exercise.', schema: exerciseSchema },
        errors: [403, 404],
      }),
    },
    async (req) => exerciseService.getExercise(parseId(req.params.id)),
  )

  // Client history is trainer-scoped: ADMIN (no defined product yet, P1-02) gets a 403.
  app.get<{ Params: { id: string }; Querystring: { clientId?: string } }>(
    '/:id/progress',
    {
      preHandler: app.requireRole('TRAINER', 'CLIENT'),
      schema: routeDoc({
        operationId: 'getExerciseProgress',
        summary: 'Weight over time for one exercise',
        description:
          'A CLIENT’s `clientId` is ignored (their own is used); a TRAINER must pass one of their clients.',
        tag: 'Exercises',
        roles: ['TRAINER', 'CLIENT'],
        params: idParams('id'),
        query: z.object({ clientId: idQuery('Required for a TRAINER.') }),
        ok: { status: 200, description: 'One point per week.', schema: z.array(progressPointSchema) },
        errors: [400, 403],
      }),
    },
    async (req) => {
      const user = req.user!
      const exerciseId = parseId(req.params.id)
      // A CLIENT only ever sees their own history; a TRAINER must name one of their clients.
      const query = exerciseProgressQuerySchema.parse(req.query)
      const clientId = user.role === 'CLIENT' ? user.id : requireQueryId(query.clientId, 'clientId')
      if (user.role === 'TRAINER') await assertIsTrainersClient(user.id, clientId)
      return getExerciseProgress(exerciseId, clientId)
    },
  )

  app.post(
    '/',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'createExercise',
        summary: 'Create an exercise',
        description: 'Private to the caller (`isStarter: false`). Duplicate names are allowed.',
        tag: 'Exercises',
        roles: ['TRAINER'],
        body: exerciseInputSchema,
        ok: { status: 201, description: 'The exercise.', schema: exerciseSchema },
        errors: [400, 403],
      }),
    },
    async (req, reply) => {
      const body = exerciseInputSchema.parse(req.body)
      reply.status(201)
      return exerciseService.createExercise(body)
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'updateExercise',
        summary: 'Replace an exercise',
        description:
          'Full replacement of name, description, video URL and the whole group list. ' +
          'A starter exercise or another trainer’s is 403 (the two are not told apart).',
        tag: 'Exercises',
        roles: ['TRAINER'],
        params: idParams('id'),
        body: exerciseInputSchema,
        ok: { status: 200, description: 'The exercise.', schema: exerciseSchema },
        errors: [400, 403, 404],
      }),
    },
    async (req) => {
      const body = exerciseInputSchema.parse(req.body)
      return exerciseService.updateExercise(parseId(req.params.id), body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: app.requireRole('TRAINER'),
      schema: routeDoc({
        operationId: 'deleteExercise',
        summary: 'Delete an exercise',
        description: 'Your own. 409 `PRECONDITION_FAILED` while any workout uses it.',
        tag: 'Exercises',
        roles: ['TRAINER'],
        params: idParams('id'),
        ok: { status: 204, description: 'Deleted; no body.' },
        errors: [403, 404, 409],
      }),
    },
    async (req, reply) => {
      await exerciseService.deleteExercise(parseId(req.params.id))
      reply.status(204)
    },
  )
}

/** `GET /muscle-groups` — reference data for any authenticated role. */
export async function muscleGroupRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.get(
    '/',
    {
      schema: routeDoc({
        operationId: 'listMuscleGroups',
        summary: 'List the muscle groups',
        description: 'Reference data in id order; ids are database-generated, do not hardcode them.',
        tag: 'Exercises',
        ok: { status: 200, description: 'The muscle groups.', schema: z.array(muscleGroupSchema) },
      }),
    },
    async () => exerciseService.listMuscleGroups(),
  )
}
