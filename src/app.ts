import Fastify, { type FastifyBaseLogger, type RouteOptions } from 'fastify'
import cors from '@fastify/cors'
import { env } from './config/env.js'
import errorHandler from './plugins/error-handler.js'
import securityHeaders from './plugins/security-headers.js'
import requestContextPlugin from './plugins/request-context.js'
import authenticatePlugin from './plugins/authenticate.js'
import rateLimitPlugin, { type RateLimitSettings } from './plugins/rate-limit.js'

import authRoutes from './modules/auth/routes.js'
import clientRoutes from './modules/clients/routes.js'
import exerciseRoutes, { muscleGroupRoutes } from './modules/exercises/routes.js'
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

export interface BuildAppOptions {
  /** Sees every route as it is registered (the route-authorization suite uses it to find untested routes). */
  onRoute?: (route: RouteOptions) => void
  /** Overrides the env-configured rate limits (tests use it to raise or lower them). */
  rateLimits?: Partial<RateLimitSettings>
  /** Overrides `TRUST_PROXY` (tests). */
  trustProxy?: boolean | string
  /** Replaces the env-configured logger (tests read the audit and upstream-error lines from it). */
  loggerInstance?: FastifyBaseLogger
}

/** Network buckets default to this many times the per-IP/per-email limit. */
const NETWORK_MAX_FACTOR = 20

function rateLimitSettings(overrides: Partial<RateLimitSettings> = {}): RateLimitSettings {
  const authMax = overrides.authMax ?? env.AUTH_RATE_LIMIT_MAX
  return {
    globalMax: env.RATE_LIMIT_GLOBAL_MAX,
    globalWindowMs: env.RATE_LIMIT_GLOBAL_WINDOW_MS,
    authWindowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    authNetworkMax: env.AUTH_RATE_LIMIT_NETWORK_MAX ?? authMax * NETWORK_MAX_FACTOR,
    authMaxKeys: env.AUTH_RATE_LIMIT_MAX_KEYS,
    ...overrides,
    authMax,
  }
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    ...(options.loggerInstance
      ? { loggerInstance: options.loggerInstance }
      : {
          logger: {
            level: env.LOG_LEVEL,
            transport: env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
          },
        }),
    // Rate limits key on req.ip, which is only the real client behind a proxy when this is set.
    trustProxy: options.trustProxy ?? env.TRUST_PROXY,
  })
  if (options.onRoute) app.addHook('onRoute', options.onRoute)
  if (!env.VERIFY_PASSWORDS) {
    app.log.warn(
      'VERIFY_PASSWORDS=false: login accepts any password for an existing email ' +
        '(dev/test only; needs the vertice-api local profile)',
    )
  }

  await app.register(securityHeaders)
  await app.register(cors, { origin: env.CORS_ORIGIN, credentials: true })
  await app.register(errorHandler)
  await app.register(requestContextPlugin)
  await app.register(rateLimitPlugin, { settings: rateLimitSettings(options.rateLimits) })
  await app.register(authenticatePlugin)

  app.get('/health', async () => ({ status: 'ok' }))

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' })
      await api.register(clientRoutes, { prefix: '/clients' })
      await api.register(exerciseRoutes, { prefix: '/exercises' })
      await api.register(muscleGroupRoutes, { prefix: '/muscle-groups' })
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
