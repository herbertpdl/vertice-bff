import { AI_WORKOUT_CHAT_PATH, type AiWorkoutChatRequest } from './contract.js'
import { parseSse, type SseEvent } from './sse.js'
import { signAiServiceToken } from './token.js'
import type { AuthUser } from '../lib/jwt.js'

/**
 * The BFF's only outbound HTTP upstream: vertice-ai (BFF assessment F1). Everything else the BFF
 * calls is vertice-api over gRPC. The token is `signAiServiceToken`'s, never the user's and never
 * `serviceToken()`.
 */

/** Why vertice-ai could not answer, before or during its stream. `unavailable` means "try again later". */
export class AiUpstreamError extends Error {
  constructor(
    public readonly kind: 'unavailable' | 'error',
    message: string,
    /** vertice-ai's HTTP status, when it answered one. */
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'AiUpstreamError'
  }
}

export interface AiCallOptions {
  user: Pick<AuthUser, 'id' | 'role'>
  /** Aborts the HTTP request (client gone, superseded, timed out, invalid proposal). */
  signal: AbortSignal
  requestId: string
}

export interface AiClient {
  /** Opens the stream; rejects with `AiUpstreamError` when vertice-ai refuses or cannot be reached. */
  workoutChat(request: AiWorkoutChatRequest, options: AiCallOptions): Promise<AsyncIterable<SseEvent>>
}

/** How long to wait for vertice-ai's response headers before calling it unavailable. */
export const AI_CONNECT_TIMEOUT_MS = 10_000

export function httpAiClient(baseUrl: string): AiClient {
  return {
    async workoutChat(request, { user, signal, requestId }) {
      // The fetch signal also governs the body, so the connect timeout is cleared once headers arrive.
      const connect = new AbortController()
      const forward = () => connect.abort(signal.reason)
      if (signal.aborted) forward()
      else signal.addEventListener('abort', forward, { once: true })
      const connectTimer = setTimeout(() => connect.abort(new Error('connect timeout')), AI_CONNECT_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(`${baseUrl}${AI_WORKOUT_CHAT_PATH}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${signAiServiceToken(user)}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'x-request-id': requestId,
          },
          body: JSON.stringify(request),
          signal: connect.signal,
          redirect: 'error',
        })
      } catch (err) {
        if (signal.aborted) throw err
        throw new AiUpstreamError('unavailable', `vertice-ai unreachable: ${(err as Error).name}`)
      } finally {
        clearTimeout(connectTimer)
      }
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {})
        // vertice-ai spec §4: 404 (its flag is off), 401 (the shared secret is misconfigured) and
        // 5xx are "unavailable"; a 400 means the BFF built a bad request, an error.
        const kind = res.status === 404 || res.status === 401 || res.status >= 500 ? 'unavailable' : 'error'
        throw new AiUpstreamError(kind, `vertice-ai answered ${res.status}`, res.status)
      }
      if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
        await res.body.cancel().catch(() => {})
        throw new AiUpstreamError('error', 'vertice-ai did not answer an event stream')
      }
      // Once the headers are in, only the caller's signal cuts the body (forwarded above): the R21
      // idle timer (`modules/assistant/session.ts`) decides how long a silent stream may last.
      return parseSse(res.body as unknown as AsyncIterable<Uint8Array>)
    },
  }
}
