import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { assertOwnsWorkoutExercise } from '../../lib/ownership.js'
import { exerciseSetInputSchema } from './schemas.js'
import * as exerciseSetService from './service.js'

/** Mounted at /api/workout-exercises/:workoutExerciseId/sets */
export async function exerciseSetsUnderWorkoutExerciseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.get<{ Params: { workoutExerciseId: string } }>('/', async (req) => {
    const id = parseId(req.params.workoutExerciseId)
    await assertOwnsWorkoutExercise(req.user!, id)
    return exerciseSetService.listExerciseSets(id)
  })

  app.post<{ Params: { workoutExerciseId: string } }>(
    '/',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
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

  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
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
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req, reply) => {
      const id = parseId(req.params.id)
      const existing = await exerciseSetService.getExerciseSet(id)
      await assertOwnsWorkoutExercise(req.user!, existing.workoutExerciseId)
      await exerciseSetService.deleteExerciseSet(id)
      reply.status(204)
    },
  )
}
