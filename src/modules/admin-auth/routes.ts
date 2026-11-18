import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { adminEnrollSchema, adminLoginSchema, adminVerifySchema, ADMIN_CHALLENGE_MAX } from './schemas.js'
import * as adminAuthService from './service.js'
import type { SigninTrace } from './service.js'
import { emailKey, ipKey } from '../../plugins/rate-limit.js'
import { verifyAdminChallenge } from '../../lib/jwt.js'
import { routeDoc } from '../../openapi/docs.js'
import { adminChallengeSchema, adminEnrollmentSchema, adminSessionSchema } from '../../openapi/responses.js'

/** The `step` of the `admin.signin` log line, per route (admin-panel spec §4). */
type SigninStep = 'password' | 'enroll' | 'code'

/**
 * The admin whose challenge is in the body, as a bucket key (`admin:<id>`), or none when the
 * challenge doesn't verify: a forged or expired one keys on the IP (and network) alone, so it can't
 * mint keys or spend another admin's bucket. Runs before the route's Zod parse, so the body is raw.
 */
function challengeUserKey(req: FastifyRequest): string | undefined {
  const challenge = (req.body as { challenge?: unknown } | undefined)?.challenge
  if (typeof challenge !== 'string' || challenge.length > ADMIN_CHALLENGE_MAX) return undefined
  try {
    return `admin:${verifyAdminChallenge(challenge).id}`
  } catch {
    return undefined
  }
}

/**
 * Admin sign-in (admin-panel spec §2.1): login, enroll and verify are public; renew is ADMIN. Not
 * under the `admin` plugin (`/api/admin`, ADMIN-only hooks): it is a sibling, so the public steps
 * stay reachable without a token.
 */
export default async function adminAuthRoutes(app: FastifyInstance) {
  // Failures only on the password and code steps (like /auth/login): a non-admin's correct password
  // is a failure here too. Every enroll counts, since each one mints a new secret upstream.
  const loginLimit = app.attemptLimit('admin-login', { keys: (req) => [ipKey(req), emailKey(req)] })
  const enrollLimit = app.attemptLimit('admin-enroll', { keys: (req) => [ipKey(req), challengeUserKey(req)], count: 'all' })
  const verifyLimit = app.attemptLimit('admin-verify', { keys: (req) => [ipKey(req), challengeUserKey(req)] })
  // Refusals only, as `session-renew`: renewals are the panel's normal use.
  const renewLimit = app.attemptLimit('admin-renew', { keys: (req) => [ipKey(req), `user:${req.user!.id}`] })

  // What each sign-in request learned, for its log line. Filled by the handler (through the service).
  const traces = new WeakMap<FastifyRequest, SigninTrace>()
  const traceOf = (req: FastifyRequest): SigninTrace => {
    let trace = traces.get(req)
    if (!trace) traces.set(req, (trace = {}))
    return trace
  }

  /**
   * One INFO line per sign-in request (spec §4), from `onResponse`, so a 429 from a bucket (which
   * never reaches the handler) is logged too. Its fields are a contract with VRT-19's CloudWatch
   * alarm: `audit`, `step`, `outcome`, `reason` (failures only), `userId` (once known). Never the
   * email, code, challenge, token or URI.
   */
  const signinLog = (step: SigninStep) => async (req: FastifyRequest, reply: FastifyReply) => {
    const status = reply.statusCode
    const trace = traces.get(req) ?? {}
    const outcome = status >= 500 ? 'error' : status >= 400 ? 'failure' : 'success'
    const reason =
      outcome !== 'failure' ? undefined : (trace.reason ?? (status === 429 ? 'rate_limited' : 'invalid_request'))
    req.log.info(
      {
        audit: 'admin.signin',
        step,
        outcome,
        ...(reason ? { reason } : {}),
        ...(trace.userId !== undefined ? { userId: trace.userId } : {}),
      },
      'Admin sign-in',
    )
  }

  app.post(
    '/login',
    {
      preHandler: loginLimit.preHandler,
      onResponse: [loginLimit.onResponse, signinLog('password')],
      schema: routeDoc({
        operationId: 'adminLogin',
        summary: 'Admin sign-in: the password step',
        description:
          'Checks the password of an ADMIN account and answers a short-lived challenge, never a session. A wrong ' +
          'password, an unknown email, an account with no password and a trainer’s or client’s correct password ' +
          'all get the same 401 `UNAUTHORIZED` “Invalid email or password”. `secondFactor` says whether to enroll ' +
          'an authenticator first. Failed attempts are rate limited.',
        tag: 'Admin auth',
        auth: 'public',
        body: adminLoginSchema,
        ok: { status: 200, description: 'The challenge for the code step.', schema: adminChallengeSchema },
        errors: [401, 429],
      }),
    },
    async (req) => {
      const body = adminLoginSchema.parse(req.body)
      return adminAuthService.login(body.email, body.password, traceOf(req))
    },
  )

  app.post(
    '/enroll',
    {
      preHandler: enrollLimit.preHandler,
      onResponse: [enrollLimit.onResponse, signinLog('enroll')],
      schema: routeDoc({
        operationId: 'adminEnroll',
        summary: 'Admin sign-in: start authenticator enrolment',
        description:
          'With the challenge of an admin who has no authenticator yet, answers the `otpauth://` provisioning URI ' +
          '(it contains a new secret; each call replaces it). Enrolment completes at `POST /api/admin/auth/verify` ' +
          'with a code from that secret. An invalid or expired challenge is 401 `CHALLENGE_INVALID` (sign in ' +
          'again); an admin already enrolled is 409 `PRECONDITION_FAILED` (go to the code step). Every call is ' +
          'rate limited.',
        tag: 'Admin auth',
        auth: 'public',
        body: adminEnrollSchema,
        ok: { status: 200, description: 'The provisioning URI, to show as a QR code.', schema: adminEnrollmentSchema },
        errors: [401, 409, 429],
      }),
    },
    async (req) => {
      const body = adminEnrollSchema.parse(req.body)
      return adminAuthService.startEnrollment(body.challenge, traceOf(req))
    },
  )

  app.post(
    '/verify',
    {
      preHandler: verifyLimit.preHandler,
      onResponse: [verifyLimit.onResponse, signinLog('code')],
      schema: routeDoc({
        operationId: 'adminVerify',
        summary: 'Admin sign-in: the code step',
        description:
          'Checks the 6-digit authenticator code and answers the admin session: a 30-minute token, renewable up to ' +
          '`sessionEndsAt` (12 hours). A wrong, reused or expired code is 400 `INVALID_SECOND_FACTOR_CODE` (same ' +
          'challenge, try again). An invalid or expired challenge is 401 `CHALLENGE_INVALID` and no authenticator ' +
          'on record is 409 `PRECONDITION_FAILED`: sign in again from the password. After 5 wrong codes the ' +
          'authenticator is locked for 15 minutes: 429 `RATE_LIMITED` with `Retry-After`.',
        tag: 'Admin auth',
        auth: 'public',
        body: adminVerifySchema,
        ok: { status: 200, description: 'The admin session.', schema: adminSessionSchema },
        errors: [401, 409, 429],
      }),
    },
    async (req) => {
      const body = adminVerifySchema.parse(req.body)
      return adminAuthService.verify(body.challenge, body.code, traceOf(req))
    },
  )

  app.post(
    '/renew',
    {
      preHandler: [app.authenticate, app.requireRole('ADMIN'), renewLimit.preHandler],
      onResponse: renewLimit.onResponse,
      schema: routeDoc({
        operationId: 'adminRenew',
        summary: 'Renew the admin session',
        description:
          'Trades a valid admin token for a new one that expires 30 minutes from now, never after `sessionEndsAt` ' +
          '(which does not move). The old token stays valid until its own expiry. vertice-api is asked first, so a ' +
          'suspended, re-roled or reset admin, or one whose password changed, is 401 `UNAUTHENTICATED` and gets no ' +
          'new token. Renew on the admin’s own activity, throttled, never on a timer. No body.',
        tag: 'Admin auth',
        roles: ['ADMIN'],
        ok: { status: 200, description: 'The new admin session.', schema: adminSessionSchema },
        errors: [403, 429],
      }),
    },
    async (req) => adminAuthService.renew(req.user!),
  )
}
