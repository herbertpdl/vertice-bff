import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { assertOwnsWorkout, assertOwnsWorkoutExercise } from '../../lib/ownership.js'
import { workoutExerciseCreateSchema, workoutExerciseUpdateSchema } from './schemas.js'
import { replaceWorkoutExercisesSchema } from '../workouts/schemas.js'
import * as workoutExerciseService from './service.js'
import * as workoutService from '../workouts/service.js'

/** Mounted at /api/workouts/:workoutId/exercises */
export async function workoutExercisesUnderWorkoutRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.get<{ Params: { workoutId: string } }>('/', async (req) => {
    const workoutId = parseId(req.params.workoutId)
    await assertOwnsWorkout(req.user!, workoutId)
    return workoutExerciseService.listWorkoutExercises(workoutId)
  })

  app.post<{ Params: { workoutId: string } }>(
    '/',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req, reply) => {
      const workoutId = parseId(req.params.workoutId)
      await assertOwnsWorkout(req.user!, workoutId)
      const body = workoutExerciseCreateSchema.parse(req.body)
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
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req) => {
      const workoutId = parseId(req.params.workoutId)
      await assertOwnsWorkout(req.user!, workoutId)
      const body = replaceWorkoutExercisesSchema.parse(req.body)
      return workoutService.replaceWorkoutExercises(workoutId, body.exercises)
    },
  )
}

/** Mounted at /api/workout-exercises */
export async function workoutExerciseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)

  app.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req) => {
      const id = parseId(req.params.id)
      await assertOwnsWorkoutExercise(req.user!, id)
      const body = workoutExerciseUpdateSchema.parse(req.body)
      return workoutExerciseService.updateWorkoutExercise(id, body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: app.requireRole('TRAINER', 'ADMIN') },
    async (req, reply) => {
      const id = parseId(req.params.id)
      await assertOwnsWorkoutExercise(req.user!, id)
      await workoutExerciseService.deleteWorkoutExercise(id)
      reply.status(204)
    },
  )
}
