import { describe, expect, it } from 'vitest'
import { formatSse, parseSse, SSE_HEARTBEAT } from './sse.js'

const encoder = new TextEncoder()
async function* chunks(...parts: string[]) {
  for (const part of parts) yield encoder.encode(part)
}
const collect = async (...parts: string[]) => {
  const out = []
  for await (const event of parseSse(chunks(...parts))) out.push(event)
  return out
}

describe('parseSse', () => {
  it('reads events split across chunks and several events in one chunk', async () => {
    expect(await collect('event: st', 'age\ndata: {"stage":"analyzing"}\n', '\nevent: text\ndata: {"delta":"a"}\n\nevent: done\ndata: {}\n\n')).toEqual([
      { event: 'stage', data: '{"stage":"analyzing"}' },
      { event: 'text', data: '{"delta":"a"}' },
      { event: 'done', data: '{}' },
    ])
  })

  it('ignores comment lines (keep-alives) and events with no data', async () => {
    expect(await collect(': ping\n\n', 'event: text\n\n', 'event: text\ndata: {"delta":"b"}\n\n')).toEqual([
      { event: 'text', data: '{"delta":"b"}' },
    ])
  })

  it('accepts CRLF line endings, also split between chunks', async () => {
    expect(await collect('event: done\r', '\ndata: {}\r\n\r\n')).toEqual([{ event: 'done', data: '{}' }])
  })

  it('keeps multi-byte characters split across chunks intact', async () => {
    const bytes = encoder.encode('event: text\ndata: {"delta":"não"}\n\n')
    async function* split() {
      yield bytes.slice(0, 27)
      yield bytes.slice(27)
    }
    const out = []
    for await (const event of parseSse(split())) out.push(event)
    expect(out).toEqual([{ event: 'text', data: '{"delta":"não"}' }])
  })

  it('drops a trailing event the stream cut before its blank line', async () => {
    expect(await collect('event: done\ndata: {}\n')).toEqual([])
  })

  it('names an event without `event:` "message"', async () => {
    expect(await collect('data: 1\n\n')).toEqual([{ event: 'message', data: '1' }])
  })

  it('refuses an event that never ends', async () => {
    await expect(collect('data: ' + 'x'.repeat(1024 * 1024 + 1))).rejects.toThrow(/too large/)
  })
})

describe('formatSse', () => {
  it('writes one event with its JSON on one data line, which parseSse reads back', async () => {
    const frame = formatSse('text', { delta: 'linha 1\nlinha 2' })
    expect(frame).toBe('event: text\ndata: {"delta":"linha 1\\nlinha 2"}\n\n')
    expect(await collect(SSE_HEARTBEAT, frame)).toEqual([{ event: 'text', data: '{"delta":"linha 1\\nlinha 2"}' }])
  })
})
