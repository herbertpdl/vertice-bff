import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import jwt from 'jsonwebtoken'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../app.js'
import { env } from '../../config/env.js'
import { grpcCall } from '../../grpc/call.js'
import { httpAiClient } from '../../ai/client.js'
import { parseSse } from '../../ai/sse.js'
import { bearer, emailOf, fakeGrpcCall, ids, resetUpstreamCallers, userOf } from '../../test/fakeUpstream.js'

vi.mock('../../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

/**
 * The route end to end over real HTTP: the BFF listening on a port, vertice-ai a stub HTTP server
 * reached through the real `httpAiClient`, and vertice-api the in-memory fake.
 */

interface StubCall {
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
  closed: boolean
}
type Script = (res: ServerResponse, call: StubCall) => void | Promise<void>

let stub: Server
let stubUrl: string
let script: Script
const calls: StubCall[] = []

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const sse = (res: ServerResponse) => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const call: StubCall = { headers: req.headers, body: JSON.parse(raw), closed: false }
      calls.push(call)
      res.on('close', () => (call.closed = true))
      void script(res, call)
    })
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => stub.close(() => r())))

const timings = { heartbeatMs: 30, idleTimeoutMs: 1_000 }
let app: FastifyInstance
let baseUrl: string

async function start(options: Parameters<typeof buildApp>[0] = {}) {
  app = await buildApp({
    rateLimits: { globalMax: 1_000_000 },
    assistant: { enabled: true, client: httpAiClient(stubUrl), timings },
    ...options,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
}

beforeEach(() => {
  calls.length = 0
  grpcCallMock.mockReset()
  grpcCallMock.mockImplementation(fakeGrpcCall)
  resetUpstreamCallers()
  script = (res) => {
    sse(res)
    res.write(frame('stage', { stage: 'analyzing' }))
    res.write(frame('proposal', { exercises: [{ key: 'e1', exerciseId: ids.exercise, sets: [{ reps: 8 }] }, { key: null, exerciseId: ids.exercise, sets: [] }] }))
    res.end(frame('done', { model: 'claude-haiku-5-5', promptVersion: 'v0', usage: { inputTokens: 1, outputTokens: 1 } }))
  }
})
afterEach(async () => {
  await app?.close()
})

const body = (o: Record<string, unknown> = {}) => ({
  trainingPlanId: ids.planA,
  workout: { exercises: [{ key: 'e1', exerciseId: ids.exercise, sets: [{ reps: 10 }] }] },
  history: [{ role: 'user', text: 'Oi' }, { role: 'assistant', text: 'Olá!' }],
  message: 'Adicione um finalizador',
  ...o,
})

const post = (payload: unknown, init: RequestInit = {}) =>
  fetch(`${baseUrl}/api/assistant/workout-chat`, {
    method: 'POST',
    headers: { ...bearer('trainerA'), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    ...init,
  })

async function eventsOf(res: Response) {
  const out: { event: string; data: Record<string, unknown> }[] = []
  for await (const e of parseSse(res.body as unknown as AsyncIterable<Uint8Array>)) out.push({ event: e.event, data: JSON.parse(e.data) })
  return out
}

const until = async (check: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('POST /api/assistant/workout-chat', () => {
  it('streams the events with SSE headers, the proposal enriched with its exercises', async () => {
    await start()
    const res = await post(body())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    const events = await eventsOf(res)
    expect(events.map((e) => e.event)).toEqual(['stage', 'proposal', 'done'])
    expect(events[1]!.data).toEqual({
      exercises: [
        { key: 'e1', exerciseId: ids.exercise, sets: [{ reps: 8 }], exercise: expect.objectContaining({ id: ids.exercise, name: 'Exercise 1' }) },
        { key: null, exerciseId: ids.exercise, sets: [], exercise: expect.objectContaining({ id: ids.exercise }) },
      ],
    })
    expect(events[2]!.data).toEqual({})
  })

  it('signs a vertice-ai token, never the user token or vertice-api service token', async () => {
    await start()
    await eventsOf(await post(body()))
    const auth = calls[0]!.headers.authorization!
    const token = auth.replace(/^Bearer /, '')
    expect(token).not.toBe(bearer('trainerA').authorization.replace(/^Bearer /, ''))
    const claims = jwt.verify(token, env.SERVICE_JWT_SECRET, { algorithms: ['HS256'], issuer: 'vertice-bff', audience: 'vertice-ai' })
    expect(claims).toMatchObject({ sub: 'service:bff', uid: ids.trainerA, role: 'TRAINER' })
    expect(() => jwt.verify(token, env.JWT_SECRET)).toThrow()
    expect(calls[0]!.headers['x-request-id']).toBeTruthy()
  })

  it("sends vertice-ai the contract's body and never the client's id, name or email (R13)", async () => {
    await start()
    await eventsOf(await post(body()))
    const sent = calls[0]!.body
    expect(Object.keys(sent).sort()).toEqual(['catalog', 'history', 'message', 'otherWorkouts', 'plan', 'workout'])
    expect(sent.plan).toEqual({ name: `Plan ${ids.planA}`, description: '', level: 'BEGINNER', startDate: '2026-01-01', endDate: '2099-12-31' })
    expect(sent.workout).toEqual({ exercises: [{ key: 'e1', exerciseId: ids.exercise, sets: [{ reps: 10 }] }] })
    // No workoutId: workout A is one of the plan's other workouts.
    expect(sent.otherWorkouts).toEqual([
      { name: `Workout ${ids.workoutA}`, dayOfWeek: 'MONDAY', exercises: [{ name: 'Exercise 1', muscleGroups: ['Peito'], sets: 1 }] },
    ])
    expect(sent.catalog).toEqual([{ id: ids.exercise, name: 'Exercise 1', muscleGroups: ['Peito'] }])
    const text = JSON.stringify(sent)
    expect(text).not.toContain('clientId')
    expect(text).not.toContain(userOf('clientA').name)
    expect(text).not.toContain(emailOf(ids.clientA))
  })

  it('names the workout on screen but leaves it out of the other workouts when it exists', async () => {
    await start()
    await eventsOf(await post(body({ workoutId: ids.workoutA })))
    expect(calls[0]!.body.workout).toMatchObject({ name: `Workout ${ids.workoutA}`, dayOfWeek: 'MONDAY' })
    expect(calls[0]!.body.otherWorkouts).toEqual([])
  })

  it('cancels the upstream request when the client aborts (R16, R50)', async () => {
    script = (res) => {
      sse(res)
      res.write(frame('stage', { stage: 'analyzing' }))
    }
    await start()
    // node:http, not fetch: undici keeps an aborted streaming socket open in the test process.
    const payload = JSON.stringify(body())
    const req = request(`${baseUrl}/api/assistant/workout-chat`, {
      method: 'POST',
      headers: { ...bearer('trainerA'), 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    })
    req.end(payload)
    const res = await new Promise<IncomingMessage>((r) => req.on('response', r))
    await new Promise((r) => res.once('data', r))
    expect(calls[0]!.closed).toBe(false)
    req.destroy()
    await until(() => calls[0]!.closed)
  })

  it('supersedes a running message from the same trainer: AI_SUPERSEDED, and its upstream is closed (R14, F10)', async () => {
    let n = 0
    script = (res) => {
      sse(res)
      res.write(frame('stage', { stage: 'analyzing' }))
      if (++n === 2) res.end(frame('done', {}))
    }
    await start()
    const first = await post(body())
    const firstEvents = eventsOf(first)
    await until(() => calls.length === 1)
    const second = await eventsOf(await post(body()))
    expect(second.map((e) => e.event)).toEqual(['stage', 'done'])
    const events = await firstEvents
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'AI_SUPERSEDED', message: expect.any(String) } })
    await until(() => calls[0]!.closed)
  })

  it('reports a vertice-ai 404 (its flag off) as AI_UNAVAILABLE and a 400 as AI_ERROR', async () => {
    await start()
    script = (res) => void res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
    expect((await eventsOf(await post(body()))).at(-1)!.data.code).toBe('AI_UNAVAILABLE')
    script = (res) => void res.writeHead(400, { 'content-type': 'application/json' }).end('{}')
    expect((await eventsOf(await post(body()))).at(-1)!.data.code).toBe('AI_ERROR')
  })

  it('reports an unreachable vertice-ai as AI_UNAVAILABLE', async () => {
    await start({ assistant: { enabled: true, client: httpAiClient('http://127.0.0.1:1'), timings } })
    const events = await eventsOf(await post(body()))
    expect(events).toEqual([{ event: 'error', data: { code: 'AI_UNAVAILABLE', message: expect.any(String) } }])
  })

  it('times out a silent vertice-ai with AI_TIMEOUT despite its keep-alives (R21)', async () => {
    script = (res) => {
      sse(res)
      const t = setInterval(() => res.write(': ping\n\n'), 20)
      res.on('close', () => clearInterval(t))
    }
    await start({ assistant: { enabled: true, client: httpAiClient(stubUrl), timings: { heartbeatMs: 30, idleTimeoutMs: 150 } } })
    const events = await eventsOf(await post(body()))
    expect(events.at(-1)!.data.code).toBe('AI_TIMEOUT')
    await until(() => calls[0]!.closed)
  })

  it.each([
    ['a 2,001-character message', body({ message: 'a'.repeat(2001) })],
    ['21 history turns', body({ history: Array.from({ length: 21 }, () => ({ role: 'user', text: 'x' })) })],
    ['a missing workout', { trainingPlanId: ids.planA, message: 'Oi' }],
  ])('answers 400 to %s, before calling anything', async (_, payload) => {
    await start()
    const res = await post(payload)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    expect(calls).toEqual([])
  })

  it('answers 503 AI_UNAVAILABLE while switched off, without any upstream call', async () => {
    await start({ assistant: { enabled: false } })
    const res = await post(body())
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('AI_UNAVAILABLE')
    expect(grpcCallMock).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})

describe('GET /api/assistant/status', () => {
  it.each([true, false])('says enabled: %s', async (enabled) => {
    await start({ assistant: { enabled, client: httpAiClient(stubUrl), timings } })
    const res = await fetch(`${baseUrl}/api/assistant/status`, { headers: bearer('trainerA') })
    expect(await res.json()).toEqual({ enabled })
  })
})
