import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { status } from '@grpc/grpc-js'
import { buildApp } from '../../app.js'
import { grpcCall, mapGrpcError } from '../../grpc/call.js'
import { bearer, fakeGrpcCall, ids, setupTokenFor } from '../../test/fakeUpstream.js'

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
