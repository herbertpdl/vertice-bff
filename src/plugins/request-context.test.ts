import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import requestContextPlugin from './request-context.js'
import authenticatePlugin from './authenticate.js'
import { requestContext } from '../lib/request-context.js'
import { signToken } from '../lib/jwt.js'

// Proves the wiring grpcCall relies on: the store opened in `onRequest` is the
// one `app.authenticate` fills and the one the handler (and every service it
// awaits) reads — including after body parsing on a POST.
describe('request context plugin', () => {
  let app: FastifyInstance
  const token = signToken({ id: 1, name: 'T', email: 't@vertice.test', role: 'TRAINER' })
  const seen = async () => {
    await Promise.resolve()
    return { bearerToken: requestContext.getStore()?.bearerToken ?? null }
  }

  beforeAll(async () => {
    app = Fastify()
    await app.register(requestContextPlugin)
    await app.register(authenticatePlugin)
    app.get('/anonymous', seen)
    app.get('/authed', { preHandler: app.authenticate }, seen)
    app.post('/authed', { preHandler: app.authenticate }, seen)
    await app.ready()
  })

  afterAll(() => app.close())

  it('exposes the verified bearer token to the handler', async () => {
    const res = await app.inject({ method: 'GET', url: '/authed', headers: { authorization: `Bearer ${token}` } })
    expect(res.json()).toEqual({ bearerToken: token })
  })

  it('exposes the verified bearer token to the handler of a request with a body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/authed',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'x' },
    })
    expect(res.json()).toEqual({ bearerToken: token })
  })

  it('does not relay an unverified Authorization header on a route without app.authenticate', async () => {
    const res = await app.inject({ method: 'GET', url: '/anonymous', headers: { authorization: 'Bearer not.a.jwt' } })
    expect(res.json()).toEqual({ bearerToken: null })
  })
})
