import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../app.js'
import { signToken, type Role } from '../../lib/jwt.js'

// Every case here stops before any gRPC call (role gate, missing token, Zod), so no
// upstream is needed. Anything that reaches vertice-api is verified end to end in
// docs/specs/exercise-starter-catalog/verification.md.
describe('exercise routes', () => {
  let app: FastifyInstance
  const bearer = (role: Role) => ({
    authorization: `Bearer ${signToken({ id: 1, name: 'U', email: 'u@vertice.test', role })}`,
  })

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(() => app.close())

  it('GET /api/exercises with a CLIENT token is refused with 403 FORBIDDEN before any upstream call', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/exercises', headers: bearer('CLIENT') })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Requires role: TRAINER or ADMIN' })
  })

  it('GET /api/exercises without a token is 401 UNAUTHORIZED', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/exercises' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('UNAUTHORIZED')
  })

  it('GET /api/exercises?muscleGroupId=abc with a TRAINER token is 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/exercises?muscleGroupId=abc', headers: bearer('TRAINER') })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    expect(res.json().error.details.fieldErrors.muscleGroupId).toBeDefined()
  })

  it('GET /api/muscle-groups without a token is 401 UNAUTHORIZED', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/muscle-groups' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toMatchObject({ code: 'UNAUTHORIZED', message: 'Missing bearer token' })
  })

  it('POST /api/exercises with an ADMIN token is 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/exercises',
      headers: bearer('ADMIN'),
      payload: { name: 'x', muscleGroupIds: [1] },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Requires role: TRAINER' })
  })

  it('POST /api/exercises with a CLIENT token is 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/exercises',
      headers: bearer('CLIENT'),
      payload: { name: 'x', muscleGroupIds: [1] },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Requires role: TRAINER' })
  })

  it('PATCH and DELETE /api/exercises/:id with a CLIENT token are 403 FORBIDDEN', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/exercises/1',
      headers: bearer('CLIENT'),
      payload: { name: 'x', muscleGroupIds: [1] },
    })
    expect(patch.statusCode).toBe(403)
    expect(patch.json().error.code).toBe('FORBIDDEN')

    const del = await app.inject({ method: 'DELETE', url: '/api/exercises/1', headers: bearer('CLIENT') })
    expect(del.statusCode).toBe(403)
    expect(del.json().error.code).toBe('FORBIDDEN')
  })

  it('POST /api/exercises with a TRAINER token and muscleGroupIds: [] is 400 VALIDATION_ERROR with a details.fieldErrors.muscleGroupIds entry', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/exercises',
      headers: bearer('TRAINER'),
      payload: { name: 'Sem grupo', muscleGroupIds: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    expect(res.json().error.details.fieldErrors.muscleGroupIds).toBeDefined()
  })

  it('GET /api/exercises/:id has no role gate', async () => {
    // With no upstream running this ends as 503 UPSTREAM_UNAVAILABLE (or whatever a running
    // vertice-api decides) — the point is that the BFF itself does not refuse a CLIENT.
    const res = await app.inject({ method: 'GET', url: '/api/exercises/1', headers: bearer('CLIENT') })
    expect(res.json().error?.message ?? '').not.toMatch(/^Requires role/)
  }, 30_000)
})
