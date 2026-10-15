import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { status } from '@grpc/grpc-js'
import { buildApp } from '../../app.js'
import { grpcCall, mapGrpcError } from '../../grpc/call.js'
import pino from 'pino'
import { Writable } from 'node:stream'
import { bearer, cpfOf, emailOf, fakeGrpcCall, ids, setupTokenFor } from '../../test/fakeUpstream.js'

// Keep the real mapGrpcError: the fake upstream raises its errors through it.
vi.mock('../../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)
const upstreamRequest = (rpc: string) => grpcCallMock.mock.calls.find(([, method]) => method === rpc)?.[2]
const upstreamMethods = () => grpcCallMock.mock.calls.map(([, method]) => method)

describe('client password setup', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(() => app.close())

  beforeEach(() => {
    grpcCallMock.mockReset()
    grpcCallMock.mockImplementation(fakeGrpcCall)
  })

  const create = (body: object) =>
    app.inject({ method: 'POST', url: '/api/clients', payload: body, headers: bearer('trainerA') })

  describe('POST /clients', () => {
    it('creates the client without a password and returns a setup token', async () => {
      const res = await create({ name: 'Novo', email: 'Novo@Vertice.test ' })
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toMatchObject({
        id: 99,
        role: 'CLIENT',
        setup: { token: setupTokenFor(99), expiresAt: '2099-01-01T00:00:00Z' },
      })
      expect(upstreamRequest('CreateClientForTrainer')).toEqual({
        trainerId: ids.trainerA,
        name: 'Novo',
        email: 'novo@vertice.test',
        password: '',
        cpf: '',
      })
      expect(upstreamRequest('CreatePasswordSetupToken')).toEqual({ userId: 99 })
    })

    it('never forwards a password from the body', async () => {
      const res = await create({ name: 'Novo', email: 'novo@vertice.test', password: 'chosen-by-trainer' })
      expect(res.statusCode, res.body).toBe(201)
      expect(upstreamRequest('CreateClientForTrainer')).toMatchObject({ password: '' })
    })

    it('still answers 201, with setup null, when the token cannot be issued after the create', async () => {
      grpcCallMock.mockImplementation(async (client, method, request) => {
        if (method === 'CreatePasswordSetupToken') throw mapGrpcError({ code: status.UNAVAILABLE, details: '' })
        return fakeGrpcCall(client, method, request)
      })
      const res = await create({ name: 'Novo', email: 'novo@vertice.test' })
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toMatchObject({ id: 99, setup: null })
    })
  })

  describe('without a CPF (optional for a CLIENT since vertice-api #65)', () => {
    it("creates the client with an empty CPF, which vertice-api stores as NULL, and answers cpf ''", async () => {
      const res = await create({ name: 'Novo', email: 'novo@vertice.test' })
      expect(res.statusCode, res.body).toBe(201)
      expect(upstreamRequest('CreateClientForTrainer')).toMatchObject({ cpf: '' })
    })

    it('rejects a masked CPF with a 400 and creates nothing', async () => {
      const res = await create({ name: 'Novo', email: 'novo@vertice.test', cpf: '***.***.***-25' })
      expect(res.statusCode).toBe(400)
      expect(res.json().error.code).toBe('VALIDATION_ERROR')
      expect(upstreamMethods().filter((m) => m.startsWith('Create'))).toEqual([])
    })
  })

  describe('PATCH /clients/:id CPF', () => {
    const patch = (payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/clients/${ids.clientA}`, headers: bearer('trainerA'), payload })
    const base = { name: 'Client A', email: emailOf(ids.clientA) }

    it('keeps the stored CPF when the body omits it: reads it and sends it back (UpdateUser replaces every field)', async () => {
      const res = await patch(base)
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamMethods()).toEqual(['IsTrainersClient', 'GetUser', 'UpdateUser'])
      expect(upstreamRequest('UpdateUser')).toEqual({
        id: ids.clientA,
        user: { ...base, cpf: cpfOf(ids.clientA), cref: '', role: 'CLIENT' },
      })
    })

    it('sends a new CPF as given, without reading the stored one', async () => {
      const res = await patch({ ...base, cpf: '11144477735' })
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamMethods()).toEqual(['IsTrainersClient', 'UpdateUser'])
      expect(upstreamRequest('UpdateUser')).toMatchObject({ user: { cpf: '11144477735' } })
    })

    it("removes the CPF only on an explicit null (sent as '', stored as NULL)", async () => {
      grpcCallMock.mockImplementation(async (client, method, request, options) => {
        const res = await fakeGrpcCall(client, method, request, options)
        return (method === 'UpdateUser' ? { ...(res as object), cpf: '' } : res) as never
      })
      const res = await patch({ ...base, cpf: null })
      expect(res.statusCode, res.body).toBe(200)
      expect(upstreamMethods()).toEqual(['IsTrainersClient', 'UpdateUser'])
      expect(upstreamRequest('UpdateUser')).toMatchObject({ user: { cpf: '' } })
      expect(res.json().cpf).toBe('')
    })

    it.each(['***.***.***-25', '***.***.***-**', '529*****725'])(
      'rejects the masked CPF %s with a 400 and never sends it',
      async (cpf) => {
        const res = await patch({ ...base, cpf })
        expect(res.statusCode).toBe(400)
        expect(res.json().error.code).toBe('VALIDATION_ERROR')
        expect(upstreamMethods()).not.toContain('UpdateUser')
      },
    )
  })

  describe('POST /clients/:id/setup-token', () => {
    const reissue = (clientId: number) =>
      app.inject({ method: 'POST', url: `/api/clients/${clientId}/setup-token`, headers: bearer('trainerA') })

    it('re-issues the link of a client who has not set a password yet', async () => {
      const res = await reissue(ids.clientA2)
      expect(res.statusCode, res.body).toBe(201)
      expect(res.json()).toEqual({ token: setupTokenFor(ids.clientA2), expiresAt: '2099-01-01T00:00:00Z' })
    })

    it('refuses once the client has chosen a password (it would let the trainer take over the account)', async () => {
      const res = await reissue(ids.clientA)
      expect(res.statusCode).toBe(409)
      expect(res.json().error.code).toBe('PRECONDITION_FAILED')
      expect(upstreamMethods()).not.toContain('CreatePasswordSetupToken')
    })
  })
})

describe('client personal data (P1-03)', () => {
  let app: FastifyInstance
  const logLines: Record<string, unknown>[] = []

  beforeAll(async () => {
    const sink = new Writable({
      write(chunk, _encoding, done) {
        logLines.push(JSON.parse(String(chunk)))
        done()
      },
    })
    app = await buildApp({ loggerInstance: pino({ level: 'info' }, sink) })
    await app.ready()
  })
  afterAll(() => app.close())

  beforeEach(() => {
    grpcCallMock.mockReset()
    grpcCallMock.mockImplementation(fakeGrpcCall)
    logLines.length = 0
  })

  const get = (url: string) => app.inject({ method: 'GET', url, headers: bearer('trainerA') })
  const auditLines = () => logLines.filter((line) => line.audit === 'client.cpf.reveal')
  const maskedCpfOf = (id: number) => `***.***.***-${cpfOf(id).slice(-2)}`

  describe('GET /clients', () => {
    it('returns a ClientSummary per client: no email, no cpf, no cref, nothing spread from upstream', async () => {
      const res = await get('/api/clients')
      expect(res.statusCode, res.body).toBe(200)
      const roster = res.json()
      expect(roster.map((c: { id: number }) => c.id)).toEqual([ids.clientA, ids.clientA2])
      expect(roster[0]).toMatchInlineSnapshot({ weekActivity: expect.any(Array) }, `
        {
          "activePlanCount": 1,
          "currentPlan": {
            "endDate": "2099-12-31",
            "id": 100,
            "name": "Plan 100",
          },
          "id": 20,
          "lastWorkoutAt": null,
          "name": "Client A",
          "weekActivity": Any<Array>,
        }
      `)
      for (const entry of roster) {
        expect(Object.keys(entry).sort()).toEqual(
          ['activePlanCount', 'currentPlan', 'id', 'lastWorkoutAt', 'name', 'weekActivity'].sort(),
        )
      }
      // The fake upstream still answers with the contact view (email set), so this proves the BFF
      // drops the email itself rather than relying on vertice-api's summary view.
      expect(res.body).not.toMatch(/email|cpf|cref|@vertice\.test|52998224/i)
    })

    it('drops an email and a CPF even if upstream sends them (an older vertice-api, or a view change)', async () => {
      grpcCallMock.mockImplementation(async (client, method, request, options) => {
        const res = (await fakeGrpcCall(client, method, request, options)) as { clients?: object[] }
        if (method !== 'ListClientsForTrainer') return res as never
        return {
          clients: res.clients!.map((c) => ({ ...c, email: 'leak@example.com', cpf: '52998224725', cref: 'CREF-1' })),
        } as never
      })
      const res = await get('/api/clients')
      expect(res.statusCode, res.body).toBe(200)
      expect(res.body).not.toMatch(/email|leak@example\.com|cpf|cref|52998224725/i)
    })
  })

  describe('GET /clients/:id', () => {
    it('returns the CPF masked by default, and logs no reveal', async () => {
      const res = await get(`/api/clients/${ids.clientA}`)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toEqual({
        id: ids.clientA,
        name: 'Client A',
        email: emailOf(ids.clientA),
        cpf: maskedCpfOf(ids.clientA),
        role: 'CLIENT',
      })
      expect(maskedCpfOf(ids.clientA)).toBe('***.***.***-20')
      expect(auditLines()).toEqual([])
    })

    it('returns the CPF in full with ?reveal=cpf, and logs who revealed whose CPF, without the value', async () => {
      const res = await get(`/api/clients/${ids.clientA}?reveal=cpf`)
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json().cpf).toBe(cpfOf(ids.clientA))
      expect(auditLines()).toEqual([
        expect.objectContaining({ actorId: ids.trainerA, clientId: ids.clientA, msg: 'Client CPF revealed' }),
      ])
      expect(JSON.stringify(logLines)).not.toContain(cpfOf(ids.clientA))
    })

    it.each(['reveal=email', 'reveal=', 'reveal=CPF', 'reveal=cpf&reveal=cpf', 'show=cpf'])(
      'refuses an unknown query (%s) with a 400, revealing nothing',
      async (query) => {
        const res = await get(`/api/clients/${ids.clientA}?${query}`)
        expect(res.statusCode, res.body).toBe(400)
        expect(res.json().error.code).toBe('VALIDATION_ERROR')
        expect(grpcCallMock).not.toHaveBeenCalled()
        expect(auditLines()).toEqual([])
      },
    )

    it("refuses a reveal for another trainer's client before reading it, and logs no reveal", async () => {
      const res = await get(`/api/clients/${ids.clientB}?reveal=cpf`)
      expect(res.statusCode).toBe(403)
      expect(grpcCallMock.mock.calls.map(([, m]) => m)).toEqual(['IsTrainersClient'])
      expect(auditLines()).toEqual([])
    })
  })

  it('masks the CPF in the overview, the update response and the create response', async () => {
    const overview = await get(`/api/clients/${ids.clientA}/overview`)
    expect(overview.statusCode, overview.body).toBe(200)
    expect(overview.json().student).toEqual({
      id: ids.clientA,
      name: 'Client A',
      email: emailOf(ids.clientA),
      cpf: maskedCpfOf(ids.clientA),
      role: 'CLIENT',
    })

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${ids.clientA}`,
      headers: bearer('trainerA'),
      payload: { name: 'Client A', email: emailOf(ids.clientA), cpf: cpfOf(ids.clientA) },
    })
    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.json().cpf).toBe(maskedCpfOf(ids.clientA))

    const created = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: bearer('trainerA'),
      payload: { name: 'Novo', email: 'novo@vertice.test', cpf: '52998224725' },
    })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json()).toMatchObject({ cpf: '***.***.***-25', setup: { token: setupTokenFor(99) } })
    expect(created.json()).not.toHaveProperty('cref')
  })

  it('answers a duplicate email or CPF on POST /clients with one fixed message', async () => {
    grpcCallMock.mockImplementation(async (client, method, request, options) => {
      if (method === 'CreateClientForTrainer') {
        throw mapGrpcError({ code: status.ALREADY_EXISTS, details: 'CPF already in use: 529.982.247-25' })
      }
      return fakeGrpcCall(client, method, request, options)
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: bearer('trainerA'),
      payload: { name: 'Novo', email: 'novo@vertice.test', cpf: '52998224725' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: { code: 'CONFLICT', message: 'Email or CPF already in use' } })
  })
})
