import { describe, expect, it } from 'vitest'
import { AttemptLimiter, type AttemptTicket } from './attempt-limiter.js'

describe('AttemptLimiter', () => {
  const make = (maxKeys = 1000) => {
    let now = 0
    const limiter = new AttemptLimiter({ max: 2, windowMs: 1000, maxKeys, now: () => now })
    return { limiter, advance: (ms: number) => (now += ms) }
  }
  const ticketOf = (result: ReturnType<AttemptLimiter['tryAcquire']>): AttemptTicket => {
    if (!result.allowed) throw new Error('expected the attempt to be allowed')
    return result.ticket
  }

  it('refuses the attempt after max within the window, with the wait', () => {
    const { limiter, advance } = make()
    expect(limiter.tryAcquire(['a']).allowed).toBe(true)
    advance(100)
    expect(limiter.tryAcquire(['a']).allowed).toBe(true)
    expect(limiter.tryAcquire(['a'])).toEqual({ allowed: false, retryAfterMs: 900, reason: 'limit' })
  })

  it('starts over once the window has passed', () => {
    const { limiter, advance } = make()
    limiter.tryAcquire(['a'])
    limiter.tryAcquire(['a'])
    advance(1000)
    expect(limiter.tryAcquire(['a']).allowed).toBe(true)
  })

  it('refuses when any key is full, and then counts none of them', () => {
    const { limiter } = make()
    limiter.tryAcquire(['ip'])
    limiter.tryAcquire(['ip'])
    expect(limiter.tryAcquire(['ip', 'email']).allowed).toBe(false)
    // `email` was not charged for the refused attempt.
    expect(limiter.tryAcquire(['email']).allowed).toBe(true)
    expect(limiter.tryAcquire(['email']).allowed).toBe(true)
  })

  it('gives an attempt back on release', () => {
    const { limiter } = make()
    limiter.tryAcquire(['a'])
    const ticket = ticketOf(limiter.tryAcquire(['a']))
    limiter.release(ticket)
    expect(limiter.tryAcquire(['a']).allowed).toBe(true)
  })

  it('does not refund into a later window an attempt counted in an earlier one', () => {
    const { limiter, advance } = make()
    const stale = ticketOf(limiter.tryAcquire(['a']))
    advance(1000) // window over; the next attempts start a new one
    limiter.tryAcquire(['a'])
    limiter.tryAcquire(['a'])
    limiter.release(stale)
    expect(limiter.tryAcquire(['a']).allowed).toBe(false)
  })

  describe('memory bound', () => {
    it('stays under maxKeys and fails closed for new keys, without evicting live ones', () => {
      const { limiter } = make(100)
      limiter.tryAcquire(['victim'])
      limiter.tryAcquire(['victim'])
      for (let i = 0; i < 10_000; i++) limiter.tryAcquire([`spray-${i}`])
      expect(limiter.size).toBe(100)
      // The victim's counter was not flushed by the spray...
      expect(limiter.tryAcquire(['victim'])).toMatchObject({ allowed: false, reason: 'limit' })
      // ...and a new key is refused until the oldest bucket expires.
      expect(limiter.tryAcquire(['newcomer'])).toMatchObject({ allowed: false, reason: 'capacity', retryAfterMs: 1000 })
    })

    it('frees capacity as windows end', () => {
      const { limiter, advance } = make(100)
      for (let i = 0; i < 100; i++) limiter.tryAcquire([`k-${i}`])
      expect(limiter.tryAcquire(['newcomer']).allowed).toBe(false)
      advance(1000)
      expect(limiter.tryAcquire(['newcomer']).allowed).toBe(true)
      expect(limiter.size).toBe(1)
    })

    it('sweeps incrementally: one visit per call while nothing expires, each expired bucket visited once', () => {
      const { limiter, advance } = make(100_000)
      const n = 50_000
      for (let i = 0; i < n; i++) {
        limiter.tryAcquire([`k-${i}`])
        advance(0.01) // later keys expire later
      }
      // A full map costs one visit per call (the live front), not a scan of all n keys.
      expect(limiter.sweepVisits).toBeLessThanOrEqual(n)

      const before = limiter.sweepVisits
      advance(1000 - 0.01 * n + 0.01 * (n / 2)) // the first half has expired
      for (let i = 0; i < 1000; i++) limiter.tryAcquire(['probe'])
      // n/2 expired buckets removed once each, plus about one visit per call.
      expect(limiter.sweepVisits - before).toBeLessThanOrEqual(n / 2 + 2 * 1000)
      expect(limiter.size).toBeLessThanOrEqual(n / 2 + 1)
    })
  })
})
