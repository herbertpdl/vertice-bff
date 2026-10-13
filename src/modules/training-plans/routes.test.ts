import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../app.js'
import { grpcCall } from '../../grpc/call.js'
import { signToken, type Role } from '../../lib/jwt.js'

// gRPC is mocked at `grpcCall`, so these tests pin the exact request the BFF sends upstream.
vi.mock('../../grpc/call.js', () => ({ grpcCall: vi.fn() }))
const grpcCallMock = vi.mocked(grpcCall)

const TRAINER_ID = 10
const CLIENT_ID = 20

const storedPlan = {
  id: '5',
  name: 'Hipertrofia',
  description: '',
  trainerId: String(TRAINER_ID),
  clientId: String(CLIENT_ID),
  startDate: '2026-10-01',
  endDate: '2026-12-31',
  level: 'BEGINNER',
}

const patchBody = {
  name: 'Hipertrofia II',
  description: 'Bloco 2',
  startDate: '2026-11-01',
  endDate: '2027-01-31',
  level: 'INTERMEDIATE',
}

describe('training plan routes', () => {
  let app: FastifyInstance
  const bearer = (role: Role, id = TRAINER_ID) => ({
    authorization: `Bearer ${signToken({ id, name: 'U', email: 'u@vertice.test', role })}`,
  })

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
  })

  afterAll(() => app.close())

  beforeEach(() => {
    grpcCallMock.mockReset()
    grpcCallMock.mockImplementation(async (_client, method, request) => {
      if (method === 'GetTrainingPlan') return storedPlan
      if (method === 'UpdateTrainingPlan') {
        const { id, trainingPlan } = request as { id: number; trainingPlan: Record<string, unknown> }
        return { ...storedPlan, ...trainingPlan, id: String(id), clientId: String(trainingPlan.clientId) }
      }
      throw new Error(`unexpected upstream call ${method}`)
    })
  })

  const updateRequest = () => {
    const call = grpcCallMock.mock.calls.find(([, method]) => method === 'UpdateTrainingPlan')
    expect(call).toBeDefined()
    return call![2] as { id: number; trainingPlan: Record<string, unknown> }
  }

  it('PATCH /api/training-plans/:id without clientId succeeds and forwards the stored clientId upstream', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/training-plans/5',
      headers: bearer('TRAINER'),
      payload: patchBody,
    })
    expect(res.statusCode).toBe(200)
    expect(updateRequest()).toEqual({ id: 5, trainingPlan: { ...patchBody, clientId: CLIENT_ID } })
    expect(res.json()).toMatchObject({ id: 5, name: 'Hipertrofia II', clientId: CLIENT_ID, trainerId: TRAINER_ID })
  })

  it('PATCH /api/training-plans/:id ignores a different clientId in the body and keeps the stored one', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/training-plans/5',
      headers: bearer('TRAINER'),
      payload: { ...patchBody, clientId: 999 },
    })
    expect(res.statusCode).toBe(200)
    expect(updateRequest().trainingPlan.clientId).toBe(CLIENT_ID)
    expect(res.json().clientId).toBe(CLIENT_ID)
  })

  it('PATCH /api/training-plans/:id with a missing required field is 400 VALIDATION_ERROR and never calls UpdateTrainingPlan', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/training-plans/5',
      headers: bearer('TRAINER'),
      payload: { ...patchBody, name: undefined },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
    expect(grpcCallMock.mock.calls.some(([, method]) => method === 'UpdateTrainingPlan')).toBe(false)
  })

  it("PATCH /api/training-plans/:id on another trainer's plan is 403 FORBIDDEN", async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/training-plans/5',
      headers: bearer('TRAINER', TRAINER_ID + 1),
      payload: patchBody,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
    expect(grpcCallMock.mock.calls.some(([, method]) => method === 'UpdateTrainingPlan')).toBe(false)
  })
})
