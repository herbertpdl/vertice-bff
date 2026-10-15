import type { FastifyInstance } from 'fastify'
import {
  changePasswordSchema,
  deleteAccountSchema,
  loginSchema,
  passwordSetupSchema,
  recordConsentSchema,
  registerSchema,
  updateMeSchema,
} from './schemas.js'
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
  // Account deletion re-checks the password, so it is guarded like the password change: failures only.
  const deleteLimit = app.attemptLimit('account-delete', { keys: (req) => [ipKey(req), `user:${req.user!.id}`] })
  // The export is the heaviest read there is (everything about the user), so every one counts,
  // in its own slower window (`EXPORT_RATE_LIMIT_*`, 3 per hour by default).
  const exportLimit = app.attemptLimit('export', { keys: (req) => [`user:${req.user!.id}`], count: 'all', profile: 'export' })

  app.post('/login', loginLimit, async (req) => {
    const body = loginSchema.parse(req.body)
    return authService.login(body.email, body.password)
  })

  app.post('/register', registerLimit, async (req, reply) => {
    const body = registerSchema.parse(req.body)
    reply.status(201)
    return authService.register(body)
  })

  // The /me routes are self only by construction: the user id comes from the token, never the
  // request. Any role, ADMIN included, like the password change: it is the caller's own account.
  app.get('/me', { preHandler: app.authenticate }, async (req) => userService.getMe(req.user!.id))

  app.patch('/me', { preHandler: app.authenticate }, async (req) => {
    const body = updateMeSchema.parse(req.body)
    const me = await authService.updateMe(req.user!.id, body)
    // Which fields were sent, never their values.
    req.log.info({ audit: 'account.update', actorId: req.user!.id, fields: Object.keys(body) }, 'Own profile updated')
    return me
  })

  // LGPD art. 18 VI. 204 on success: the account's tokens are dead from here on, so the web clears
  // its session cookie.
  app.delete(
    '/me',
    { preHandler: [app.authenticate, deleteLimit.preHandler], onResponse: deleteLimit.onResponse },
    async (req, reply) => {
      const body = deleteAccountSchema.parse(req.body)
      await authService.deleteAccount(req.user!.id, body.password)
      req.log.info({ audit: 'account.delete', actorId: req.user!.id }, 'Own account deleted')
      reply.status(204)
    },
  )

  // LGPD art. 18 II and V: vertice-api's JSON document passed through as a file download. Still
  // `Cache-Control: no-store` (security-headers plugin), like every /api response.
  app.get(
    '/me/export',
    { preHandler: [app.authenticate, exportLimit.preHandler], onResponse: exportLimit.onResponse },
    async (req, reply) => {
      const json = await userService.exportUserData()
      req.log.info({ audit: 'account.export', actorId: req.user!.id }, 'Own data exported')
      const date = new Date().toISOString().slice(0, 10)
      reply
        .type('application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="vertice-dados-${date}.json"`)
      return reply.send(json)
    },
  )

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
