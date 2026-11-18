import type { FastifyInstance } from 'fastify'
import {
  changePasswordSchema,
  deleteAccountSchema,
  loginSchema,
  passwordSetupSchema,
  recordConsentSchema,
  registerSchema,
  sessionClientHeadersSchema,
  sessionClientOf,
  updateMeSchema,
} from './schemas.js'
import * as authService from './service.js'
import * as userService from '../users/service.js'
import { emailKey, ipKey } from '../../plugins/rate-limit.js'
import { todayInBusinessZone } from '../../lib/dates.js'
import { routeDoc } from '../../openapi/docs.js'
import {
  clientTrainerSchema,
  consentSchema,
  dataExportSchema,
  meSchema,
  passwordSetupResultSchema,
  sessionSchema,
} from '../../openapi/responses.js'

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
  // Renewal counts refusals only (a web token, a token vertice-api no longer accepts): successes are
  // the app's normal use and must not lock out users who share a carrier's NAT (the network bucket).
  const renewLimit = app.attemptLimit('session-renew', { keys: (req) => [ipKey(req), `user:${req.user!.id}`] })

  app.post(
    '/login',
    {
      ...loginLimit,
      schema: routeDoc({
        operationId: 'login',
        summary: 'Log in',
        description:
          'The password is checked by vertice-api. A wrong password, an unknown email and an account with no password ' +
          'yet all get the same 401 `UNAUTHORIZED` “Invalid email or password”. Failed attempts are rate limited. ' +
          'With `X-Vertice-Client: mobile` a TRAINER or CLIENT gets a 90-day mobile session, renewable with ' +
          '`POST /auth/session/renew`; without it the 8h web session. With the right password, a suspended account ' +
          'is 403 `ACCOUNT_SUSPENDED` (message: the text to show, “Sua conta está suspensa. Entre em contato com o ' +
          'suporte.”), and an ADMIN is 403 `ADMIN_LOGIN_ELSEWHERE` (message: “O acesso de alunos é feito somente pelo ' +
          'aplicativo Vertice.”), whatever `X-Vertice-Client` says: an admin signs in at `POST /admin/auth/login`. ' +
          'Neither gets a token.',
        tag: 'Auth',
        auth: 'public',
        headers: sessionClientHeadersSchema,
        body: loginSchema,
        ok: { status: 200, description: 'The session token, its expiry and the user.', schema: sessionSchema },
        errors: [401, 403, 429],
      }),
    },
    async (req) => {
      const body = loginSchema.parse(req.body)
      return authService.login(body.email, body.password, sessionClientOf(req.headers))
    },
  )

  app.post(
    '/register',
    {
      ...registerLimit,
      schema: routeDoc({
        operationId: 'register',
        summary: 'Register a trainer',
        description:
          'Public sign-up is for trainers only (`role: "TRAINER"`); a client is created by their trainer (`POST /clients`). ' +
          '`acceptedTermsVersion` is required: no account is created without an acceptance on record. ' +
          'A taken email or CPF is 409 `CONFLICT`, the same body for both. Every attempt is rate limited. ' +
          'With `X-Vertice-Client: mobile` the session is a 90-day mobile one, as on login.',
        tag: 'Auth',
        auth: 'public',
        headers: sessionClientHeadersSchema,
        body: registerSchema,
        ok: { status: 201, description: 'The session token, its expiry and the user.', schema: sessionSchema },
        errors: [409, 429],
      }),
    },
    async (req, reply) => {
      const body = registerSchema.parse(req.body)
      const session = await authService.register(body, sessionClientOf(req.headers))
      reply.status(201)
      return session
    },
  )

  // Mobile persistent session (PRD R3, R4): a valid mobile token gets a fresh 90 days. Whether the
  // token is renewable is its own `session` claim's call, never the request header's.
  app.post(
    '/session/renew',
    {
      preHandler: [app.authenticate, app.requireRole('TRAINER', 'CLIENT'), renewLimit.preHandler],
      onResponse: renewLimit.onResponse,
      schema: routeDoc({
        operationId: 'renewSession',
        summary: 'Renew a mobile session',
        description:
          'Trades the caller’s mobile session token (from login or register with `X-Vertice-Client: mobile`) for a ' +
          'new one that expires 90 days from now; the old token stays valid until its own expiry. A web (8h) token ' +
          'is 403 `SESSION_NOT_RENEWABLE`, with or without the header: renewal decides from the token alone. ' +
          'vertice-api is asked first, so a token it no longer accepts (deleted user, changed role, password ' +
          'changed since the token was issued) is 401 `UNAUTHENTICATED` and gets no new token. Refusals are rate ' +
          'limited per IP and per user. No body.',
        tag: 'Auth',
        roles: ['TRAINER', 'CLIENT'],
        headers: sessionClientHeadersSchema,
        ok: { status: 200, description: 'The new session token, its expiry and the user.', schema: sessionSchema },
        errors: [403, 429],
      }),
    },
    async (req) => authService.renewSession(req.user!),
  )

  // The /me routes are self only by construction: the user id comes from the token, never the
  // request. Reading the account, consent and the password change admit every role, ADMIN
  // included; correcting, deleting and exporting it are TRAINER and CLIENT only (admin-panel R16b,
  // E41: an admin's account is managed by ops, and vertice-api refuses these to ADMIN too).
  app.get(
    '/me',
    {
      preHandler: app.authenticate,
      schema: routeDoc({
        operationId: 'getMe',
        summary: 'The caller’s own account',
        description: 'The CPF is masked, with no reveal; the full value is in the data export.',
        tag: 'Auth',
        ok: { status: 200, description: 'The caller’s account and consent state.', schema: meSchema },
      }),
    },
    async (req) => userService.getMe(req.user!.id),
  )

  app.patch(
    '/me',
    {
      preHandler: [app.authenticate, app.requireRole('TRAINER', 'CLIENT')],
      schema: routeDoc({
        operationId: 'updateMe',
        summary: 'Correct the caller’s own profile',
        description:
          'LGPD art. 18 III. Every field is optional and an omitted one keeps the stored value. The role cannot change. ' +
          '`cpf`: a string sets it (the mask `GET /auth/me` returns is refused), `null` removes it (a trainer’s CPF is required). ' +
          '`cref` is a trainer’s only. No email verification yet.',
        tag: 'Auth',
        roles: ['TRAINER', 'CLIENT'],
        body: updateMeSchema,
        ok: { status: 200, description: 'The updated account.', schema: meSchema },
        errors: [403, 409],
      }),
    },
    async (req) => {
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
    {
      preHandler: [app.authenticate, app.requireRole('TRAINER', 'CLIENT'), deleteLimit.preHandler],
      onResponse: deleteLimit.onResponse,
      schema: routeDoc({
        operationId: 'deleteMe',
        summary: 'Delete the caller’s own account',
        description:
          'LGPD art. 18 VI. Re-checks `password` first (a wrong one is 400 `INVALID_CURRENT_PASSWORD`, not a 401). ' +
          'A trainer with active clients gets 409 `ACTIVE_CLIENTS`. Every token of the account stops working afterwards.',
        tag: 'Auth',
        roles: ['TRAINER', 'CLIENT'],
        body: deleteAccountSchema,
        ok: { status: 204, description: 'Deleted; no body.' },
        errors: [403, 409, 429],
      }),
    },
    async (req, reply) => {
      const body = deleteAccountSchema.parse(req.body)
      await authService.deleteAccount(req.user!.id, body.password)
      req.log.info({ audit: 'account.delete', actorId: req.user!.id }, 'Own account deleted')
      reply.status(204)
    },
  )

  // A client's trainer card (client workout experience R74-R79): the name, and only the contacts the
  // trainer chose to show and filled in. 404 when the client has no active trainer.
  app.get(
    '/me/trainer',
    {
      preHandler: [app.authenticate, app.requireRole('CLIENT')],
      schema: routeDoc({
        operationId: 'getMyTrainer',
        summary: 'The client’s trainer and the contacts they share',
        description:
          'The caller’s active trainer: the name always; `email`, `whatsapp`, `instagram` only when the trainer shows ' +
          'them and filled them in (`""` otherwise). 404 when the client has no active trainer.',
        tag: 'Auth',
        roles: ['CLIENT'],
        ok: { status: 200, description: 'The trainer card.', schema: clientTrainerSchema },
        errors: [404],
      }),
    },
    async (req) => authService.getMyTrainer(req.user!.id),
  )

  // LGPD art. 18 II and V: vertice-api's JSON document passed through as a file download. Still
  // `Cache-Control: no-store` (security-headers plugin), like every /api response.
  app.get(
    '/me/export',
    {
      preHandler: [app.authenticate, app.requireRole('TRAINER', 'CLIENT'), exportLimit.preHandler],
      onResponse: exportLimit.onResponse,
      schema: routeDoc({
        operationId: 'exportMyData',
        summary: 'Download the caller’s data',
        description:
          'LGPD art. 18 II and V. vertice-api’s export document, passed through as a file download ' +
          '(`Content-Disposition: attachment; filename="vertice-dados-YYYY-MM-DD.json"`). ' +
          'Over the export bounds it is 413 `TOO_LARGE` rather than a truncated file. 3 per hour per user.',
        tag: 'Auth',
        roles: ['TRAINER', 'CLIENT'],
        ok: { status: 200, description: 'The export document.', schema: dataExportSchema },
        errors: [403, 413, 429],
      }),
    },
    async (req, reply) => {
      const json = await userService.exportUserData()
      req.log.info({ audit: 'account.export', actorId: req.user!.id }, 'Own data exported')
      // The day the user is living, not UTC's: a 22:00 export is still today's file.
      const date = todayInBusinessZone()
      reply
        .type('application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="vertice-dados-${date}.json"`)
      return reply.send(json)
    },
  )

  // Self only (P1-04): the body has no user id, and vertice-api records the consent for the
  // token's user. Any role, like the password change: it is the caller's own account.
  app.post(
    '/me/consent',
    {
      preHandler: app.authenticate,
      schema: routeDoc({
        operationId: 'recordConsent',
        summary: 'Record the caller’s consent to a legal text',
        description:
          'Self only: there is no user id in the request. `TERMS` is the Terms of Use / Privacy Policy, ' +
          '`HEALTH_DATA` the health-data notice. A later call replaces the earlier record of that type.',
        tag: 'Auth',
        body: recordConsentSchema,
        ok: { status: 200, description: 'The caller’s consent state after the change.', schema: consentSchema },
      }),
    },
    async (req) => {
      const body = recordConsentSchema.parse(req.body)
      return userService.recordConsent(body.type, body.version)
    },
  )

  app.post(
    '/password',
    {
      preHandler: [app.authenticate, changeLimit.preHandler],
      onResponse: changeLimit.onResponse,
      schema: routeDoc({
        operationId: 'changePassword',
        summary: 'Change the caller’s password',
        description: 'A wrong `currentPassword` is 400 `INVALID_CURRENT_PASSWORD`, not a 401: the session is still valid.',
        tag: 'Auth',
        body: changePasswordSchema,
        ok: { status: 204, description: 'Changed; no body.' },
        errors: [429],
      }),
    },
    async (req, reply) => {
      const body = changePasswordSchema.parse(req.body)
      await authService.changePassword(req.user!.id, body.currentPassword, body.newPassword)
      reply.status(204)
    },
  )

  app.post(
    '/password/setup',
    {
      ...setupLimit,
      schema: routeDoc({
        operationId: 'setupPassword',
        summary: 'Choose a password with a first-access token',
        description:
          'The token comes from `POST /clients` or `POST /clients/{id}/setup-token`. An unknown, expired (72h) or used ' +
          'token is 400 `INVALID_SETUP_TOKEN`. Failed attempts are rate limited. On success the answer says whose first ' +
          'access it was (`role`, `email`), never before the token is used: the web shows a CLIENT the “use the app” ' +
          'screen with the email filled in. No session is created; log in normally.',
        tag: 'Auth',
        auth: 'public',
        body: passwordSetupSchema,
        ok: { status: 200, description: 'Password set: the account’s role and email.', schema: passwordSetupResultSchema },
        errors: [429],
      }),
    },
    async (req) => {
      const body = passwordSetupSchema.parse(req.body)
      return authService.setupPassword(body.token, body.newPassword)
    },
  )
}
