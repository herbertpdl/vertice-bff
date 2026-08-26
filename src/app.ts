import Fastify from 'fastify'
import cors from '@fastify/cors'
import { env } from './config/env.js'
import errorHandler from './plugins/error-handler.js'
import authenticatePlugin from './plugins/authenticate.js'

import authRoutes from './modules/auth/routes.js'
import studentRoutes from './modules/students/routes.js'
import exerciseRoutes from './modules/exercises/routes.js'
import trainingPlanRoutes from './modules/training-plans/routes.js'
import { workoutsUnderPlanRoutes, workoutRoutes } from './modules/workouts/routes.js'
import {
  workoutExercisesUnderWorkoutRoutes,
  workoutExerciseRoutes,
} from './modules/workout-exercises/routes.js'
import { exerciseSetsUnderWorkoutExerciseRoutes, exerciseSetRoutes } from './modules/exercise-sets/routes.js'
import {
  workoutSessionRoutes,
  workoutLogRoutes,
  workoutSessionActionRoutes,
} from './modules/workout-sessions/routes.js'
import { submitFeedbackRoutes, feedbackRoutes } from './modules/feedback/routes.js'
import dashboardRoutes from './modules/dashboard/routes.js'

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
    },
  })

  await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true })
  await app.register(errorHandler)
  await app.register(authenticatePlugin)

  app.get('/health', async () => ({ status: 'ok' }))

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' })
      await api.register(studentRoutes, { prefix: '/students' })
      await api.register(exerciseRoutes, { prefix: '/exercises' })
      await api.register(trainingPlanRoutes, { prefix: '/training-plans' })
      await api.register(workoutsUnderPlanRoutes, { prefix: '/training-plans/:planId/workouts' })
      await api.register(workoutRoutes, { prefix: '/workouts' })
      await api.register(workoutExercisesUnderWorkoutRoutes, { prefix: '/workouts/:workoutId/exercises' })
      await api.register(workoutExerciseRoutes, { prefix: '/workout-exercises' })
      await api.register(exerciseSetsUnderWorkoutExerciseRoutes, {
        prefix: '/workout-exercises/:workoutExerciseId/sets',
      })
      await api.register(exerciseSetRoutes, { prefix: '/exercise-sets' })
      await api.register(workoutSessionRoutes, { prefix: '/workouts/:workoutId/session' })
      await api.register(workoutLogRoutes, { prefix: '/workout-logs' })
      await api.register(submitFeedbackRoutes, { prefix: '/workout-logs/:workoutLogId/feedback' })
      await api.register(workoutSessionActionRoutes, { prefix: '/workout-sessions' })
      await api.register(feedbackRoutes, { prefix: '/feedback' })
      await api.register(dashboardRoutes, { prefix: '/dashboard' })
    },
    { prefix: '/api' },
  )

  return app
}
