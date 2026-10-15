import type { FastifyInstance } from 'fastify'
import { changePasswordSchema, loginSchema, passwordSetupSchema, recordConsentSchema, registerSchema } from './schemas.js'
import * as authService from './service.js'
import * as userService from '../users/service.js'
import { emailKey, ipKey } from '../../plugins/rate-limit.js'

export default async function authRoutes(app: FastifyInstance) {
  // Strict buckets (see plugins/rate-limit.ts). Login and setup count failed attempts only;
  // register counts every attempt, since a successful sign-up is what a spammer repeats.
  const loginLimit = app.attemptLimit('login', { keys: (req) => [ipKey(req), emailKey(req)] })
  const registerLimit = app.attemptLimit('register', { keys: (req) => [ipKey(req), emailKey(req)], count: 'all' })
  const setupLimit = app.attemptLimit('password-setup', { keys: (req) => [ipKey(req)] })
  const changeLimit = app.attemptLimit('password-change', { keys: (req) => [ipKey(req), `user:${req.user!.id}`] })

  app.post('/login', loginLimit, async (req) => {
    const body = loginSchema.parse(req.body)
    return authService.login(body.email, body.password)
  })

  app.post('/register', registerLimit, async (req, reply) => {
    const body = registerSchema.parse(req.body)
    reply.status(201)
    return authService.register(body)
  })

  app.get('/me', { preHandler: app.authenticate }, async (req) => userService.getMe(req.user!.id))

  // Self only (P1-04): the body has no user id, and vertice-api records the consent for the
  // token's user. Any role, like the password change: it is the caller's own account.
  app.post('/me/consent', { preHandler: app.authenticate }, async (req) => {
    const body = recordConsentSchema.parse(req.body)
    return userService.recordConsent(body.type, body.version)
  })

  app.post(
    '/password',
    { preHandler: [app.authenticate, changeLimit.preHandler], onResponse: changeLimit.onResponse },
    async (req, reply) => {
      const body = changePasswordSchema.parse(req.body)
      await authService.changePassword(req.user!.id, body.currentPassword, body.newPassword)
      reply.status(204)
    },
  )

  app.post('/password/setup', setupLimit, async (req, reply) => {
    const body = passwordSetupSchema.parse(req.body)
    await authService.setupPassword(body.token, body.newPassword)
    reply.status(204)
  })
}
