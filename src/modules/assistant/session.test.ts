import { describe, expect, it, vi } from 'vitest'
import pino from 'pino'
import { AiUpstreamError, type AiClient } from '../../ai/client.js'
import type { SseEvent } from '../../ai/sse.js'
import type { Exercise } from '../exercises/service.js'
import type { ChatContext } from './service.js'
import { ChatHandle, ChatSlots, runChat, type ChatTimings } from './session.js'

const exercise: Exercise = { id: 1, name: 'Agachamento', description: '', videoUrl: '', muscleGroups: [], isStarter: true }
const context: ChatContext = {
  request: {
    message: 'Oi',
    history: [],
    plan: { name: 'P', description: '', level: 'BEGINNER', startDate: '2026-11-02', endDate: '2026-12-27' },
    workout: { exercises: [] },
    otherWorkouts: [],
    catalog: [{ id: 1, name: 'Agachamento', muscleGroups: [] }],
  },
  catalog: new Map([[1, exercise]]),
  keys: new Set(['e1']),
}

type Step = { event: string; data: unknown } | { wait: number } | 'hang'
const ev = (event: string, data: unknown = {}): Step => ({ event, data })

/** A scripted vertice-ai: yields the steps in order, waits on `wait`, never ends on `hang`. Records the abort. */
function scripted(steps: Step[]) {
  const seen = { aborted: false, calls: 0 }
  const client: AiClient = {
    async workoutChat(_request, { signal }) {
      seen.calls++
      signal.addEventListener('abort', () => (seen.aborted = true))
      return (async function* (): AsyncGenerator<SseEvent> {
        for (const step of steps) {
          if (step === 'hang') await new Promise(() => {})
          else if ('wait' in step) await new Promise((r) => setTimeout(r, step.wait))
          else yield { event: step.event, data: typeof step.data === 'string' ? step.data : JSON.stringify(step.data) }
        }
      })()
    },
  }
  return { client, seen }
}

const timings: ChatTimings = { heartbeatMs: 20, idleTimeoutMs: 120 }

async function run(client: AiClient, options: { handle?: ChatHandle; timings?: ChatTimings } = {}) {
  let out = ''
  const logger = pino({ level: 'silent' })
  const info = vi.spyOn(logger, 'info')
  const outcome = await runChat({
    client,
    context,
    user: { id: 10, role: 'TRAINER' },
    handle: options.handle ?? new ChatHandle(),
    requestId: 'req-1',
    timings: options.timings ?? timings,
    write: (chunk) => (out += chunk),
    log: logger,
  })
  const events = out
    .split('\n\n')
    .filter((b) => b && !b.startsWith(':'))
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)![1], data: JSON.parse(/^data: (.*)$/m.exec(b)![1]!) }))
  return { outcome, events, raw: out, info }
}

describe('runChat', () => {
  it('relays stages, text and an enriched proposal in order, then done', async () => {
    const { client } = scripted([
      ev('stage', { stage: 'analyzing' }),
      ev('stage', { stage: 'choosing_exercises' }),
      ev('proposal', { exercises: [{ key: 'e1', exerciseId: 1, sets: [{ reps: 8 }] }] }),
      ev('text', { delta: 'Deixei de fora o supino: não está no seu catálogo.' }),
      ev('done', { model: 'claude-haiku-5-5', promptVersion: 'v0', usage: { inputTokens: 10, outputTokens: 5 } }),
    ])
    const { outcome, events, info } = await run(client)
    expect(outcome).toBe('done')
    expect(events).toEqual([
      { event: 'stage', data: { stage: 'analyzing' } },
      { event: 'stage', data: { stage: 'choosing_exercises' } },
      { event: 'proposal', data: { exercises: [{ key: 'e1', exerciseId: 1, sets: [{ reps: 8 }], exercise }] } },
      { event: 'text', data: { delta: 'Deixei de fora o supino: não está no seu catálogo.' } },
      { event: 'done', data: {} },
    ])
    // Ids, counts, durations and usage only: never the message or the answer.
    const line = info.mock.calls.at(-1)![0] as Record<string, unknown>
    expect(line).toMatchObject({ trainerId: 10, outcome: 'done', inputTokens: 10, outputTokens: 5, model: 'claude-haiku-5-5' })
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/supino|Oi/)
  })

  it('drops unknown stage keys and unknown events', async () => {
    const { client } = scripted([ev('stage', { stage: 'dreaming' }), ev('usage', {}), ev('text', { delta: 'a' }), ev('done')])
    const { events } = await run(client)
    expect(events.map((e) => e.event)).toEqual(['text', 'done'])
  })

  it('sends heartbeats, which do not count as progress: 120 ms of silence is AI_TIMEOUT', async () => {
    const { client, seen } = scripted([ev('stage', { stage: 'analyzing' }), 'hang'])
    const { outcome, events, raw } = await run(client)
    expect(raw).toContain(': keep-alive')
    expect(outcome).toBe('AI_TIMEOUT')
    expect(events.at(-1)).toEqual({ event: 'error', data: { code: 'AI_TIMEOUT', message: expect.any(String) } })
    expect(seen.aborted).toBe(true)
  })

  it('restarts the no-progress timer on each stage or text', async () => {
    const steps: Step[] = []
    for (let i = 0; i < 4; i++) steps.push({ wait: 70 }, ev('text', { delta: String(i) }))
    const { client } = scripted([...steps, ev('done')])
    expect((await run(client)).outcome).toBe('done')
  })

  it.each([
    ['an id outside the catalog', { exercises: [{ key: null, exerciseId: 99, sets: [] }] }],
    ['a workout name', { name: 'X', exercises: [] }],
    ['21 exercises', { exercises: Array.from({ length: 21 }, () => ({ key: null, exerciseId: 1, sets: [] })) }],
  ])('turns a proposal with %s into AI_INVALID_PROPOSAL, sends no proposal and aborts upstream', async (_, proposal) => {
    const { client, seen } = scripted([ev('stage', { stage: 'checking' }), ev('proposal', proposal), 'hang'])
    const { outcome, events } = await run(client)
    expect(outcome).toBe('AI_INVALID_PROPOSAL')
    expect(events.map((e) => e.event)).toEqual(['stage', 'error'])
    expect(seen.aborted).toBe(true)
  })

  it('refuses a second proposal', async () => {
    const proposal = { exercises: [] }
    const { client } = scripted([ev('proposal', proposal), ev('proposal', proposal), ev('done')])
    const { outcome, events } = await run(client)
    expect(outcome).toBe('AI_INVALID_PROPOSAL')
    expect(events.map((e) => e.event)).toEqual(['proposal', 'error'])
  })

  it.each([
    ['UPSTREAM_UNAVAILABLE', 'AI_UNAVAILABLE'],
    ['INVALID_PROPOSAL', 'AI_INVALID_PROPOSAL'],
    ['UPSTREAM_BAD_RESPONSE', 'AI_ERROR'],
    ['INTERNAL_ERROR', 'AI_ERROR'],
    ['SOMETHING_NEW', 'AI_ERROR'],
  ])("maps vertice-ai's %s to %s", async (code, mapped) => {
    const { client } = scripted([ev('text', { delta: 'a' }), ev('error', { code, message: 'x' })])
    const { outcome, events } = await run(client)
    expect(outcome).toBe(mapped)
    expect(events.at(-1)!.data.code).toBe(mapped)
  })

  it('reports a stream that ends without done, or with an event that is not JSON, as AI_ERROR', async () => {
    expect((await run(scripted([ev('text', { delta: 'a' })]).client)).outcome).toBe('AI_ERROR')
    expect((await run(scripted([ev('text', 'not json')]).client)).outcome).toBe('AI_ERROR')
  })

  it.each([
    ['unavailable', 'AI_UNAVAILABLE'],
    ['error', 'AI_ERROR'],
  ] as const)('maps a vertice-ai refusal (%s) before its stream', async (kind, mapped) => {
    const client: AiClient = { workoutChat: async () => Promise.reject(new AiUpstreamError(kind, 'x', 503)) }
    const { outcome, events } = await run(client)
    expect(outcome).toBe(mapped)
    expect(events).toEqual([{ event: 'error', data: { code: mapped, message: expect.any(String) } }])
  })

  it('stops without a word when the client is gone, and aborts upstream', async () => {
    const { client, seen } = scripted([ev('text', { delta: 'a' }), 'hang'])
    const handle = new ChatHandle()
    setTimeout(() => handle.stop('client'), 30)
    const { outcome, events } = await run(client, { handle })
    expect(outcome).toBe('client_closed')
    expect(events.map((e) => e.event)).toEqual(['text'])
    expect(seen.aborted).toBe(true)
  })
})

describe('ChatSlots', () => {
  it('supersedes the running message: the old one ends with AI_SUPERSEDED and its upstream is aborted', async () => {
    const slots = new ChatSlots()
    const first = scripted([ev('stage', { stage: 'analyzing' }), 'hang'])
    const h1 = slots.acquire(10)
    const running = run(first.client, { handle: h1 })
    await new Promise((r) => setTimeout(r, 20))
    const h2 = slots.acquire(10)
    const { outcome, events } = await running
    expect(outcome).toBe('AI_SUPERSEDED')
    expect(events.at(-1)!.data.code).toBe('AI_SUPERSEDED')
    expect(first.seen.aborted).toBe(true)
    // The superseded message's cleanup does not free its successor's slot.
    slots.release(10, h1)
    expect(slots.size).toBe(1)
    slots.release(10, h2)
    expect(slots.size).toBe(0)
  })

  it('keeps at most one upstream call open per trainer across messages 1, 2 and 3', async () => {
    const slots = new ChatSlots()
    const clients = [1, 2, 3].map(() => scripted(['hang']))
    const runs = clients.map((c, i) => {
      const handle = slots.acquire(10)
      expect(clients.slice(0, i).every((p) => p.seen.aborted)).toBe(true)
      return run(c.client, { handle })
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(clients.map((c) => c.seen.aborted)).toEqual([true, true, false])
    expect((await runs[0]!).outcome).toBe('AI_SUPERSEDED')
    expect((await runs[1]!).outcome).toBe('AI_SUPERSEDED')
    expect((await runs[2]!).outcome).toBe('AI_TIMEOUT')
  })

  it('keeps trainers apart', () => {
    const slots = new ChatSlots()
    const a = slots.acquire(10)
    slots.acquire(11)
    expect(a.signal.aborted).toBe(false)
  })
})
