import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Writable } from 'node:stream'
import { Metadata, status } from '@grpc/grpc-js'
import pino from 'pino'
import { buildApp } from '../../app.js'
import { grpcCall, mapGrpcError } from '../../grpc/call.js'
import {
  bearer,
  cpfOf,
  FAKE_EMAIL_RETRY_SECONDS,
  FAKE_PASSWORD,
  emailOf,
  fakeAdminActions,
  fakeEmailSends,
  fakeFlags,
  fakeGrpcCall,
  fakeSuspended,
  ids,
  resetFakeAdminActions,
  resetFakeFlags,
  resetFakeSuspended,
  resetUpstreamCallers,
  type Actor,
} from '../../test/fakeUpstream.js'
import { LOG_SERIALIZERS, requestSerializer } from '../../lib/log-serializers.js'
import { toActionEntry, toCatalogExercise, toDirectoryUser, toUserProfile } from './service.js'

// Keep the real mapGrpcError: the fake upstream raises its errors through it.
vi.mock('../../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)
/** Call options carrying the fixture admin's token, for calling the fake directly. */
const adminCallOptions = () => {
  const metadata = new Metadata()
  metadata.set('authorization', bearer('admin').authorization)
  return { metadata }
}
const upstreamRequest = (rpc: string) => grpcCallMock.mock.calls.find(([, method]) => method === rpc)?.[2]

beforeEach(() => {
  grpcCallMock.mockReset()
  grpcCallMock.mockImplementation(fakeGrpcCall)
  resetUpstreamCallers()
  resetFakeAdminActions()
})

describe('admin read routes', () => {
  let app: FastifyInstance
  const logLines: string[] = []

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk, _encoding, done) {
        logLines.push(String(chunk))
        done()
      },
    })
    app = await buildApp({ rateLimits: { globalMax: 1_000_000 }, loggerInstance: pino({ level: 'trace', serializers: LOG_SERIALIZERS }, sink) })
    await app.ready()
  })
  afterAll(() => app.close())
  beforeEach(() => {
    logLines.length = 0
  })

  const get = (url: string, as: Actor = 'admin') => app.inject({ method: 'GET', url, headers: bearer(as) })

  describe('GET /admin/dashboard', () => {
    it('reshapes GetDashboard into totals, activity, completed workouts and 12 weeks', async () => {
      const res = await get('/api/admin/dashboard')
      expect(res.statusCode, res.body).toBe(200)
      const body = res.json()
      expect(body.totals).toEqual({ trainers: 2, clients: 3 })
      expect(body.active).toEqual({ trainers7d: 1, clients7d: 2, trainers30d: 2, clients30d: 3 })
      expect(body.completedWorkouts).toEqual({ last7d: 3, last30d: 9 })
      expect(body.weeklySignups).toHaveLength(12)
      expect(body.weeklySignups[0]).toEqual({ weekStart: '2026-08-03', trainers: 0, clients: 0 })
      expect(grpcCallMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('GET /admin/users', () => {
    it('sends the defaults: both roles and statuses, no search, 25 per page', async () => {
      const res = await get('/api/admin/users')
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('ListDirectoryUsers')).toEqual({
        role: 'DIRECTORY_ROLE_UNSPECIFIED',
        status: 'DIRECTORY_STATUS_UNSPECIFIED',
        search: '',
        pageSize: 25,
        pageToken: '',
      })
      expect(res.json().nextCursor).toBeNull()
      // Admins are invisible; upstream order is kept.
      expect(res.json().users.map((u: { id: number }) => u.id)).toEqual([
        ids.clientA,
        ids.clientA2,
        ids.clientB,
        ids.trainerA,
        ids.trainerB,
      ])
    })

    it('adds the enum prefixes, trims the search, and treats empty values as absent', async () => {
      await get('/api/admin/users?role=TRAINER&status=SUSPENDED&q=%20%20ana%20&limit=50&cursor=abc')
      expect(upstreamRequest('ListDirectoryUsers')).toEqual({
        role: 'DIRECTORY_ROLE_TRAINER',
        status: 'DIRECTORY_STATUS_SUSPENDED',
        search: 'ana',
        pageSize: 50,
        pageToken: 'abc',
      })
      grpcCallMock.mockClear()
      await get('/api/admin/users?role=&status=&q=%20%20&limit=&cursor=')
      expect(upstreamRequest('ListDirectoryUsers')).toMatchObject({
        role: 'DIRECTORY_ROLE_UNSPECIFIED',
        status: 'DIRECTORY_STATUS_UNSPECIFIED',
        search: '',
        pageSize: 25,
        pageToken: '',
      })
    })

    it('gives a client their current trainer and no count, a trainer a count and no trainer', async () => {
      const users = (await get('/api/admin/users')).json().users as Record<string, unknown>[]
      const client = users.find((u) => u.id === ids.clientA)!
      const trainer = users.find((u) => u.id === ids.trainerA)!
      expect(client).toMatchObject({ role: 'CLIENT', currentTrainer: { id: ids.trainerA, name: 'Trainer A' }, currentClientCount: null })
      expect(trainer).toMatchObject({ role: 'TRAINER', currentTrainer: null, currentClientCount: 2 })
      expect(Object.keys(client).sort()).toEqual(
        ['createdAt', 'currentClientCount', 'currentTrainer', 'email', 'id', 'lastActiveOn', 'name', 'role', 'suspended'].sort(),
      )
      expect(users.find((u) => u.id === ids.clientA2)!.lastActiveOn).toBeNull()
    })

    it('pages with nextCursor', async () => {
      // Five fixture users, so 10 per page is one page; force upstream to say there is more.
      grpcCallMock.mockImplementationOnce(async () => ({ users: [], nextPageToken: 'next-1' }) as never)
      expect((await get('/api/admin/users?limit=10')).json()).toEqual({ users: [], nextCursor: 'next-1' })
    })

    it.each([
      ['limit=0'],
      ['limit=11'],
      ['limit=100'],
      ['limit=abc'],
      ['role=ADMIN'],
      ['status=DELETED'],
      [`q=${'a'.repeat(101)}`],
      [`q=${'😀'.repeat(51)}`],
      [`cursor=${'c'.repeat(513)}`],
    ])('refuses %s with a 400 and no upstream call', async (query) => {
      const res = await get(`/api/admin/users?${query}`)
      expect(res.statusCode, res.body).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it.each([['limit=10'], ['limit=25'], ['limit=50'], [`q=${'a'.repeat(100)}`]])('accepts %s', async (query) => {
      expect((await get(`/api/admin/users?${query}`)).statusCode).toBe(200)
    })

    it('never writes the search text to the logs (B15): the request line has no query string', async () => {
      const res = await get('/api/admin/users?q=someone%40example.com&limit=10')
      expect(res.statusCode, res.body).toBe(200)
      const incoming = logLines.map((l) => JSON.parse(l)).find((l) => l.msg === 'incoming request')
      expect(incoming.req.url).toBe('/api/admin/users')
      expect(logLines.join('')).not.toMatch(/someone(%40|@)example\.com/)
    })

    it("relays vertice-api's INVALID_ARGUMENT text for a cursor it refuses", async () => {
      const res = await get('/api/admin/users?cursor=garbage')
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'page_token: malformed' })
    })
  })

  describe('GET /admin/users/:id', () => {
    it("answers a client's profile with the masked CPF, current trainer and first-access state", async () => {
      const res = await get(`/api/admin/users/${ids.clientA}`)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
      const body = res.json()
      expect(body).toMatchObject({
        id: ids.clientA,
        role: 'CLIENT',
        cpf: `***.***.***-${cpfOf(ids.clientA).slice(-2)}`,
        suspended: false,
        suspendedAt: null,
        currentTrainer: { user: { id: ids.trainerA, name: 'Trainer A', role: 'TRAINER' }, endedAt: null, suspended: false },
        pastTrainers: [],
        firstAccess: { pending: false, lastSentAt: null, lastSendFailed: false },
      })
      expect(Object.keys(body).sort()).toEqual(
        [
          'completedWorkoutCount',
          'cpf',
          'createdAt',
          'currentTrainer',
          'email',
          'firstAccess',
          'id',
          'lastActiveOn',
          'name',
          'pastTrainers',
          'planCount',
          'role',
          'suspended',
          'suspendedAt',
        ].sort(),
      )
      expect(res.body).not.toContain(cpfOf(ids.clientA))
      expect(upstreamRequest('GetUserProfile')).toEqual({ userId: ids.clientA })
    })

    it("answers a trainer's profile with relationships, counts and only shared contacts", async () => {
      const body = (await get(`/api/admin/users/${ids.trainerA}`)).json()
      expect(body).toMatchObject({
        role: 'TRAINER',
        cref: '123456-G/SP',
        whatsapp: '11987654321',
        instagram: null,
        formerClients: [],
        planCount: 3,
        workoutCount: 1,
        privateExerciseCount: 1,
      })
      expect(body.currentClients.map((r: { user: { id: number } }) => r.user.id)).toEqual([ids.clientA, ids.clientA2])
      expect(body).not.toHaveProperty('firstAccess')
      expect(body).not.toHaveProperty('showWhatsapp')
    })

    it('answers a null CPF for a client without one', async () => {
      expect((await get(`/api/admin/users/${ids.clientA2}`)).json()).toMatchObject({ cpf: null, firstAccess: { pending: true } })
    })

    it('answers NOT_FOUND upstream as the global 404, without the id in the message', async () => {
      const res = await get(`/api/admin/users/${ids.admin}`)
      expect(res.statusCode).toBe(404)
      expect(res.json().error.code).toBe('NOT_FOUND')
      expect(res.json().error.message).not.toContain(String(ids.admin))
    })

    it('refuses a malformed id with a 400 and no upstream call', async () => {
      expect((await get('/api/admin/users/abc')).statusCode).toBe(400)
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it('records a history entry upstream on every call', async () => {
      await get(`/api/admin/users/${ids.clientA}`)
      await get(`/api/admin/users/${ids.clientA}`)
      const res = await get(`/api/admin/actions?targetUserId=${ids.clientA}`)
      expect(res.json().entries).toHaveLength(2)
    })
  })

  describe('GET /admin/actions', () => {
    it('sends the filters with the enum prefix, and strips it on the way out', async () => {
      await get(`/api/admin/users/${ids.clientA}`)
      grpcCallMock.mockClear()
      const res = await get(`/api/admin/actions?adminId=${ids.admin}&action=VIEW_USER_PROFILE&targetUserId=${ids.clientA}&limit=10`)
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('ListActions')).toEqual({
        adminId: ids.admin,
        action: 'ADMIN_ACTION_VIEW_USER_PROFILE',
        targetUserId: ids.clientA,
        pageSize: 10,
        pageToken: '',
      })
      expect(res.json()).toEqual({
        entries: [
          {
            id: 1,
            admin: { id: ids.admin, name: 'Admin', role: 'ADMIN' },
            action: 'VIEW_USER_PROFILE',
            targetUser: { id: ids.clientA, name: 'Client A', role: 'CLIENT' },
            relatedUser: null,
            targetExerciseId: null,
            targetMuscleGroupId: null,
            subjectLabel: null,
            reason: null,
            createdAt: '2026-10-01T12:00:00Z',
          },
        ],
        nextCursor: null,
      })
    })

    it('sends no filter when none is given', async () => {
      await get('/api/admin/actions')
      expect(upstreamRequest('ListActions')).toEqual({
        adminId: 0,
        action: 'ADMIN_ACTION_UNSPECIFIED',
        targetUserId: 0,
        pageSize: 25,
        pageToken: '',
      })
    })

    it.each([['adminId=0'], ['adminId=abc'], ['targetUserId=-3'], ['action=SUSPEND'], ['limit=5']])(
      'refuses %s with a 400 and no upstream call',
      async (query) => {
        expect((await get(`/api/admin/actions?${query}`)).statusCode).toBe(400)
        expect(grpcCallMock).not.toHaveBeenCalled()
      },
    )
  })

  describe('GET /admin/actions/admins', () => {
    it('lists the authors of the history', async () => {
      expect((await get('/api/admin/actions/admins')).json()).toEqual({ admins: [] })
      await get(`/api/admin/users/${ids.clientA}`)
      expect((await get('/api/admin/actions/admins')).json()).toEqual({ admins: [{ id: ids.admin, name: 'Admin', role: 'ADMIN' }] })
    })
  })

  it('answers upstream PERMISSION_DENIED as 403 (vertice-api is the authoritative check)', async () => {
    grpcCallMock.mockImplementationOnce(async () => {
      throw mapGrpcError({ code: status.PERMISSION_DENIED, details: 'AdminService is ADMIN only' })
    })
    const res = await get('/api/admin/dashboard')
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
  })

  it('drops a CPF that is not masked, with a WARN line that does not carry it', async () => {
    const full = cpfOf(ids.clientA)
    grpcCallMock.mockImplementationOnce(async () => {
      const profile = (await fakeGrpcCall(null, 'GetUserProfile', { userId: ids.clientA }, adminCallOptions())) as {
        client: { basics: { cpfMasked: string } }
      }
      profile.client.basics.cpfMasked = full
      return profile as never
    })
    const res = await get(`/api/admin/users/${ids.clientA}`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().cpf).toBeNull()
    expect(res.body).not.toContain(full)
    const warn = logLines.map((l) => JSON.parse(l)).find((l) => l.level === 40)
    expect(warn).toMatchObject({ userId: ids.clientA })
    expect(logLines.join('')).not.toContain(full)
  })
})

describe('admin mapping', () => {
  const basics = {
    id: '20',
    name: 'C',
    email: 'c@x',
    cpfMasked: '',
    suspended: true,
    suspendedAt: '2026-11-01T10:00:00Z',
    createdAt: '2026-10-01T10:00:00Z',
    lastActiveOn: '',
  }

  it.each(['52998224725', '***.***.***-2', '529.982.247-25', '***.***.***-ab'])('fails closed on the CPF %s', (cpfMasked) => {
    const profile = toUserProfile({
      client: { basics: { ...basics, cpfMasked }, currentTrainer: null, pastTrainers: [], planCount: 0, completedWorkoutCount: 0, firstAccess: null },
    })
    expect(profile.cpf).toBeNull()
  })

  it('maps suspension, empty dates and an unset first-access state', () => {
    expect(
      toUserProfile({
        client: { basics, currentTrainer: null, pastTrainers: [], planCount: 1, completedWorkoutCount: 4, firstAccess: null },
      }),
    ).toMatchObject({
      suspended: true,
      suspendedAt: '2026-11-01T10:00:00Z',
      lastActiveOn: null,
      currentTrainer: null,
      firstAccess: { pending: false, lastSentAt: null, lastSendFailed: false },
    })
  })

  it('answers a profile with neither arm set as a 502 bad upstream answer', () => {
    expect(() => toUserProfile({})).toThrow(expect.objectContaining({ statusCode: 502, code: 'UPSTREAM_ERROR' }))
  })

  it('maps a former relationship with its end, and a catalog history entry', () => {
    const profile = toUserProfile({
      trainer: {
        basics,
        cref: '',
        whatsapp: '',
        instagram: '',
        currentClients: [],
        formerClients: [
          { user: { id: '21', name: 'Usuário removido', role: 'CLIENT' }, startedAt: 'a', endedAt: 'b', suspended: false },
        ],
        planCount: 0,
        workoutCount: 0,
        privateExerciseCount: 0,
      },
    })
    expect(profile).toMatchObject({ role: 'TRAINER', cref: null, formerClients: [{ user: { id: 21 }, endedAt: 'b' }] })
    expect(
      toActionEntry({
        id: '7',
        admin: { id: '1', name: 'A', role: 'ADMIN' },
        action: 'ADMIN_ACTION_PROMOTE_EXERCISE',
        targetUser: null,
        relatedUser: { id: '10', name: 'T', role: 'TRAINER' },
        targetExerciseId: '55',
        targetMuscleGroupId: '0',
        subjectLabel: 'Remada',
        reason: '',
        createdAt: 'c',
      }),
    ).toMatchObject({
      action: 'PROMOTE_EXERCISE',
      targetUser: null,
      relatedUser: { id: 10, role: 'TRAINER' },
      targetExerciseId: 55,
      targetMuscleGroupId: null,
      subjectLabel: 'Remada',
      reason: null,
    })
  })

  it('never gives a trainer a current trainer, nor a client a count', () => {
    const row = {
      id: '10',
      name: 'T',
      email: 't@x',
      suspended: false,
      createdAt: 'c',
      lastActiveOn: '2026-11-17',
      currentTrainer: { id: '11', name: 'X', role: 'TRAINER' },
      currentClientCount: 4,
    }
    expect(toDirectoryUser({ ...row, role: 'TRAINER' })).toMatchObject({ currentTrainer: null, currentClientCount: 4 })
    expect(toDirectoryUser({ ...row, role: 'CLIENT' })).toMatchObject({ currentTrainer: { id: 11, name: 'X' }, currentClientCount: null })
  })
})

describe('admin write routes (VRT-28)', () => {
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
      loggerInstance: pino({ level: 'trace', serializers: LOG_SERIALIZERS }, sink),
    })
    await app.ready()
  })
  afterAll(() => app.close())
  beforeEach(() => {
    logLines.length = 0
    resetFakeSuspended()
    fakeEmailSends.mode = 'ok'
  })

  const post = (url: string, body?: object, as: Actor = 'admin') =>
    app.inject({ method: 'POST', url, headers: bearer(as), ...(body ? { payload: body } : {}) })
  const auditLines = () => logLines.map((l) => JSON.parse(l)).filter((l) => l.audit)
  const REASON = 'Conta compartilhada com terceiros'

  describe('suspend and reactivate', () => {
    it('suspends with the trimmed reason and answers the directory row; the history gets the entry', async () => {
      const res = await post(`/api/admin/users/${ids.trainerA}/suspend`, { reason: `  ${REASON}  ` })
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('SuspendUser')).toEqual({ userId: ids.trainerA, reason: REASON })
      expect(res.json()).toEqual({
        user: expect.objectContaining({ id: ids.trainerA, role: 'TRAINER', suspended: true, currentTrainer: null }),
      })
      expect(fakeAdminActions[0]).toMatchObject({ action: 'ADMIN_ACTION_SUSPEND_USER', targetUserId: ids.trainerA })
    })

    it('reactivates a suspended user (suspended: false)', async () => {
      fakeSuspended.add(ids.clientA)
      const res = await post(`/api/admin/users/${ids.clientA}/reactivate`, { reason: REASON })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().user).toMatchObject({ id: ids.clientA, suspended: false })
    })

    it('accepts a 500-character reason counted in UTF-16 units, and refuses 501 before upstream', async () => {
      expect((await post(`/api/admin/users/${ids.clientA}/suspend`, { reason: '😀'.repeat(250) })).statusCode).toBe(200)
      resetFakeSuspended()
      grpcCallMock.mockClear()
      const res = await post(`/api/admin/users/${ids.clientA}/suspend`, { reason: `${'😀'.repeat(250)}x` })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.details.fieldErrors.reason).toBeDefined()
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it('writes an audit line with actor and target, never the reason', async () => {
      await post(`/api/admin/users/${ids.clientA}/suspend`, { reason: REASON })
      expect(auditLines()).toEqual([
        expect.objectContaining({ audit: 'admin.user.suspend', actorId: ids.admin, targetUserId: ids.clientA }),
      ])
      expect(logLines.join('\n')).not.toContain(REASON)
    })

    it('ends the session of the suspended user, and refuses their password at login', async () => {
      await post(`/api/admin/users/${ids.clientA}/suspend`, { reason: REASON })
      const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer('clientA') })
      expect(me.statusCode).toBe(401)
      expect(me.json().error.code).toBe('UNAUTHENTICATED')
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: emailOf(ids.clientA), password: FAKE_PASSWORD },
      })
      expect(login.statusCode).toBe(403)
      expect(login.json().error.code).toBe('ACCOUNT_SUSPENDED')
    })
  })

  describe.each([
    ['first-access-email', 'SendFirstAccessEmail', ids.clientA2, 'admin.user.first_access_email'],
    ['password-reset-email', 'SendPasswordResetEmail', ids.trainerA, 'admin.user.password_reset_email'],
  ])('POST /admin/users/:id/%s', (path, rpc, target, audit) => {
    const url = `/api/admin/users/${target}/${path}`

    it('answers 204 with an empty body: no link, no token, no status (R49)', async () => {
      const res = await post(url)
      expect(res.statusCode, res.body).toBe(204)
      expect(res.body).toBe('')
      expect(upstreamRequest(rpc)).toEqual({ userId: target })
      expect(auditLines()).toEqual([expect.objectContaining({ audit, actorId: ids.admin, targetUserId: target })])
    })

    it('answers a send limit with 429 RATE_LIMITED and the API’s Retry-After', async () => {
      fakeEmailSends.mode = 'limited'
      const res = await post(url)
      expect(res.statusCode).toBe(429)
      expect(res.json().error.code).toBe('RATE_LIMITED')
      expect(res.headers['retry-after']).toBe(String(FAKE_EMAIL_RETRY_SECONDS))
      expect(auditLines()).toEqual([])
    })

    it('answers 409 PRECONDITION_FAILED while e-mails are switched off upstream', async () => {
      fakeEmailSends.mode = 'disabled'
      const res = await post(url)
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('PRECONDITION_FAILED')
    })

    it('answers 503 UPSTREAM_UNAVAILABLE when every send failed', async () => {
      fakeEmailSends.mode = 'failed'
      const res = await post(url)
      expect(res.statusCode).toBe(503)
      expect(res.json().error.code).toBe('UPSTREAM_UNAVAILABLE')
    })

    it('defaults Retry-After to 60 when the upstream text has no seconds', async () => {
      grpcCallMock.mockImplementation(async () => {
        throw mapGrpcError({ code: status.RESOURCE_EXHAUSTED, details: 'limit reached' })
      })
      const res = await post(url)
      expect(res.statusCode).toBe(429)
      expect(res.headers['retry-after']).toBe('60')
    })
  })

  describe('DELETE /admin/relationships/:trainerId/:clientId', () => {
    it('ends the relationship with both ids and answers 204', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/admin/relationships/${ids.trainerA}/${ids.clientA}`,
        headers: bearer('admin'),
      })
      expect(res.statusCode, res.body).toBe(204)
      expect(upstreamRequest('EndTrainerClientRelationship')).toEqual({ trainerId: ids.trainerA, clientId: ids.clientA })
      expect(auditLines()).toEqual([
        expect.objectContaining({ audit: 'admin.relationship.end', actorId: ids.admin, trainerId: ids.trainerA, clientId: ids.clientA }),
      ])
    })
  })
})

describe('admin exercise curation routes (VRT-31)', () => {
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
      rateLimits: { globalMax: 1_000_000 },
      loggerInstance: pino({ level: 'trace', serializers: LOG_SERIALIZERS }, sink),
    })
    await app.ready()
  })
  afterAll(() => app.close())
  beforeEach(() => {
    logLines.length = 0
  })

  const send = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: object) =>
    app.inject({ method, url, headers: bearer('admin'), ...(body ? { payload: body } : {}) })
  const auditLines = () => logLines.map((l) => JSON.parse(l)).filter((l) => l.audit)

  describe('GET /admin/exercises', () => {
    it('sends the prefixed scope, the filters and the paging, and tags private rows with their owner', async () => {
      const res = await send('GET', `/api/admin/exercises?scope=PRIVATE&ownerId=${ids.trainerA}&q=%20exer%20&limit=10&cursor=`)
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('ListCatalogExercises')).toEqual({
        scope: 'CATALOG_SCOPE_PRIVATE',
        muscleGroupId: 0,
        ownerId: ids.trainerA,
        search: 'exer',
        pageSize: 10,
        pageToken: '',
      })
      const body = res.json()
      expect(body.nextCursor).toBeNull()
      expect(body.exercises.map((e: { id: number }) => e.id)).toEqual([ids.privateExerciseA, ids.inUseExerciseA])
      expect(body.exercises[0]).toEqual({
        id: ids.privateExerciseA,
        name: `Exercise ${ids.privateExerciseA}`,
        description: '',
        videoUrl: '',
        muscleGroups: [{ id: 1, name: 'Peito' }],
        isStarter: false,
        owner: { id: ids.trainerA, name: expect.any(String) },
      })
    })

    it('defaults to both scopes and 25 per page; starter rows have no owner', async () => {
      const res = await send('GET', '/api/admin/exercises')
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('ListCatalogExercises')).toMatchObject({ scope: 'CATALOG_SCOPE_UNSPECIFIED', pageSize: 25, search: '' })
      const starters = res.json().exercises.filter((e: { isStarter: boolean }) => e.isStarter)
      expect(starters.length).toBeGreaterThan(0)
      for (const e of starters) expect(e.owner).toBeNull()
    })

    it('relays the next page token as nextCursor', async () => {
      grpcCallMock.mockResolvedValueOnce({ exercises: [], nextPageToken: 'offset-10' } as never)
      const res = await send('GET', '/api/admin/exercises?limit=10')
      expect(res.json()).toEqual({ exercises: [], nextCursor: 'offset-10' })
    })

    it('refuses a TRAINER by role before any upstream call', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/exercises', headers: bearer('trainerA') })
      expect(res.statusCode).toBe(403)
      expect(grpcCallMock).not.toHaveBeenCalled()
    })
  })

  describe('GET /admin/exercises/most-used', () => {
    it('answers the rows in upstream order with numeric workout counts', async () => {
      const res = await send('GET', '/api/admin/exercises/most-used?limit=10')
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('ListMostUsedExercises')).toEqual({ muscleGroupId: 0, pageSize: 10, pageToken: '' })
      const body = res.json()
      expect(body.exercises.map((e: { exercise: { id: number }; workoutCount: number }) => [e.exercise.id, e.workoutCount])).toEqual([
        [ids.exercise, 3],
        [ids.inUseStarterExercise, 2],
        [ids.inUseExerciseA, 1],
      ])
      expect(body.exercises[2].exercise.owner).toEqual({ id: ids.trainerA, name: expect.any(String) })
      expect(body.nextCursor).toBeNull()
    })
  })

  describe('writes', () => {
    it('creates a starter exercise (201) with the trainer body rules, and audits its id', async () => {
      const res = await send('POST', '/api/admin/exercises', {
        name: '  Supino  ',
        muscleGroupIds: [1, 1],
        videoUrl: 'https://youtu.be/dQw4w9WgXcQ',
      })
      expect(res.statusCode, res.body).toBe(201)
      expect(upstreamRequest('CreateStarterExercise')).toEqual({
        exercise: { name: 'Supino', description: '', videoUrl: 'https://youtu.be/dQw4w9WgXcQ', muscleGroupIds: [1] },
      })
      expect(res.json()).toMatchObject({ id: 900, name: 'Supino', isStarter: true, owner: null })
      expect(auditLines()).toEqual([expect.objectContaining({ audit: 'admin.catalog.create', actorId: ids.admin, exerciseId: 900 })])
      expect(logLines.join('\n')).not.toContain('Supino')
    })

    it('replaces a starter exercise with PUT and audits it', async () => {
      const res = await send('PUT', `/api/admin/exercises/${ids.exercise}`, { name: 'Agachamento', muscleGroupIds: [1] })
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('UpdateStarterExercise')).toEqual({
        id: ids.exercise,
        exercise: { name: 'Agachamento', description: '', videoUrl: '', muscleGroupIds: [1] },
      })
      expect(auditLines()).toEqual([expect.objectContaining({ audit: 'admin.catalog.update', exerciseId: ids.exercise })])
    })

    it('deletes with 204 and audits it', async () => {
      const res = await send('DELETE', `/api/admin/exercises/${ids.exercise}`)
      expect(res.statusCode, res.body).toBe(204)
      expect(auditLines()).toEqual([expect.objectContaining({ audit: 'admin.catalog.delete', exerciseId: ids.exercise })])
    })

    it.each([
      ['the in-use check', `Exercise ${ids.exercise} is used by a workout and cannot be deleted`],
      ['the foreign-key race', 'The change conflicts with related data: the record is still in use, or refers to one that does not exist'],
    ])('answers 409 EXERCISE_IN_USE for %s, and writes no audit line', async (_, details) => {
      grpcCallMock.mockRejectedValueOnce(mapGrpcError({ code: status.FAILED_PRECONDITION, details }))
      const res = await send('DELETE', `/api/admin/exercises/${ids.exercise}`)
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toEqual({ code: 'EXERCISE_IN_USE', message: 'The exercise is used by a workout and cannot be deleted' })
      expect(auditLines()).toEqual([])
    })

    it('promotes a private exercise with the edited copy (201), auditing source and new ids', async () => {
      const res = await send('POST', `/api/admin/exercises/${ids.privateExerciseB}/promote`, {
        name: 'Remada curvada',
        description: 'Costas retas',
        muscleGroupIds: [1],
      })
      expect(res.statusCode, res.body).toBe(201)
      expect(upstreamRequest('PromoteExercise')).toEqual({
        sourceExerciseId: ids.privateExerciseB,
        exercise: { name: 'Remada curvada', description: 'Costas retas', videoUrl: '', muscleGroupIds: [1] },
      })
      expect(res.json()).toMatchObject({ id: 900, isStarter: true, owner: null })
      expect(auditLines()).toEqual([
        expect.objectContaining({ audit: 'admin.catalog.promote', sourceExerciseId: ids.privateExerciseB, exerciseId: 900 }),
      ])
    })

    it('answers a taken name with 409 NAME_TAKEN, never the global "Email or CPF" conflict', async () => {
      for (const [method, url, body] of [
        ['POST', '/api/admin/exercises', { name: 'exercise 1', muscleGroupIds: [1] }],
        ['POST', '/api/admin/muscle-groups', { name: 'péito' }],
        ['PATCH', `/api/admin/muscle-groups/${ids.muscleGroup}`, { name: 'Peito' }],
      ] as const) {
        grpcCallMock.mockRejectedValueOnce(mapGrpcError({ code: status.ALREADY_EXISTS, details: 'Muscle group name already in use' }))
        const res = await send(method, url, body)
        expect(res.statusCode, url).toBe(409)
        expect(res.json().error).toEqual({ code: 'NAME_TAKEN', message: 'Name already in use' })
      }
    })

    it('normalizes a muscle-group name to NFC and trims it before the 1-50 bound, as vertice-api does', async () => {
      // 49 letters + "e" and a combining acute: 51 UTF-16 units decomposed, 50 once composed.
      const decomposed = `  ${'a'.repeat(49)}e\u0301  `
      const res = await send('POST', '/api/admin/muscle-groups', { name: decomposed })
      expect(res.statusCode, res.body).toBe(201)
      expect(upstreamRequest('CreateMuscleGroup')).toEqual({ name: `${'a'.repeat(49)}\u00e9` })
      expect(res.json()).toEqual({ id: 9, name: `${'a'.repeat(49)}\u00e9` })
      expect(auditLines()).toEqual([expect.objectContaining({ audit: 'admin.catalog.muscle_group_create', muscleGroupId: 9 })])
    })

    it('renames a muscle group and audits it', async () => {
      const res = await send('PATCH', `/api/admin/muscle-groups/${ids.muscleGroup}`, { name: 'Peitoral' })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({ id: ids.muscleGroup, name: 'Peitoral' })
      expect(upstreamRequest('RenameMuscleGroup')).toEqual({ id: ids.muscleGroup, name: 'Peitoral' })
      expect(auditLines()).toEqual([expect.objectContaining({ audit: 'admin.catalog.muscle_group_rename', muscleGroupId: ids.muscleGroup })])
    })

    it('relays INVALID_ARGUMENT text from upstream as a 400 (e.g. an unknown muscle group)', async () => {
      const res = await send('POST', '/api/admin/exercises', { name: 'Remada', muscleGroupIds: [77] })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'muscleGroupIds: unknown muscle group' })
    })

    it('answers 502 when upstream sends no exercise', async () => {
      grpcCallMock.mockResolvedValueOnce({ exercise: null } as never)
      const res = await send('POST', '/api/admin/exercises', { name: 'Remada', muscleGroupIds: [1] })
      expect(res.statusCode).toBe(502)
      expect(res.json().error.code).toBe('UPSTREAM_ERROR')
    })
  })

  it('drops an owner on a starter row, whatever upstream sends', () => {
    const exercise = { id: '1', name: 'n', description: '', videoUrl: '', muscleGroups: [], isStarter: true }
    expect(toCatalogExercise({ exercise, owner: { id: '10', name: 'T', role: 'TRAINER' } }, 'rpc').owner).toBeNull()
    expect(toCatalogExercise({ exercise: { ...exercise, isStarter: false }, owner: { id: '10', name: 'T', role: 'TRAINER' } }, 'rpc').owner).toEqual({
      id: 10,
      name: 'T',
    })
  })
})

describe('request log serializer', () => {
  it('is the one the production logger uses', async () => {
    const app = await buildApp()
    try {
      const serializers = (app.log as unknown as Record<symbol, Record<string, unknown>>)[pino.symbols.serializersSym]
      expect(serializers!.req).toBe(requestSerializer)
    } finally {
      await app.close()
    }
  })
})

describe('admin feature-flag routes (VRT-53)', () => {
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
      rateLimits: { globalMax: 1_000_000 },
      loggerInstance: pino({ level: 'trace', serializers: LOG_SERIALIZERS }, sink),
    })
    await app.ready()
  })
  afterAll(() => app.close())
  beforeEach(() => {
    logLines.length = 0
    resetFakeFlags()
  })

  const send = (method: 'GET' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    app.inject({ method, url, headers: bearer('admin'), ...(body !== undefined ? { payload: body as object } : {}) })
  const lines = () => logLines.map((l) => JSON.parse(l))
  const auditLines = () => lines().filter((l) => l.audit)
  const flagRpcs = () => grpcCallMock.mock.calls.map(([, method]) => method)
  const AI = 'AI_ASSISTANT_ENABLED'

  describe('GET /admin/feature-flags', () => {
    it('maps every field, flags by key and users in upstream order', async () => {
      fakeFlags.get(AI)!.users.set(ids.trainerB, false).set(ids.trainerA, true)
      const res = await send('GET', '/api/admin/feature-flags')
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({
        flags: [
          {
            key: AI,
            description: 'Assistente de IA no editor de treino.',
            enabled: true,
            users: [
              { userId: ids.trainerA, enabled: true },
              { userId: ids.trainerB, enabled: false },
            ],
          },
          { key: 'FIRST_ACCESS_EMAIL_ENABLED', description: 'E-mail de primeiro acesso.', enabled: false, users: [] },
        ],
      })
      expect(flagRpcs()).toEqual(['ListFeatureFlags'])
    })

    it('keeps the users in the order upstream sent them', async () => {
      grpcCallMock.mockResolvedValueOnce({
        flags: [{ key: AI, description: 'd', enabled: false, users: [{ userId: '30', enabled: true }, { userId: '5', enabled: false }] }],
      } as never)
      const res = await send('GET', '/api/admin/feature-flags')
      expect(res.json().flags[0].users).toEqual([
        { userId: 30, enabled: true },
        { userId: 5, enabled: false },
      ])
    })

    it('drops a user id past 2^53 from upstream, with one unsafe_user_id WARN (FF9)', async () => {
      grpcCallMock.mockResolvedValueOnce({
        flags: [
          {
            key: AI,
            description: 'd',
            enabled: true,
            users: [
              { userId: '9007199254740993', enabled: true },
              { userId: '7', enabled: false },
            ],
          },
        ],
      } as never)
      const res = await send('GET', '/api/admin/feature-flags')
      expect(res.statusCode).toBe(200)
      expect(res.json().flags[0].users).toEqual([{ userId: 7, enabled: false }])
      const warns = lines().filter((l) => l.outcome === 'unsafe_user_id')
      expect(warns).toHaveLength(1)
      expect(warns[0]).toMatchObject({ level: 40, flag: AI })
      expect(JSON.stringify(warns[0])).not.toContain('9007199254740993')
    })
  })

  describe('writes', () => {
    it('PUT everyone sends the absolute state and returns the flag', async () => {
      const res = await send('PUT', `/api/admin/feature-flags/${AI}/everyone`, { enabled: false })
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('SetFeatureFlagEveryone')).toEqual({ key: AI, enabled: false })
      expect(res.json()).toMatchObject({ key: AI, enabled: false, users: [] })
      expect(auditLines()).toEqual([
        expect.objectContaining({ level: 30, audit: 'admin.flag.everyone', actorId: ids.admin, flag: AI, enabled: false }),
      ])
    })

    it('PUT a user sends the number and the absolute state and returns the flag', async () => {
      const res = await send('PUT', `/api/admin/feature-flags/${AI}/users/${ids.trainerA}`, { enabled: false })
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('SetFeatureFlagUser')).toEqual({ key: AI, userId: ids.trainerA, enabled: false })
      expect(res.json()).toEqual({
        key: AI,
        description: expect.any(String),
        enabled: true,
        users: [{ userId: ids.trainerA, enabled: false }],
      })
      expect(auditLines()).toEqual([
        expect.objectContaining({
          audit: 'admin.flag.user_set',
          actorId: ids.admin,
          flag: AI,
          userId: ids.trainerA,
          enabled: false,
        }),
      ])
    })

    it('DELETE a user removes the setting and returns the flag; with no setting it is 200, unchanged', async () => {
      fakeFlags.get(AI)!.users.set(ids.trainerA, false)
      const res = await send('DELETE', `/api/admin/feature-flags/${AI}/users/${ids.trainerA}`)
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('RemoveFeatureFlagUser')).toEqual({ key: AI, userId: ids.trainerA })
      expect(res.json()).toMatchObject({ key: AI, enabled: true, users: [] })

      const again = await send('DELETE', `/api/admin/feature-flags/${AI}/users/${ids.trainerA}`)
      expect(again.statusCode, again.body).toBe(200)
      expect(again.json()).toMatchObject({ key: AI, enabled: true, users: [] })
      const audits = auditLines()
      expect(audits).toHaveLength(2)
      expect(audits[0]).toMatchObject({ audit: 'admin.flag.user_removed', actorId: ids.admin, flag: AI, userId: ids.trainerA })
      expect(audits[0]).not.toHaveProperty('enabled')
    })

    it('accepts the largest safe user number', async () => {
      const res = await send('PUT', `/api/admin/feature-flags/${AI}/users/9007199254740991`, { enabled: true })
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamRequest('SetFeatureFlagUser')).toEqual({ key: AI, userId: 9007199254740991, enabled: true })
    })

    it.each([
      ['a string', { enabled: 'true' }],
      ['a missing enabled', {}],
      ['an extra reason', { enabled: true, reason: 'because' }],
    ])('refuses %s with 400 and no upstream call', async (_, body) => {
      for (const url of [`/api/admin/feature-flags/${AI}/everyone`, `/api/admin/feature-flags/${AI}/users/${ids.trainerA}`]) {
        const res = await send('PUT', url, body)
        expect(res.statusCode, url).toBe(400)
        expect(res.json().error.code).toBe('VALIDATION_ERROR')
      }
      expect(grpcCallMock).not.toHaveBeenCalled()
      expect(auditLines()).toEqual([])
    })

    it.each(['ai_assistant', '1FLAG', 'A'.repeat(65), '%20'])('refuses the key %s with 400 and no upstream call', async (key) => {
      for (const [method, url, body] of [
        ['PUT', `/api/admin/feature-flags/${key}/everyone`, { enabled: true }],
        ['PUT', `/api/admin/feature-flags/${key}/users/${ids.trainerA}`, { enabled: true }],
        ['DELETE', `/api/admin/feature-flags/${key}/users/${ids.trainerA}`, undefined],
      ] as const) {
        const res = await send(method, url, body)
        expect(res.statusCode, `${method} ${url}`).toBe(400)
        expect(res.json().error.code).toBe('VALIDATION_ERROR')
      }
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it.each(['0', '-1', '01', '1e3', 'abc', '9007199254740992'])('refuses the user number %s with 400 and no upstream call', async (userId) => {
      for (const [method, body] of [
        ['PUT', { enabled: true }],
        ['DELETE', undefined],
      ] as const) {
        const res = await send(method, `/api/admin/feature-flags/${AI}/users/${userId}`, body)
        expect(res.statusCode, method).toBe(400)
        expect(res.json().error.code).toBe('VALIDATION_ERROR')
      }
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it('answers 404 NOT_FOUND for an unknown key, and logs no audit line', async () => {
      for (const [method, url, body] of [
        ['PUT', '/api/admin/feature-flags/NO_SUCH_FLAG/everyone', { enabled: true }],
        ['PUT', `/api/admin/feature-flags/NO_SUCH_FLAG/users/${ids.trainerA}`, { enabled: true }],
        ['DELETE', `/api/admin/feature-flags/NO_SUCH_FLAG/users/${ids.trainerA}`, undefined],
      ] as const) {
        const res = await send(method, url, body)
        expect(res.statusCode, `${method} ${url}`).toBe(404)
        expect(res.json().error.code).toBe('NOT_FOUND')
      }
      expect(auditLines()).toEqual([])
    })

    it('answers 502 when upstream sends no flag', async () => {
      grpcCallMock.mockResolvedValueOnce({ flag: null } as never)
      const res = await send('PUT', `/api/admin/feature-flags/${AI}/everyone`, { enabled: true })
      expect(res.statusCode).toBe(502)
      expect(res.json().error.code).toBe('UPSTREAM_ERROR')
    })
  })
})
