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
  fakeGrpcCall,
  ids,
  resetFakeAdminActions,
  resetUpstreamCallers,
  type Actor,
} from '../../test/fakeUpstream.js'
import { toActionEntry, toDirectoryUser, toUserProfile } from './service.js'

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
    app = await buildApp({ rateLimits: { globalMax: 1_000_000 }, loggerInstance: pino({ level: 'trace' }, sink) })
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

  it('refuses a profile with neither arm set', () => {
    expect(() => toUserProfile({})).toThrow()
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
