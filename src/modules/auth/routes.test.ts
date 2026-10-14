import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { status } from '@grpc/grpc-js'
import jwt from 'jsonwebtoken'
import { buildApp } from '../../app.js'
import { env } from '../../config/env.js'
import { grpcCall, mapGrpcError } from '../../grpc/call.js'
import {
  bearer,
  emailOf,
  FAKE_PASSWORD,
  fakeGrpcCall,
  ids,
  resetUpstreamCallers,
  setupTokenFor,
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

const NEW_PASSWORD = 'nova-senha-123'

beforeEach(() => {
  grpcCallMock.mockReset()
  grpcCallMock.mockImplementation(fakeGrpcCall)
})

describe('auth routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    // Out of the way here; the rate-limit block below builds its own app with the real limits.
    app = await buildApp({ rateLimits: { globalMax: 1_000_000, authMax: 1_000_000 } })
    await app.ready()
  })
  afterAll(() => app.close())

  const post = (url: string, body: object, headers = {}) => app.inject({ method: 'POST', url, payload: body, headers })
  const login = (email: string, password: string) => post('/api/auth/login', { email, password })

  describe('POST /auth/login', () => {
    it('signs a token for the right password, checked upstream by VerifyCredentials', async () => {
      const res = await login(emailOf(ids.clientA), FAKE_PASSWORD)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ token: expect.any(String), user: { id: ids.clientA, role: 'CLIENT' } })
      expect(upstreamRequest('VerifyCredentials')).toEqual({ email: emailOf(ids.clientA), password: FAKE_PASSWORD })
    })

    it('returns name and email in the body but keeps them out of the token, and logs in as the BFF', async () => {
      resetUpstreamCallers()
      const res = await login(emailOf(ids.clientA), FAKE_PASSWORD)
      const { token, user } = res.json()
      expect(user).toEqual({ id: ids.clientA, name: 'Client A', email: emailOf(ids.clientA), role: 'CLIENT' })
      expect(jwt.decode(token)).toEqual({
        sub: String(ids.clientA),
        id: ids.clientA,
        role: 'CLIENT',
        iss: 'vertice-bff',
        aud: 'vertice-api',
        iat: expect.any(Number),
        exp: expect.any(Number),
      })
      // No user is behind the login call itself: VerifyCredentials goes out with the service token.
      expect(upstreamCallers).toEqual([{ method: 'VerifyCredentials', caller: 'service' }])
    })

    it('answers a wrong password, an unknown email and a user without a password with the same 401 body', async () => {
      const wrong = await login(emailOf(ids.clientA), 'wrong-password')
      const unknown = await login('nobody@vertice.test', FAKE_PASSWORD)
      const noPassword = await login(emailOf(ids.clientA2), FAKE_PASSWORD)
      for (const res of [wrong, unknown, noPassword]) expect(res.statusCode).toBe(401)
      expect(wrong.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } })
      expect(unknown.body).toBe(wrong.body)
      expect(noPassword.body).toBe(wrong.body)
    })

    it('never scans ListUsers', async () => {
      await login(emailOf(ids.clientA), FAKE_PASSWORD)
      await login('nobody@vertice.test', 'x')
      expect(upstreamMethods()).not.toContain('ListUsers')
    })

    it('trims and lower-cases the email before it goes upstream', async () => {
      const res = await login(`  USER${ids.clientA}@Vertice.TEST `, FAKE_PASSWORD)
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('VerifyCredentials')).toMatchObject({ email: emailOf(ids.clientA) })
    })

    it('treats a password over 72 bytes as wrong without asking upstream', async () => {
      const res = await login(emailOf(ids.clientA), 'é'.repeat(37))
      expect(res.statusCode).toBe(401)
      expect(res.json().error.message).toBe('Invalid email or password')
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    describe('with VERIFY_PASSWORDS=false (rollout window)', () => {
      beforeEach(() => {
        env.VERIFY_PASSWORDS = false
      })
      afterEach(() => {
        env.VERIFY_PASSWORDS = true
      })

      it('accepts any password for an existing email, via the old ListUsers lookup', async () => {
        const res = await login(emailOf(ids.clientA2), 'anything')
        expect(res.statusCode, res.body).toBe(200)
        expect(res.json().user.id).toBe(ids.clientA2)
        expect(upstreamMethods()).toEqual(['ListUsers'])
      })

      it('still refuses an unknown email with the same 401 body', async () => {
        const res = await login('nobody@vertice.test', 'anything')
        expect(res.statusCode).toBe(401)
        expect(res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } })
      })
    })
  })

  describe('POST /auth/register', () => {
    const body = { name: 'Nova', email: ' Nova@Vertice.test', password: 'secret-123', role: 'TRAINER' }

    it('creates a TRAINER without scanning ListUsers, email normalized', async () => {
      const res = await post('/api/auth/register', body)
      expect(res.statusCode, res.body).toBe(201)
      expect(upstreamMethods()).toEqual(['CreateUser'])
      expect(upstreamRequest('CreateUser')).toMatchObject({ email: 'nova@vertice.test', role: 'TRAINER' })
    })

    it('refuses role CLIENT with a 400: clients are created by their trainer', async () => {
      const res = await post('/api/auth/register', { ...body, role: 'CLIENT' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it.each([
      ['shorter than 8 characters', 'abc1234'],
      ['blank', ' '.repeat(10)],
      ['over 72 bytes', 'é'.repeat(37)],
    ])('refuses a password %s', async (_why, password) => {
      const res = await post('/api/auth/register', { ...body, password })
      expect(res.statusCode).toBe(400)
      expect(grpcCallMock).not.toHaveBeenCalled()
    })
  })

  describe('POST /auth/password/setup', () => {
    it('sets the password with the token', async () => {
      const token = setupTokenFor(ids.clientA2)
      const res = await post('/api/auth/password/setup', { token, newPassword: NEW_PASSWORD })
      expect(res.statusCode, res.body).toBe(204)
      expect(upstreamRequest('SetPasswordWithToken')).toEqual({ token, password: NEW_PASSWORD })
    })

    it('maps a bad, expired or used token to 400 INVALID_SETUP_TOKEN, not a 401', async () => {
      const res = await post('/api/auth/password/setup', { token: 'not-a-token', newPassword: NEW_PASSWORD })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('INVALID_SETUP_TOKEN')
    })

    it('checks the password policy before calling upstream', async () => {
      const res = await post('/api/auth/password/setup', { token: setupTokenFor(ids.clientA2), newPassword: 'short' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
      expect(grpcCallMock).not.toHaveBeenCalled()
    })
  })

  describe('POST /auth/password', () => {
    const change = (currentPassword: string, newPassword = NEW_PASSWORD) =>
      post('/api/auth/password', { currentPassword, newPassword }, bearer('clientA'))

    it("re-checks the current password against the caller's email, then sets the new one", async () => {
      const res = await change(FAKE_PASSWORD)
      expect(res.statusCode, res.body).toBe(204)
      expect(upstreamRequest('VerifyCredentials')).toEqual({ email: emailOf(ids.clientA), password: FAKE_PASSWORD })
      expect(upstreamRequest('SetUserPassword')).toEqual({ id: ids.clientA, password: NEW_PASSWORD })
    })

    it('answers a wrong current password with 400 INVALID_CURRENT_PASSWORD (not a logout 401), changing nothing', async () => {
      const res = await change('wrong-password')
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('INVALID_CURRENT_PASSWORD')
      expect(upstreamMethods()).not.toContain('SetUserPassword')
    })

    it('checks the new password against the policy', async () => {
      const res = await change(FAKE_PASSWORD, 'short')
      expect(res.statusCode).toBe(400)
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it('needs a token', async () => {
      const res = await post('/api/auth/password', { currentPassword: FAKE_PASSWORD, newPassword: NEW_PASSWORD })
      expect(res.statusCode).toBe(401)
    })
  })
})

describe('auth rate limits', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildApp({ rateLimits: { authMax: 5, authWindowMs: 15 * 60_000, globalMax: 1_000_000 } })
    await app.ready()
  })
  afterEach(() => app.close())

  const login = (email: string, password: string, remoteAddress = '203.0.113.1') =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress })

  it('answers the 6th failed login for one email with 429, even from other IPs and with the right password', async () => {
    for (let i = 1; i <= 5; i++) {
      expect((await login(emailOf(ids.clientA), 'wrong', `203.0.113.${i}`)).statusCode).toBe(401)
    }
    const res = await login(emailOf(ids.clientA), FAKE_PASSWORD, '203.0.113.99')
    expect(res.statusCode).toBe(429)
    expect(res.json().error.code).toBe('RATE_LIMITED')
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(upstreamMethods().filter((m) => m === 'VerifyCredentials')).toHaveLength(5)
  })

  it('keys the email bucket on the normalized email', async () => {
    for (let i = 1; i <= 5; i++) await login(emailOf(ids.clientA), 'wrong', `203.0.113.${i}`)
    const res = await login(`  USER${ids.clientA}@VERTICE.test`, 'wrong', '203.0.113.99')
    expect(res.statusCode).toBe(429)
  })

  it('answers the 6th failed login from one IP with 429, whatever the email', async () => {
    for (let i = 1; i <= 5; i++) expect((await login(`nobody${i}@vertice.test`, 'wrong')).statusCode).toBe(401)
    expect((await login(emailOf(ids.trainerA), FAKE_PASSWORD)).statusCode).toBe(429)
    // Another IP and another email are unaffected.
    expect((await login(emailOf(ids.trainerA), FAKE_PASSWORD, '198.51.100.7')).statusCode).toBe(200)
  })

  it('does not count successful logins (a shared gym IP keeps working)', async () => {
    for (let i = 0; i < 10; i++) expect((await login(emailOf(ids.clientA), FAKE_PASSWORD)).statusCode).toBe(200)
    expect((await login(emailOf(ids.clientA), 'wrong')).statusCode).toBe(401)
  })

  it('does not count upstream outages', async () => {
    grpcCallMock.mockRejectedValue(mapGrpcError({ code: status.UNAVAILABLE, details: '' }))
    for (let i = 0; i < 6; i++) expect((await login(emailOf(ids.clientA), 'wrong')).statusCode).toBe(503)
    grpcCallMock.mockImplementation(fakeGrpcCall)
    expect((await login(emailOf(ids.clientA), FAKE_PASSWORD)).statusCode).toBe(200)
  })

  it('counts every register attempt, successful or not', async () => {
    const register = (i: number) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { name: 'N', email: `n${i}@vertice.test`, password: 'secret-123', role: 'TRAINER' },
        remoteAddress: '203.0.113.1',
      })
    for (let i = 1; i <= 5; i++) expect((await register(i)).statusCode).toBe(201)
    expect((await register(6)).statusCode).toBe(429)
  })

  it('answers the 6th bad setup token from one IP with 429', async () => {
    const setup = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/password/setup',
        payload: { token, newPassword: NEW_PASSWORD },
        remoteAddress: '203.0.113.1',
      })
    for (let i = 1; i <= 5; i++) expect((await setup(`guess-${i}`)).statusCode).toBe(400)
    expect((await setup(setupTokenFor(ids.clientA2))).statusCode).toBe(429)
  })

  describe('behind vertice-web-react (TRUST_PROXY = the web server)', () => {
    const WEB_SERVER = '10.0.0.5'
    let proxied: FastifyInstance

    beforeEach(async () => {
      proxied = await buildApp({ trustProxy: WEB_SERVER, rateLimits: { authMax: 5, globalMax: 1_000_000 } })
      await proxied.ready()
    })
    afterEach(() => proxied.close())

    // A distinct email per attempt, so only the IP bucket can fill.
    let n = 0
    const loginVia = (remoteAddress: string, forwardedFor: string) =>
      proxied.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: `typo${n++}@vertice.test`, password: 'wrong' },
        remoteAddress,
        headers: { 'x-forwarded-for': forwardedFor },
      })

    it('puts each forwarded client IP from the trusted web server in its own bucket', async () => {
      for (let i = 0; i < 5; i++) expect((await loginVia(WEB_SERVER, '198.51.100.1')).statusCode).toBe(401)
      expect((await loginVia(WEB_SERVER, '198.51.100.1')).statusCode).toBe(429)
      // Another web user, through the same web server, is unaffected.
      expect((await loginVia(WEB_SERVER, '198.51.100.2')).statusCode).toBe(401)
    })

    it('keys on the address the web server appended, not a spoofed entry before it', async () => {
      for (let i = 0; i < 5; i++) {
        expect((await loginVia(WEB_SERVER, `192.0.2.${i}, 198.51.100.1`)).statusCode).toBe(401)
      }
      expect((await loginVia(WEB_SERVER, '192.0.2.200, 198.51.100.1')).statusCode).toBe(429)
    })

    it("ignores X-Forwarded-For from a peer it doesn't trust", async () => {
      for (let i = 0; i < 5; i++) {
        expect((await loginVia('203.0.113.9', `198.51.100.${i + 10}`)).statusCode).toBe(401)
      }
      // A fresh spoofed client IP doesn't escape the peer's own bucket.
      expect((await loginVia('203.0.113.9', '198.51.100.99')).statusCode).toBe(429)
    })
  })

  it('caps one IPv6 /48 at 20 × the limit, however many /64s and emails it rotates through', async () => {
    let n = 0
    const fromNet = (net: string) =>
      login(`spray${n++}@vertice.test`, 'wrong', `${net}:${(n % 65_536).toString(16)}::1`)
    // 100 failures, each from a fresh /64 with a fresh email: none of those buckets fills...
    for (let i = 0; i < 100; i++) expect((await fromNet('2001:db8:1')).statusCode).toBe(401)
    // ...but the /48 does, before any new /64 or email bucket is allocated.
    expect((await fromNet('2001:db8:1')).statusCode).toBe(429)
    expect((await fromNet('2001:db8:2')).statusCode).toBe(401)
  })

  it('has a loose global bucket over every route', async () => {
    const strict = await buildApp({ rateLimits: { globalMax: 3 } })
    try {
      for (let i = 0; i < 3; i++) expect((await strict.inject({ url: '/health' })).statusCode).toBe(200)
      const res = await strict.inject({ url: '/health' })
      expect(res.statusCode).toBe(429)
      expect(res.json().error.code).toBe('RATE_LIMITED')
    } finally {
      await strict.close()
    }
  })
})
