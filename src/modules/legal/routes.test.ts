import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../app.js'
import { env } from '../../config/env.js'
import { grpcCall } from '../../grpc/call.js'

vi.mock('../../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))

describe('GET /legal/versions', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })
  afterAll(() => app.close())

  it('answers the configured versions without a token or any upstream call', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/legal/versions' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ terms: env.TERMS_VERSION, healthData: env.HEALTH_DATA_CONSENT_VERSION })
    expect(vi.mocked(grpcCall)).not.toHaveBeenCalled()
  })

  it('defaults both versions to the draft version', () => {
    expect(env.TERMS_VERSION).toBe('2026-10-draft')
    expect(env.HEALTH_DATA_CONSENT_VERSION).toBe('2026-10-draft')
  })

  it('is publicly cacheable, unlike the rest of /api', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/legal/versions' })
    expect(res.headers['cache-control']).toBe('public, max-age=300')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('keeps no-store on its error responses', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/legal/versions' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['cache-control']).toBe('no-store')
  })
})
