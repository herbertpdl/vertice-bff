/**
 * Server-sent events, both directions: `parseSse` reads vertice-ai's stream, `formatSse` writes the
 * BFF's own. Only the subset both sides use: `event:` and `data:` fields, comment lines (`:`) for
 * heartbeats, blank line ends an event. No `id:`/`retry:` (nothing is resumable: a dropped stream is
 * a failed message, PRD R21).
 */

export interface SseEvent {
  event: string
  data: string
}

/** Bytes of an event's lines held before it ends: an upstream that never ends an event is cut off. */
export const MAX_SSE_EVENT_BYTES = 1024 * 1024

export class SseFormatError extends Error {}

/**
 * Yields each complete event of `body`. Comment lines and events with no `data` are skipped; an
 * event without `event:` is `message`, as the spec says. A trailing event with no blank line after it
 * is dropped (the stream was cut). Line endings: `\n`, `\r\n` or `\r`.
 */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []
  let pending = 0
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    pending += chunk.byteLength
    if (pending > MAX_SSE_EVENT_BYTES) throw new SseFormatError('event too large')
    let match: RegExpExecArray | null
    const lineEnd = /\r\n|\r|\n/g
    let consumed = 0
    while ((match = lineEnd.exec(buffer))) {
      // A lone `\r` at the very end may be the first half of `\r\n`: wait for the next chunk.
      if (match[0] === '\r' && match.index === buffer.length - 1) break
      const line = buffer.slice(consumed, match.index)
      consumed = match.index + match[0].length
      if (line === '') {
        if (data.length > 0) yield { event: event || 'message', data: data.join('\n') }
        event = ''
        data = []
        pending = buffer.length - consumed
        continue
      }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    buffer = buffer.slice(consumed)
  }
}

/** One event: `event: <name>` and the JSON payload on one `data:` line (JSON never holds a raw newline). */
export function formatSse(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** A comment line: keeps proxies from closing an idle connection, ignored by every SSE parser. */
export const SSE_HEARTBEAT = ': keep-alive\n\n'
