import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Writable } from 'node:stream'
import { status } from '@grpc/grpc-js'
import jwt from 'jsonwebtoken'
import pino from 'pino'
import { buildApp } from '../../app.js'
import { grpcCall, mapGrpcError } from '../../grpc/call.js'
import {
  ADMIN_SESSION_MAX_SECONDS,
  ADMIN_SESSION_TTL_SECONDS,
  signAdminChallenge,
  signAdminToken,
  verifyToken,
} from '../../lib/jwt.js'
import {
  adminSessionToken,
  bearer,
  emailOf,
  FAKE_LOCK_SECONDS,
  FAKE_PASSWORD,
  FAKE_TOTP_CODES,
  fakeGrpcCall,
  fakeSuspended,
  ids,
  plainAdminToken,
  resetFakeSecondFactors,
  resetFakeSuspended,
  resetUpstreamCallers,
  setFakeSecondFactor,
  upstreamCallers,
} from '../../test/fakeUpstream.js'

// Keep the real mapGrpcError: the fake upstream raises its errors through it.
vi.mock('../../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

const upstreamMethods = () => grpcCallMock.mock.calls.map(([, method]) => method)
const upstreamRequest = (rpc: string) => grpcCallMock.mock.calls.find(([, method]) => method === rpc)?.[2]
const NOW_S = () => Math.floor(Date.now() / 1000)
const claimsOf = (token: string) => jwt.decode(token) as jwt.JwtPayload

beforeEach(() => {
  grpcCallMock.mockReset()
  grpcCallMock.mockImplementation(fakeGrpcCall)
  resetUpstreamCallers()
  resetFakeSecondFactors()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('admin sign-in', () => {
  let app: FastifyInstance
  const logLines: string[] = []

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk, _encoding, done) {
        logLines.push(String(chunk))
        done()
      },
    })
    app = await buildApp({
      rateLimits: { globalMax: 1_000_000, authMax: 1_000_000 },
      loggerInstance: pino({ level: 'trace' }, sink),
    })
    await app.ready()
  })
  afterAll(() => app.close())
  beforeEach(() => {
    logLines.length = 0
  })

  const post = (url: string, body?: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, ...(body ? { payload: body } : {}), headers })
  const login = (email: string, password = FAKE_PASSWORD) => post('/api/admin/auth/login', { email, password })
  const enroll = (challenge: string) => post('/api/admin/auth/enroll', { challenge })
  const verify = (challenge: string, code: string) => post('/api/admin/auth/verify', { challenge, code })
  const renew = (headers: Record<string, string>) => post('/api/admin/auth/renew', undefined, headers)
  const signinLines = () =>
    logLines.map((line) => JSON.parse(line)).filter((line) => line.audit === 'admin.signin')

  describe('POST /admin/auth/login', () => {
    it('answers a suspended admin’s correct password with 403 ACCOUNT_SUSPENDED and no challenge (B10)', async () => {
      fakeSuspended.add(ids.admin)
      try {
        const res = await login(emailOf(ids.admin))
        expect(res.statusCode, res.body).toBe(403)
        expect(res.json()).toEqual({
          error: { code: 'ACCOUNT_SUSPENDED', message: 'Sua conta está suspensa. Entre em contato com o suporte.' },
        })
        expect(upstreamMethods()).not.toContain('GetSecondFactorState')
        expect(signinLines()).toEqual([expect.objectContaining({ step: 'password', outcome: 'failure', reason: 'suspended' })])
        const wrong = await login(emailOf(ids.admin), 'wrong-password')
        expect(wrong.statusCode).toBe(401)
        expect(wrong.json().error.code).toBe('UNAUTHORIZED')
      } finally {
        resetFakeSuspended()
      }
    })

    it("answers a challenge for an admin's password, never a session, checked with required_role ADMIN", async () => {
      const res = await login(emailOf(ids.admin))
      expect(res.statusCode, res.body).toBe(200)
      const body = res.json()
      expect(Object.keys(body).sort()).toEqual(['challenge', 'challengeExpiresAt', 'secondFactor'])
      expect(body.secondFactor).toBe('NOT_ENROLLED')
      expect(claimsOf(body.challenge)).toMatchObject({ sub: String(ids.admin), aud: 'vertice-bff:admin-challenge' })
      expect(body.challengeExpiresAt).toBe(new Date(claimsOf(body.challenge).exp! * 1000).toISOString())
      expect(() => verifyToken(body.challenge)).toThrow()
      expect(upstreamRequest('VerifyCredentials')).toEqual({ email: emailOf(ids.admin), password: FAKE_PASSWORD, requiredRole: 'ADMIN' })
      expect(upstreamRequest('GetSecondFactorState')).toEqual({ userId: ids.admin })
      expect(upstreamCallers.map((c) => c.caller)).toEqual(['service:bff', 'service:bff'])
    })

    it('says ENROLLED for an admin with a confirmed authenticator', async () => {
      setFakeSecondFactor(ids.admin, 'enrolled')
      expect((await login(emailOf(ids.admin))).json().secondFactor).toBe('ENROLLED')
    })

    it("answers a trainer's and a client's correct password exactly like a wrong one", async () => {
      const responses = [
        await login(emailOf(ids.trainerA)),
        await login(emailOf(ids.clientA)),
        await login(emailOf(ids.admin), 'wrong-password'),
        await login('nobody@vertice.test'),
        await login(emailOf(ids.clientA2)),
        await login(emailOf(ids.admin), 'x'.repeat(73)),
      ]
      for (const res of responses) {
        expect(res.statusCode).toBe(401)
        expect(res.body).toBe(responses[0]!.body)
      }
      expect(responses[0]!.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } })
      // No challenge was signed and the second factor was never asked about.
      expect(upstreamMethods().filter((m) => m !== 'VerifyCredentials')).toEqual([])
    })
  })

  describe('POST /admin/auth/enroll', () => {
    it('answers the provisioning URI for a valid challenge, with the service token', async () => {
      const res = await enroll(signAdminChallenge(ids.admin))
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ provisioningUri: expect.stringMatching(/^otpauth:\/\/totp\//) })
      expect(res.headers['cache-control']).toBe('no-store')
      expect(upstreamRequest('StartSecondFactorEnrollment')).toEqual({ userId: ids.admin })
      expect(upstreamCallers).toEqual([{ method: 'StartSecondFactorEnrollment', caller: 'service:bff' }])
    })

    it('is 409 PRECONDITION_FAILED for an admin already enrolled', async () => {
      setFakeSecondFactor(ids.admin, 'enrolled')
      const res = await enroll(signAdminChallenge(ids.admin))
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('PRECONDITION_FAILED')
    })

    it.each([
      ['garbage', () => 'not-a-token'],
      ['a user token', () => plainAdminToken()],
      ['an admin session token', () => adminSessionToken()],
      [
        'an expired challenge',
        () => {
          vi.useFakeTimers({ now: Date.now() - 301_000, toFake: ['Date'] })
          const challenge = signAdminChallenge(ids.admin)
          vi.useRealTimers()
          return challenge
        },
      ],
    ])('is 401 CHALLENGE_INVALID with %s, and asks nothing upstream', async (_, challenge) => {
      const res = await enroll(challenge())
      expect(res.statusCode).toBe(401)
      expect(res.json().error).toEqual({ code: 'CHALLENGE_INVALID', message: 'Sign-in challenge is invalid or expired' })
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it("is 401 CHALLENGE_INVALID when vertice-api says the challenge's user is not an admin", async () => {
      const res = await enroll(signAdminChallenge(ids.trainerA))
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('CHALLENGE_INVALID')
    })
  })

  describe('POST /admin/auth/verify', () => {
    it('signs the admin token after the code: amr incl. "otp", auth_time = iat, 30 minutes, checked upstream', async () => {
      const res = await verify(signAdminChallenge(ids.admin), FAKE_TOTP_CODES[0])
      expect(res.statusCode, res.body).toBe(200)
      const body = res.json()
      const claims = claimsOf(body.token)
      expect(claims).toMatchObject({ sub: String(ids.admin), role: 'ADMIN', amr: ['pwd', 'otp'], aud: 'vertice-api' })
      expect(claims.auth_time).toBe(claims.iat)
      expect(Math.abs(claims.iat! - (NOW_S() - 1))).toBeLessThanOrEqual(1)
      expect(claims.exp! - claims.iat!).toBe(ADMIN_SESSION_TTL_SECONDS)
      expect(body).toEqual({
        token: body.token,
        expiresAt: new Date(claims.exp! * 1000).toISOString(),
        sessionEndsAt: new Date((claims.auth_time + ADMIN_SESSION_MAX_SECONDS) * 1000).toISOString(),
        user: { id: ids.admin, name: 'Admin', email: emailOf(ids.admin), role: 'ADMIN' },
      })
      expect(upstreamRequest('VerifySecondFactor')).toEqual({ userId: ids.admin, code: FAKE_TOTP_CODES[0] })
      // The code with the service token; then the new token itself, on GetUser.
      expect(upstreamCallers).toEqual([
        { method: 'VerifySecondFactor', caller: 'service:bff' },
        { method: 'GetUser', caller: { id: ids.admin, role: 'ADMIN' } },
      ])
      const metadata = grpcCallMock.mock.calls.find(([, m]) => m === 'GetUser')![3]!.metadata!
      expect(metadata.get('authorization')).toEqual([`Bearer ${body.token}`])
    })

    it('is 400 INVALID_SECOND_FACTOR_CODE for a wrong code and for a replayed one, never a 401', async () => {
      const challenge = signAdminChallenge(ids.admin)
      const wrong = await verify(challenge, '000000')
      expect(wrong.statusCode).toBe(400)
      expect(wrong.json().error).toEqual({ code: 'INVALID_SECOND_FACTOR_CODE', message: 'Invalid second-factor code' })
      expect((await verify(challenge, FAKE_TOTP_CODES[1])).statusCode).toBe(200)
      // The same challenge is reusable, but the code's step was used.
      const replayed = await verify(challenge, FAKE_TOTP_CODES[1])
      expect(replayed.statusCode).toBe(400)
      expect(replayed.json().error.code).toBe('INVALID_SECOND_FACTOR_CODE')
    })

    it("is 429 RATE_LIMITED with vertice-api's Retry-After once the factor is locked", async () => {
      const challenge = signAdminChallenge(ids.admin)
      for (let i = 0; i < 5; i++) expect((await verify(challenge, '000000')).statusCode).toBe(400)
      const res = await verify(challenge, FAKE_TOTP_CODES[0])
      expect(res.statusCode).toBe(429)
      expect(res.json().error.code).toBe('RATE_LIMITED')
      expect(res.headers['retry-after']).toBe(String(FAKE_LOCK_SECONDS))
      expect(res.body).not.toContain(String(FAKE_LOCK_SECONDS))
    })

    it('waits 60 seconds when the lock names no seconds', async () => {
      grpcCallMock.mockRejectedValueOnce(mapGrpcError({ code: status.RESOURCE_EXHAUSTED, details: 'locked' }))
      const res = await verify(signAdminChallenge(ids.admin), FAKE_TOTP_CODES[0])
      expect(res.statusCode).toBe(429)
      expect(res.headers['retry-after']).toBe('60')
    })

    it.each(['12345', '1234567', '12a456', ' 123456', ''])('is 400 for the code %j, with no upstream call', async (code) => {
      const res = await verify(signAdminChallenge(ids.admin), code)
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it('is 409 PRECONDITION_FAILED with no authenticator on record (reset since the password step)', async () => {
      setFakeSecondFactor(ids.admin, 'none')
      const res = await verify(signAdminChallenge(ids.admin), FAKE_TOTP_CODES[0])
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('PRECONDITION_FAILED')
    })

    it('is 401 CHALLENGE_INVALID when vertice-api refuses the new token (suspended or reset meanwhile)', async () => {
      grpcCallMock.mockImplementation(async (client, method, request, options) => {
        if (method === 'GetUser') throw mapGrpcError({ code: status.UNAUTHENTICATED, details: 'Session no longer valid' })
        return fakeGrpcCall(client, method, request, options)
      })
      const res = await verify(signAdminChallenge(ids.admin), FAKE_TOTP_CODES[0])
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('CHALLENGE_INVALID')
      expect(res.body).not.toContain('token')
    })

    it('is 401 CHALLENGE_INVALID for an invalid challenge, before the code goes upstream', async () => {
      const res = await verify(adminSessionToken(), FAKE_TOTP_CODES[0])
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('CHALLENGE_INVALID')
      expect(grpcCallMock).not.toHaveBeenCalled()
    })
  })

  describe('POST /admin/auth/renew', () => {
    it('extends to iat + 30 minutes with the same auth_time, after GetUser with the current token', async () => {
      const current = adminSessionToken(ids.admin, 600)
      const res = await renew({ authorization: `Bearer ${current}` })
      expect(res.statusCode, res.body).toBe(200)
      const claims = claimsOf(res.json().token)
      expect(claims.auth_time).toBe(claimsOf(current).auth_time)
      expect(claims.exp! - claims.iat!).toBe(ADMIN_SESSION_TTL_SECONDS)
      expect(claims.exp).toBeGreaterThan(claimsOf(current).exp!)
      expect(res.json().sessionEndsAt).toBe(new Date((claims.auth_time + ADMIN_SESSION_MAX_SECONDS) * 1000).toISOString())
      expect(upstreamCallers).toEqual([{ method: 'GetUser', caller: { id: ids.admin, role: 'ADMIN' } }])
      expect(upstreamRequest('GetUser')).toEqual({ id: ids.admin })
    })

    it('in the same second as the sign-in still gives a token with iat >= auth_time, accepted by both checks', async () => {
      const authTime = NOW_S()
      const current = signAdminToken({ id: ids.admin, authTime, issuedAt: authTime })
      const res = await renew({ authorization: `Bearer ${current}` })
      expect(res.statusCode, res.body).toBe(200)
      const next = res.json().token
      expect(claimsOf(next).iat).toBe(authTime)
      expect(verifyToken(next)).toEqual({ id: ids.admin, role: 'ADMIN', authTime })
      // The fake's D6 check, with the renewed token.
      expect((await renew({ authorization: `Bearer ${next}` })).statusCode).toBe(200)
    })

    it('at auth_time + 11h50m expires at exactly auth_time + 12h', async () => {
      const authTime = NOW_S() - (11 * 3600 + 50 * 60)
      const current = signAdminToken({ id: ids.admin, authTime, issuedAt: NOW_S() - 60 })
      const res = await renew({ authorization: `Bearer ${current}` })
      expect(res.statusCode, res.body).toBe(200)
      expect(claimsOf(res.json().token).exp).toBe(authTime + ADMIN_SESSION_MAX_SECONDS)
      expect(res.json().expiresAt).toBe(res.json().sessionEndsAt)
    })

    it('refuses a token past its exp with 401, before any upstream call', async () => {
      vi.useFakeTimers({ now: Date.now() - (ADMIN_SESSION_TTL_SECONDS + 10) * 1000, toFake: ['Date'] })
      const expired = adminSessionToken()
      vi.useRealTimers()
      const res = await renew({ authorization: `Bearer ${expired}` })
      expect(res.statusCode).toBe(401)
      expect(res.json().error.code).toBe('UNAUTHORIZED')
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it('answers 401 UNAUTHENTICATED with no token when vertice-api refuses the session (suspended, password changed)', async () => {
      grpcCallMock.mockRejectedValueOnce(mapGrpcError({ code: status.UNAUTHENTICATED, details: 'Session no longer valid' }))
      const res = await renew(bearer('admin'))
      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Session no longer valid' } })
    })

    it.each(['trainerA', 'clientA'] as const)('is 403 for %s, before any upstream call', async (actor) => {
      const res = await renew(bearer(actor, { mobile: true }))
      expect(res.statusCode).toBe(403)
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it('refuses a challenge as the bearer', async () => {
      const res = await renew({ authorization: `Bearer ${signAdminChallenge(ids.admin)}` })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('the admin.signin log line (spec §4, the VRT-19 alarm)', () => {
    it('writes one line per attempt with step, outcome, reason and userId, and nothing secret', async () => {
      await login(emailOf(ids.trainerA))
      const challenge = (await login(emailOf(ids.admin))).json().challenge
      const enrolled = await enroll(challenge)
      await verify(challenge, '000000')
      const session = await verify(challenge, FAKE_TOTP_CODES[0])
      await enroll('forged')
      await verify(challenge, 'abc')

      expect(signinLines().map(({ level, audit, step, outcome, reason, userId, msg }) => ({ level, audit, step, outcome, reason, userId, msg }))).toEqual([
        { level: 30, audit: 'admin.signin', step: 'password', outcome: 'failure', reason: 'invalid_credentials', userId: undefined, msg: 'Admin sign-in' },
        { level: 30, audit: 'admin.signin', step: 'password', outcome: 'success', reason: undefined, userId: ids.admin, msg: 'Admin sign-in' },
        { level: 30, audit: 'admin.signin', step: 'enroll', outcome: 'success', reason: undefined, userId: ids.admin, msg: 'Admin sign-in' },
        { level: 30, audit: 'admin.signin', step: 'code', outcome: 'failure', reason: 'invalid_code', userId: ids.admin, msg: 'Admin sign-in' },
        { level: 30, audit: 'admin.signin', step: 'code', outcome: 'success', reason: undefined, userId: ids.admin, msg: 'Admin sign-in' },
        { level: 30, audit: 'admin.signin', step: 'enroll', outcome: 'failure', reason: 'invalid_challenge', userId: undefined, msg: 'Admin sign-in' },
        { level: 30, audit: 'admin.signin', step: 'code', outcome: 'failure', reason: 'invalid_request', userId: undefined, msg: 'Admin sign-in' },
      ])
      // Numbers pino adds itself (clock, pid, timings) could contain six digits by chance.
      const logs = logLines.join('\n').replace(/"(time|pid|responseTime)":[\d.]+/g, '')
      for (const secret of [
        emailOf(ids.admin),
        emailOf(ids.trainerA),
        FAKE_PASSWORD,
        FAKE_TOTP_CODES[0],
        '000000',
        challenge,
        enrolled.json().provisioningUri,
        'FAKESECRET',
        session.json().token,
      ]) {
        expect(logs).not.toContain(secret)
      }
    })

    it.each([
      ['already_enrolled', 'enroll', async () => {
        setFakeSecondFactor(ids.admin, 'enrolled')
        await enroll(signAdminChallenge(ids.admin))
      }],
      ['not_enrolled', 'code', async () => {
        setFakeSecondFactor(ids.admin, 'none')
        await verify(signAdminChallenge(ids.admin), FAKE_TOTP_CODES[0])
      }],
      ['locked', 'code', async () => {
        setFakeSecondFactor(ids.admin, 'locked')
        await verify(signAdminChallenge(ids.admin), FAKE_TOTP_CODES[0])
      }],
      ['invalid_request', 'password', async () => {
        await post('/api/admin/auth/login', { email: 'not-an-email' })
      }],
    ] as const)('says %s on a %s failure', async (reason, step, attempt) => {
      await attempt()
      expect(signinLines()).toEqual([expect.objectContaining({ step, outcome: 'failure', reason })])
    })

    it('logs an upstream outage as an error, never as a failure', async () => {
      grpcCallMock.mockRejectedValueOnce(mapGrpcError({ code: status.UNAVAILABLE, details: 'down' }))
      const res = await login(emailOf(ids.admin))
      expect(res.statusCode).toBe(503)
      expect(signinLines()).toEqual([expect.objectContaining({ step: 'password', outcome: 'error' })])
      expect(signinLines()[0]).not.toHaveProperty('reason')
    })
  })
})

describe('admin sign-in rate limits', () => {
  let app: FastifyInstance
  const logLines: string[] = []

  beforeEach(async () => {
    logLines.length = 0
    const sink = new Writable({
      write(chunk, _encoding, done) {
        logLines.push(String(chunk))
        done()
      },
    })
    app = await buildApp({
      rateLimits: { authMax: 3, authWindowMs: 15 * 60_000, globalMax: 1_000_000 },
      loggerInstance: pino({ level: 'info' }, sink),
    })
    await app.ready()
  })
  afterEach(() => app.close())

  const post = (url: string, body: object, remoteAddress = '203.0.113.1') =>
    app.inject({ method: 'POST', url, payload: body, remoteAddress })

  it("counts a non-admin's correct password as a failure, and logs the bucket's 429 as rate_limited", async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await post('/api/admin/auth/login', { email: emailOf(ids.trainerA), password: FAKE_PASSWORD }, `203.0.113.${i}`)
      expect(res.statusCode).toBe(401)
    }
    const res = await post('/api/admin/auth/login', { email: emailOf(ids.trainerA), password: FAKE_PASSWORD }, '203.0.113.9')
    expect(res.statusCode).toBe(429)
    expect(res.json().error.code).toBe('RATE_LIMITED')
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    const last = logLines.map((line) => JSON.parse(line)).filter((line) => line.audit === 'admin.signin').at(-1)
    expect(last).toMatchObject({ step: 'password', outcome: 'failure', reason: 'rate_limited' })
    expect(last).not.toHaveProperty('userId')
  })

  it("doesn't count successful logins or codes", async () => {
    for (let i = 0; i < 4; i++) {
      expect((await post('/api/admin/auth/login', { email: emailOf(ids.admin), password: FAKE_PASSWORD })).statusCode).toBe(200)
    }
    const challenge = signAdminChallenge(ids.admin)
    for (const code of FAKE_TOTP_CODES) {
      expect((await post('/api/admin/auth/verify', { challenge, code })).statusCode).toBe(200)
    }
  })

  it('counts every enroll, per admin across IPs', async () => {
    const challenge = signAdminChallenge(ids.admin)
    for (let i = 1; i <= 3; i++) {
      expect((await post('/api/admin/auth/enroll', { challenge }, `198.51.100.${i}`)).statusCode).toBe(200)
    }
    expect((await post('/api/admin/auth/enroll', { challenge }, '198.51.100.9')).statusCode).toBe(429)
  })

  it('keys wrong codes on the admin, across IPs', async () => {
    const challenge = signAdminChallenge(ids.admin)
    for (let i = 1; i <= 3; i++) {
      expect((await post('/api/admin/auth/verify', { challenge, code: '000000' }, `198.51.100.${i}`)).statusCode).toBe(400)
    }
    expect((await post('/api/admin/auth/verify', { challenge, code: FAKE_TOTP_CODES[0] }, '198.51.100.9')).statusCode).toBe(429)
  })
})
