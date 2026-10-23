import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { status } from '@grpc/grpc-js'
import jwt from 'jsonwebtoken'
import { buildApp } from '../../app.js'
import { env } from '../../config/env.js'
import { grpcCall, mapGrpcError } from '../../grpc/call.js'
import {
  addFakeUsers,
  bearer,
  cpfOf,
  emailOf,
  FAKE_CONSENT_AT,
  FAKE_PASSWORD,
  fakeGrpcCall,
  fakeUpstreamProfile,
  ids,
  listUsersPageCalls,
  resetFakeConsents,
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
        role: 'CLIENT',
        iss: 'vertice-bff',
        aud: 'vertice-api',
        iat: expect.any(Number),
        exp: expect.any(Number),
      })
      // No user is behind the login call itself: VerifyCredentials goes out with the service token.
      expect(upstreamCallers).toEqual([{ method: 'VerifyCredentials', caller: 'service:bff' }])
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

    describe('with VERIFY_PASSWORDS=false (rollout window, against the API local profile)', () => {
      beforeEach(() => {
        env.VERIFY_PASSWORDS = false
        fakeUpstreamProfile.local = true
      })
      afterEach(() => {
        env.VERIFY_PASSWORDS = true
        fakeUpstreamProfile.local = false
      })

      it('accepts any password for an existing email, via an anonymous ListUsers lookup', async () => {
        resetUpstreamCallers()
        const res = await login(emailOf(ids.clientA2), 'anything')
        expect(res.statusCode, res.body).toBe(200)
        expect(res.json().user.id).toBe(ids.clientA2)
        expect(upstreamCallers).toEqual([{ method: 'ListUsers', caller: 'anonymous' }])
      })

      it('still refuses an unknown email with the same 401 body', async () => {
        const res = await login('nobody@vertice.test', 'anything')
        expect(res.statusCode).toBe(401)
        expect(res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } })
      })

      describe('with more users than one ListUsers page (100)', () => {
        let extra: ReturnType<typeof addFakeUsers>
        beforeEach(() => {
          extra = addFakeUsers(230)
          resetUpstreamCallers()
        })
        afterEach(() => extra.remove())

        it('finds a user on a later page', async () => {
          const last = extra.ids.at(-1)!
          const res = await login(emailOf(last).toUpperCase(), 'anything')
          expect(res.statusCode, res.body).toBe(200)
          expect(res.json().user.id).toBe(last)
          expect(listUsersPageCalls.map((c) => c.pageToken)).toEqual(['', expect.any(String), expect.any(String)])
          expect(new Set(upstreamCallers.map((c) => c.caller))).toEqual(new Set(['anonymous']))
        })

        it('stops paging at the page that has the user', async () => {
          const res = await login(emailOf(ids.clientA), 'anything')
          expect(res.statusCode, res.body).toBe(200)
          expect(listUsersPageCalls).toHaveLength(1)
        })

        it('reads every page before refusing an unknown email', async () => {
          const res = await login('nobody@vertice.test', 'anything')
          expect(res.statusCode).toBe(401)
          expect(listUsersPageCalls).toHaveLength(3)
        })
      })
    })
  })

  describe('POST /auth/register', () => {
    const body = {
      name: 'Nova',
      email: ' Nova@Vertice.test',
      password: 'secret-123',
      role: 'TRAINER',
      cpf: '52998224725',
      acceptedTermsVersion: '2026-10-draft',
    }

    it('creates a TRAINER without scanning ListUsers, email normalized', async () => {
      const res = await post('/api/auth/register', body)
      expect(res.statusCode, res.body).toBe(201)
      expect(upstreamMethods()).toEqual(['CreateUser'])
      expect(upstreamRequest('CreateUser')).toMatchObject({ email: 'nova@vertice.test', role: 'TRAINER' })
    })

    it('passes the accepted Terms version to CreateUser, and nothing else from the body', async () => {
      const res = await post('/api/auth/register', { ...body, cpf: '52998224725', extra: 'x', consent: { terms: 'v9' } })
      expect(res.statusCode, res.body).toBe(201)
      expect(upstreamRequest('CreateUser')).toEqual({
        name: 'Nova',
        email: 'nova@vertice.test',
        password: 'secret-123',
        cpf: '52998224725',
        cref: '',
        role: 'TRAINER',
        acceptedTermsVersion: '2026-10-draft',
      })
    })

    it('refuses a registration without an accepted Terms version, before any upstream call', async () => {
      const withoutTerms: Partial<typeof body> = { ...body }
      delete withoutTerms.acceptedTermsVersion
      const res = await post('/api/auth/register', withoutTerms)
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
      expect(res.json().error.details.fieldErrors).toHaveProperty('acceptedTermsVersion')
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it.each([
      ['empty', ''],
      ['too long', 'v'.repeat(33)],
      ['with a space', '2026 10'],
      ['with a slash', '2026/10'],
      ['not a string', true],
      ['null', null],
    ])('refuses an accepted Terms version that is %s', async (_why, acceptedTermsVersion) => {
      const res = await post('/api/auth/register', { ...body, acceptedTermsVersion })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
      expect(res.json().error.details.fieldErrors).toHaveProperty('acceptedTermsVersion')
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it.each(['v1.2', '2026-10-14', 'A_b-9.x', 'v'.repeat(32)])('accepts the version %s', async (acceptedTermsVersion) => {
      const res = await post('/api/auth/register', { ...body, acceptedTermsVersion })
      expect(res.statusCode, res.body).toBe(201)
    })

    it.each([
      ['CPF already in use: 529.982.247-25'],
      ['Email already in use: nova@vertice.test'],
      ['CPF already in use'],
    ])('answers a duplicate (%j upstream) with one fixed 409 that names no value', async (details) => {
      grpcCallMock.mockImplementation(async (_client, method) => {
        if (method === 'CreateUser') throw mapGrpcError({ code: status.ALREADY_EXISTS, details })
        throw new Error(`unexpected ${method}`)
      })
      const res = await post('/api/auth/register', { ...body, cpf: '52998224725' })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: { code: 'CONFLICT', message: 'Email or CPF already in use' } })
      expect(res.body).not.toMatch(/\d|@/)
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

  describe('GET /auth/me', () => {
    it("returns the caller's own account and consent state, the CPF masked", async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer('trainerA') })
      expect(res.statusCode, res.body).toBe(200)
      // Upstream sends the self view (CPF in full) to the user themself; the BFF masks it.
      expect(res.json()).toEqual({
        id: ids.trainerA,
        name: 'Trainer A',
        email: emailOf(ids.trainerA),
        cpf: '***.***.***-10',
        cref: `CREF-${ids.trainerA}`,
        role: 'TRAINER',
        whatsapp: '',
        instagram: '',
        showEmail: false,
        showWhatsapp: false,
        showInstagram: false,
        consent: {
          termsVersion: '2026-01',
          termsAcceptedAt: '2026-01-15T12:00:00Z',
          healthDataVersion: null,
          healthDataConsentAt: null,
        },
      })
      expect(res.body).not.toMatch(/52998224/)
    })

    it('answers null for every consent not given yet', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer('clientA') })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().consent).toEqual({
        termsVersion: null,
        termsAcceptedAt: null,
        healthDataVersion: null,
        healthDataConsentAt: null,
      })
    })

    it('answers all-null consent when upstream sends no consent message at all', async () => {
      grpcCallMock.mockResolvedValueOnce({
        id: String(ids.clientA),
        name: 'Client A',
        email: emailOf(ids.clientA),
        cpf: '',
        cref: '',
        role: 'CLIENT',
        consent: null,
      } as never)
      const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer('clientA') })
      expect(res.statusCode, res.body).toBe(200)
      expect(Object.values(res.json().consent)).toEqual([null, null, null, null])
    })
  })

  describe('POST /auth/me/consent', () => {
    afterEach(() => resetFakeConsents())

    const consent = (body: unknown, as: Parameters<typeof bearer>[0] = 'clientA') =>
      app.inject({ method: 'POST', url: '/api/auth/me/consent', payload: body as object, headers: bearer(as) })

    it("records the caller's health-data consent with their own token and returns the new state", async () => {
      resetUpstreamCallers()
      const res = await consent({ type: 'HEALTH_DATA', version: '2026-10-draft' })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({
        termsVersion: null,
        termsAcceptedAt: null,
        healthDataVersion: '2026-10-draft',
        healthDataConsentAt: FAKE_CONSENT_AT,
      })
      expect(upstreamRequest('RecordConsent')).toEqual({ type: 'HEALTH_DATA', version: '2026-10-draft' })
      expect(upstreamCallers).toEqual([{ method: 'RecordConsent', caller: { id: ids.clientA, role: 'CLIENT' } }])
      // GET /auth/me reads it back.
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer('clientA') })
      expect(me.json().consent.healthDataVersion).toBe('2026-10-draft')
    })

    it('records a newer Terms version over the one accepted at registration', async () => {
      const res = await consent({ type: 'TERMS', version: '2026-10-draft' }, 'trainerA')
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ termsVersion: '2026-10-draft', termsAcceptedAt: FAKE_CONSENT_AT })
    })

    it('never sends a user id upstream, whatever the body says', async () => {
      const res = await consent({ type: 'TERMS', version: 'v1', userId: ids.clientB, id: ids.clientB })
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('RecordConsent')).toEqual({ type: 'TERMS', version: 'v1' })
    })

    it.each([
      ['no type', { version: 'v1' }],
      ['an unknown type', { type: 'MARKETING', version: 'v1' }],
      ['the unspecified type', { type: 'CONSENT_TYPE_UNSPECIFIED', version: 'v1' }],
      ['no version', { type: 'TERMS' }],
      ['an empty version', { type: 'TERMS', version: '' }],
      ['a version over 32 characters', { type: 'TERMS', version: 'v'.repeat(33) }],
      ['a version with a space', { type: 'HEALTH_DATA', version: 'v 1' }],
    ])('refuses %s with a 400 before any upstream call', async (_why, body) => {
      const res = await consent(body)
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
      expect(grpcCallMock).not.toHaveBeenCalled()
    })
  })

  describe('PATCH /auth/me', () => {
    const patch = (body: unknown, as: Parameters<typeof bearer>[0] = 'clientA') =>
      app.inject({ method: 'PATCH', url: '/api/auth/me', payload: body as object, headers: bearer(as) })
    const sentUser = () => (upstreamRequest('UpdateUser') as { id: number; user: Record<string, string> } | undefined)

    it('keeps every omitted field, the CPF included, and sends the stored role', async () => {
      const res = await patch({ name: 'Novo Nome' })
      expect(res.statusCode, res.body).toBe(200)
      expect(sentUser()).toEqual({
        id: ids.clientA,
        user: { name: 'Novo Nome', email: emailOf(ids.clientA), cpf: cpfOf(ids.clientA), cref: '', role: 'CLIENT' },
      })
      // The answer is Me: the CPF masked, the consent state as stored.
      expect(res.json()).toMatchObject({ id: ids.clientA, name: 'Novo Nome', cpf: '***.***.***-20', role: 'CLIENT' })
      expect(res.json().consent).toEqual({
        termsVersion: null,
        termsAcceptedAt: null,
        healthDataVersion: null,
        healthDataConsentAt: null,
      })
      expect(res.body).not.toMatch(/52998224/)
    })

    it('sets a new CPF and email (normalized), and lets a CLIENT remove their CPF with null', async () => {
      await patch({ email: '  Novo@Vertice.TEST ', cpf: '11144477735' })
      expect(sentUser()!.user).toMatchObject({ email: 'novo@vertice.test', cpf: '11144477735' })
      grpcCallMock.mockClear()
      await patch({ cpf: null })
      expect(sentUser()!.user.cpf).toBe('')
    })

    it('ignores a role in the body: the stored one is always sent', async () => {
      const res = await patch({ name: 'X', role: 'ADMIN' }, 'trainerA')
      expect(res.statusCode, res.body).toBe(200)
      expect(sentUser()!.user.role).toBe('TRAINER')
    })

    it("lets a TRAINER change their CREF, keeping it when omitted", async () => {
      await patch({ cref: 'CREF-NOVO' }, 'trainerA')
      expect(sentUser()!.user).toMatchObject({ cref: 'CREF-NOVO', cpf: cpfOf(ids.trainerA) })
      grpcCallMock.mockClear()
      await patch({ name: 'T' }, 'trainerA')
      expect(sentUser()!.user.cref).toBe(`CREF-${ids.trainerA}`)
    })

    it.each([
      ['a masked CPF', { cpf: '***.***.***-20' }],
      ['an empty name', { name: '  ' }],
      ['a malformed email', { email: 'not-an-email' }],
    ])('refuses %s with a 400 before any upstream call', async (_why, body) => {
      const res = await patch(body)
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it.each([
      ['trainerA', 'removing a TRAINER CPF', { cpf: null }],
      ['trainerA', 'an empty TRAINER CPF', { cpf: '' }],
      ['trainerA', 'a TRAINER CPF with a bad check digit', { cpf: '52998224726' }],
      ['clientA', 'a CREF for a CLIENT', { cref: 'CREF-1' }],
    ] as const)('as %s refuses %s with a 400, never calling UpdateUser', async (as, _why, body) => {
      const res = await patch(body, as)
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
      expect(upstreamMethods()).not.toContain('UpdateUser')
    })

    it('needs a token', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/api/auth/me', payload: { name: 'X' } })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('DELETE /auth/me', () => {
    const remove = (body: unknown, as: Parameters<typeof bearer>[0] = 'clientA') =>
      app.inject({ method: 'DELETE', url: '/api/auth/me', payload: body as object, headers: bearer(as) })

    it('re-checks the password, then deletes the account with the caller\'s own token: 204', async () => {
      resetUpstreamCallers()
      const res = await remove({ password: FAKE_PASSWORD })
      expect(res.statusCode, res.body).toBe(204)
      expect(res.body).toBe('')
      expect(upstreamMethods()).toEqual(['GetUser', 'VerifyCredentials', 'DeleteAccount'])
      expect(upstreamRequest('VerifyCredentials')).toEqual({ email: emailOf(ids.clientA), password: FAKE_PASSWORD })
      expect(upstreamRequest('DeleteAccount')).toEqual({})
      for (const { caller } of upstreamCallers) expect(caller).toEqual({ id: ids.clientA, role: 'CLIENT' })
    })

    it('refuses a wrong password with 400 INVALID_CURRENT_PASSWORD (not a logout 401), deleting nothing', async () => {
      const res = await remove({ password: 'wrong-password' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('INVALID_CURRENT_PASSWORD')
      expect(upstreamMethods()).not.toContain('DeleteAccount')
    })

    it.each([
      ['no body', undefined],
      ['no password', {}],
      ['an empty password', { password: '' }],
    ])('requires the password: %s is a 400 before any upstream call', async (_why, body) => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/auth/me',
        headers: bearer('clientA'),
        ...(body === undefined ? {} : { payload: body }),
      })
      expect(res.statusCode).toBe(400)
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it('answers a TRAINER with active clients with 409 ACTIVE_CLIENTS and a fixed message', async () => {
      const res = await remove({ password: FAKE_PASSWORD }, 'trainerA')
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toEqual({
        code: 'ACTIVE_CLIENTS',
        message: 'End your client relationships before deleting your account',
      })
      expect(res.body).not.toContain(String(ids.trainerA))
    })

    it('lets ADMIN delete their own account', async () => {
      const res = await remove({ password: FAKE_PASSWORD }, 'admin')
      expect(res.statusCode, res.body).toBe(204)
    })
  })

  describe('GET /auth/me/export', () => {
    const exportData = (as: Parameters<typeof bearer>[0] = 'clientA') =>
      app.inject({ method: 'GET', url: '/api/auth/me/export', headers: bearer(as) })

    it("passes vertice-api's JSON document through as a no-store file download", async () => {
      const res = await exportData()
      expect(res.statusCode, res.body).toBe(200)
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="vertice-dados-\d{4}-\d{2}-\d{2}\.json"$/)
      expect(res.headers['cache-control']).toBe('no-store')
      // Their own data, the CPF in full: it is the user's own copy (LGPD art. 18 II).
      expect(res.json().profile).toMatchObject({ id: ids.clientA, cpf: cpfOf(ids.clientA) })
      expect(upstreamRequest('ExportUserData')).toEqual({})
    })

    it('names the file after the business date of the export, not the UTC one', async () => {
      // Pinned to 23:30 local on the 11th, which is already the 12th in UTC.
      // `toFake: ['Date']` only: timers stay real, so `app.inject` is not waiting on a frozen clock.
      vi.useFakeTimers({ now: new Date('2026-10-12T02:30:00Z'), toFake: ['Date'] })
      try {
        const res = await exportData()
        expect(res.headers['content-disposition']).toBe('attachment; filename="vertice-dados-2026-10-11.json"')
      } finally {
        vi.useRealTimers()
      }
    })

    it('answers an export over the upstream bounds (RESOURCE_EXHAUSTED) with 413 and a fixed message', async () => {
      grpcCallMock.mockRejectedValueOnce(
        mapGrpcError({ code: status.RESOURCE_EXHAUSTED, details: 'workoutLogs exceeds 20000 rows for user 20' }),
      )
      const res = await exportData()
      expect(res.statusCode).toBe(413)
      expect(res.json()).toEqual({ error: { code: 'TOO_LARGE', message: 'The requested data is too large to return' } })
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['content-disposition']).toBeUndefined()
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
        payload: { name: 'N', email: `n${i}@vertice.test`, password: 'secret-123', role: 'TRAINER', cpf: '52998224725', acceptedTermsVersion: 'v1' },
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

  it('allows 3 data exports per user per window, counting successes, then 429', async () => {
    const limited = await buildApp({ rateLimits: { exportMax: 3, exportWindowMs: 60 * 60_000, globalMax: 1_000_000 } })
    try {
      const exportAs = (as: Parameters<typeof bearer>[0], remoteAddress = '203.0.113.1') =>
        limited.inject({ method: 'GET', url: '/api/auth/me/export', headers: bearer(as), remoteAddress })
      for (let i = 1; i <= 3; i++) expect((await exportAs('clientA', `203.0.113.${i}`)).statusCode).toBe(200)
      // The bucket is the user's: another IP doesn't reset it...
      const res = await exportAs('clientA', '198.51.100.7')
      expect(res.statusCode).toBe(429)
      expect(res.json().error.code).toBe('RATE_LIMITED')
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
      expect(upstreamMethods().filter((m) => m === 'ExportUserData')).toHaveLength(3)
      // ...and another user from the same IP is unaffected.
      expect((await exportAs('trainerA')).statusCode).toBe(200)
    } finally {
      await limited.close()
    }
  })

  it('does not count an export that failed upstream (5xx)', async () => {
    const limited = await buildApp({ rateLimits: { exportMax: 1, globalMax: 1_000_000 } })
    try {
      const exportOnce = () => limited.inject({ method: 'GET', url: '/api/auth/me/export', headers: bearer('clientA') })
      grpcCallMock.mockRejectedValueOnce(mapGrpcError({ code: status.UNAVAILABLE, details: '' }))
      expect((await exportOnce()).statusCode).toBe(503)
      expect((await exportOnce()).statusCode).toBe(200)
      expect((await exportOnce()).statusCode).toBe(429)
    } finally {
      await limited.close()
    }
  })

  it('answers the 6th wrong password on DELETE /auth/me with 429', async () => {
    const remove = (password: string) =>
      app.inject({ method: 'DELETE', url: '/api/auth/me', payload: { password }, headers: bearer('clientA') })
    for (let i = 1; i <= 5; i++) expect((await remove('wrong')).statusCode).toBe(400)
    expect((await remove(FAKE_PASSWORD)).statusCode).toBe(429)
    expect(upstreamMethods()).not.toContain('DeleteAccount')
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
