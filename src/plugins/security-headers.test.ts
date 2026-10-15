import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { env } from '../config/env.js'
import { grpcCall } from '../grpc/call.js'
import { bearer, fakeGrpcCall, ids } from '../test/fakeUpstream.js'

// Keep the real mapGrpcError: the fake upstream raises its errors through it.
vi.mock('../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

describe('security headers', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    // A cacheable route that can also fail: its errors must still be no-store.
    app.get<{ Querystring: { status?: string } }>(
      '/api/test-cacheable',
      { config: { cacheControl: 'public, max-age=60' } },
      async (request, reply) => reply.code(Number(request.query.status ?? 200)).send({ ok: true }),
    )
    await app.ready()
  })
  afterAll(() => app.close())

  beforeEach(() => {
    grpcCallMock.mockReset()
    grpcCallMock.mockImplementation(fakeGrpcCall)
  })

  const apiHeaders = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none';frame-ancestors 'none'",
    'strict-transport-security': expect.stringMatching(/^max-age=\d+/),
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  }

  it.each([
    ['a personal-data read', 'GET', `/api/clients/${ids.clientA}`, bearer('trainerA'), 200],
    ['GET /auth/me', 'GET', '/api/auth/me', bearer('clientA'), 200],
    ['a 401', 'GET', '/api/auth/me', {}, 401],
    ['a 403', 'GET', `/api/clients/${ids.clientB}`, bearer('trainerA'), 403],
    ['an unknown /api route', 'GET', '/api/nope', {}, 404],
    ['a 400 from login', 'POST', '/api/auth/login', {}, 400],
  ] as const)('sets the API headers and Cache-Control: no-store on %s', async (_what, method, url, headers, status) => {
    const res = await app.inject({ method, url, headers })
    expect(res.statusCode, res.body).toBe(status)
    expect(res.headers).toMatchObject(apiHeaders)
  })

  it("uses a route's own Cache-Control on its successful responses", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test-cacheable' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=60')
  })

  it.each([400, 404, 500, 503])('keeps a cacheable route at no-store on a %i', async (status) => {
    const res = await app.inject({ method: 'GET', url: `/api/test-cacheable?status=${status}` })
    expect(res.statusCode).toBe(status)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('sets the security headers outside /api too, but leaves caching alone there', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' })
    expect(res.headers['cache-control']).toBeUndefined()
  })

  it('keeps CORS working for an allowed browser origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/auth/me',
      headers: { origin: env.CORS_ORIGIN[0]!, 'access-control-request-method': 'GET' },
    })
    expect(res.statusCode).toBeLessThan(300)
    expect(res.headers['access-control-allow-origin']).toBe(env.CORS_ORIGIN[0]!)
    expect(res.headers['cache-control']).toBe('no-store')
  })
})
