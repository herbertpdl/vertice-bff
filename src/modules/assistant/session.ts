import type { FastifyBaseLogger } from 'fastify'
import {
  AI_MAX_LINE,
  AI_UPSTREAM_INVALID_PROPOSAL_CODES,
  ASSISTANT_LINES,
  AI_UPSTREAM_UNAVAILABLE_CODES,
  ASSISTANT_STAGES,
  aiDoneEventSchema,
  aiErrorEventSchema,
  aiProposalEventSchema,
  aiStageEventSchema,
  aiTextEventSchema,
  type AssistantLine,
  type AssistantStage,
} from '../../ai/contract.js'
import { AiUpstreamError, type AiClient } from '../../ai/client.js'
import { formatSse, SSE_HEARTBEAT, type SseEvent } from '../../ai/sse.js'
import type { AuthUser } from '../../lib/jwt.js'
import type { ChatContext } from './service.js'
import { validateProposal } from './proposal.js'

/**
 * One assistant message, from the moment the stream opens to its last event (BFF assessment F3,
 * F6, F10, F11). Independent of Fastify: it writes SSE text through `write` and is told to stop
 * through its `ChatHandle`.
 */

/** The error codes a stream can end with (also in `ERROR_CODES`). */
export type StreamErrorCode = 'AI_UNAVAILABLE' | 'AI_TIMEOUT' | 'AI_INVALID_PROPOSAL' | 'AI_ERROR' | 'AI_SUPERSEDED'

/** English, for logs; the web shows its own copy keyed on `code`. */
const STREAM_ERROR_MESSAGES: Record<StreamErrorCode, string> = {
  AI_UNAVAILABLE: 'The assistant is unavailable, try again later',
  AI_TIMEOUT: 'The assistant showed no progress for too long',
  AI_INVALID_PROPOSAL: 'The assistant could not build a valid workout',
  AI_ERROR: 'The assistant could not answer',
  AI_SUPERSEDED: 'A newer message from the same trainer took over',
}

export type StopReason = 'client' | 'superseded' | 'timeout' | 'finished'

/** A running message's stop switch. Aborting it aborts the upstream request (F6). */
export class ChatHandle {
  private readonly controller = new AbortController()
  reason: StopReason | undefined

  get signal(): AbortSignal {
    return this.controller.signal
  }

  stop(reason: StopReason): void {
    if (this.controller.signal.aborted) return
    this.reason = reason
    this.controller.abort(new Error(`assistant message stopped: ${reason}`))
  }
}

/**
 * At most one running message per trainer, per BFF task (F10). A new message supersedes the
 * running one rather than being refused: after "Parar" or "Tentar novamente" the new request can
 * arrive before the old connection's close does (R16, R22). A slot is released only by the handle
 * that holds it, so a superseded message's cleanup never frees its successor's slot.
 */
export class ChatSlots {
  private readonly running = new Map<number, ChatHandle>()

  acquire(trainerId: number): ChatHandle {
    this.running.get(trainerId)?.stop('superseded')
    const handle = new ChatHandle()
    this.running.set(trainerId, handle)
    return handle
  }

  release(trainerId: number, handle: ChatHandle): void {
    if (this.running.get(trainerId) === handle) this.running.delete(trainerId)
  }

  /** Running messages (tests). */
  get size(): number {
    return this.running.size
  }
}

export interface ChatTimings {
  /** A comment line this often keeps CloudFront, the ALB and the web proxy from idling out (F3). */
  heartbeatMs: number
  /** R21: no new stage or text for this long ends the message with `AI_TIMEOUT`. Heartbeats don't count. */
  idleTimeoutMs: number
}

export const DEFAULT_CHAT_TIMINGS: ChatTimings = { heartbeatMs: 10_000, idleTimeoutMs: 60_000 }

export interface ChatRun {
  client: AiClient
  context: ChatContext
  user: Pick<AuthUser, 'id' | 'role'>
  handle: ChatHandle
  requestId: string
  timings: ChatTimings
  /** Writes SSE text to the response; a no-op once the client is gone. */
  write: (chunk: string) => void
  log: FastifyBaseLogger
}

export type ChatOutcome = 'done' | StreamErrorCode | 'client_closed'

const STAGES = new Set<string>(ASSISTANT_STAGES)
const LINES = new Set<string>(ASSISTANT_LINES)

/**
 * Whether a `text` event's `line` can be relayed (client-anamnese spec §4): a known value, the
 * first with that value, `left_out` never after `anamnese_conflict`, and one non-blank line of at
 * most 300 code points. Otherwise the reason it can't: the delta then goes out as answer text,
 * so a bad marker degrades the display, never loses text.
 */
function lineProblem(line: unknown, delta: string, seen: Set<AssistantLine>): string | undefined {
  if (typeof line !== 'string' || !LINES.has(line)) return 'unknown_line'
  if (seen.has(line as AssistantLine)) return 'repeated_line'
  if (line === 'left_out' && seen.has('anamnese_conflict')) return 'line_order'
  if (!delta.trim() || /[\r\n]/.test(delta) || [...delta].length > AI_MAX_LINE) return 'line_shape'
  return undefined
}

class Stopped extends Error {}

/**
 * Runs one message to its end: relays stages and text as they arrive, validates and enriches the
 * proposal, and ends with exactly one `done` or `error` event (none when the client is gone). Every
 * end, including the BFF's own errors, aborts the upstream request. Never rejects.
 */
export async function runChat(run: ChatRun): Promise<ChatOutcome> {
  const { handle, timings } = run
  const send = (event: string, payload: unknown) => run.write(formatSse(event, payload))
  const started = Date.now()
  let proposals = 0
  let textChunks = 0
  const lines = new Set<AssistantLine>()
  let usage: { model?: string; promptVersion?: string; inputTokens?: number; outputTokens?: number } = {}

  const heartbeat = setInterval(() => run.write(SSE_HEARTBEAT), timings.heartbeatMs)
  let idle: NodeJS.Timeout | undefined
  const progressed = () => {
    clearTimeout(idle)
    idle = setTimeout(() => handle.stop('timeout'), timings.idleTimeoutMs)
  }
  progressed()

  // Rejects as soon as the handle stops, so a hung upstream iterator cannot keep the message open.
  const stopped = new Promise<never>((_, reject) => {
    if (handle.signal.aborted) reject(new Stopped())
    handle.signal.addEventListener('abort', () => reject(new Stopped()), { once: true })
  })
  stopped.catch(() => {})

  let iterator: AsyncIterator<SseEvent> | undefined
  const finish = (outcome: ChatOutcome): ChatOutcome => {
    if (outcome !== 'done' && outcome !== 'client_closed') {
      send('error', { code: outcome, message: STREAM_ERROR_MESSAGES[outcome] })
    }
    return outcome
  }

  const outcome = await (async (): Promise<ChatOutcome> => {
    try {
      const events = await Promise.race([
        run.client.workoutChat(run.context.request, { user: run.user, signal: handle.signal, requestId: run.requestId }),
        stopped,
      ])
      iterator = events[Symbol.asyncIterator]()
      for (;;) {
        const next = await Promise.race([iterator.next(), stopped])
        if (next.done) {
          run.log.warn({ assistant: 'workout-chat' }, 'vertice-ai stream ended without done')
          return finish('AI_ERROR')
        }
        const { event, data } = next.value
        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch {
          run.log.warn({ assistant: 'workout-chat', event }, 'vertice-ai sent an event that is not JSON')
          return finish('AI_ERROR')
        }
        switch (event) {
          case 'stage': {
            const parsed = aiStageEventSchema.safeParse(payload)
            if (!parsed.success) return finish('AI_ERROR')
            progressed()
            // An unknown key still counts as progress, but the web only labels the known ones.
            if (STAGES.has(parsed.data.stage)) {
              const stage = parsed.data.stage as AssistantStage
              const exercise = stage === 'building_sets' ? parsed.data.exercise : undefined
              send('stage', exercise === undefined ? { stage } : { stage, exercise })
            }
            else run.log.warn({ assistant: 'workout-chat', stage: parsed.data.stage.slice(0, 40) }, 'Unknown stage dropped')
            break
          }
          case 'text': {
            const parsed = aiTextEventSchema.safeParse(payload)
            if (!parsed.success) return finish('AI_ERROR')
            progressed()
            textChunks++
            const { delta, line } = parsed.data
            if (!delta) break
            if (line === undefined) {
              send('text', { delta })
              break
            }
            const problem = lineProblem(line, delta, lines)
            if (problem) {
              run.log.warn(
                { assistant: 'workout-chat', reason: problem, line: typeof line === 'string' ? line.slice(0, 40) : typeof line },
                'Text line marker dropped',
              )
              send('text', { delta })
              break
            }
            lines.add(line as AssistantLine)
            send('text', { delta, line })
            break
          }
          case 'proposal': {
            const parsed = aiProposalEventSchema.safeParse(payload)
            const result = parsed.success
              ? validateProposal(parsed.data, run.context.catalog, run.context.keys)
              : { ok: false as const, reason: 'schema: (root)' }
            if (!result.ok || ++proposals > 1) {
              run.log.warn(
                { assistant: 'workout-chat', reason: result.ok ? 'second proposal' : result.reason },
                'Invalid proposal from vertice-ai',
              )
              return finish('AI_INVALID_PROPOSAL')
            }
            progressed()
            send('proposal', result.proposal)
            break
          }
          case 'done': {
            const meta = aiDoneEventSchema.safeParse(payload)
            if (meta.success) {
              usage = {
                model: meta.data.model?.slice(0, 64),
                promptVersion: meta.data.promptVersion?.slice(0, 64),
                inputTokens: meta.data.usage?.inputTokens ?? undefined,
                outputTokens: meta.data.usage?.outputTokens ?? undefined,
              }
            }
            send('done', {})
            return 'done'
          }
          case 'error': {
            const parsed = aiErrorEventSchema.safeParse(payload)
            const code = parsed.success ? parsed.data.code : 'UNKNOWN'
            run.log.warn({ assistant: 'workout-chat', upstreamCode: code.slice(0, 40) }, 'vertice-ai reported an error')
            if (AI_UPSTREAM_UNAVAILABLE_CODES.has(code)) return finish('AI_UNAVAILABLE')
            if (AI_UPSTREAM_INVALID_PROPOSAL_CODES.has(code)) return finish('AI_INVALID_PROPOSAL')
            return finish('AI_ERROR')
          }
          default:
            // Forward compatible: an event this BFF doesn't know is ignored, not relayed.
            break
        }
      }
    } catch (err) {
      if (handle.signal.aborted) {
        if (handle.reason === 'superseded') return finish('AI_SUPERSEDED')
        if (handle.reason === 'timeout') return finish('AI_TIMEOUT')
        return 'client_closed'
      }
      if (err instanceof AiUpstreamError) {
        // A 401 means the shared SERVICE_JWT_SECRET differs between the two services: an operator problem.
        const level = err.status === 401 ? 'error' : 'warn'
        run.log[level]({ assistant: 'workout-chat', err: err.message, upstreamStatus: err.status }, 'vertice-ai call failed')
        return finish(err.kind === 'unavailable' ? 'AI_UNAVAILABLE' : 'AI_ERROR')
      }
      run.log.error({ assistant: 'workout-chat', err }, 'Assistant stream failed')
      return finish('AI_ERROR')
    }
  })()

  clearInterval(heartbeat)
  clearTimeout(idle)
  // Every end closes the upstream request too (F6): an invalid proposal or a timeout must not
  // leave vertice-ai generating for no one.
  handle.stop('finished')
  void iterator?.return?.()?.catch(() => {})
  // Ids, counts and durations only; never the message, history, workout or proposal (F7).
  run.log.info(
    {
      assistant: 'workout-chat',
      trainerId: run.user.id,
      outcome,
      durationMs: Date.now() - started,
      textChunks,
      proposals,
      lines: [...lines],
      // An enum, never the text (client-anamnese A9).
      anamnese: run.context.anamnese,
      ...usage,
    },
    'Assistant message finished',
  )
  return outcome
}
