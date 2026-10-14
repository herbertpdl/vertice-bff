import { describe, expect, it } from 'vitest'
import { AttemptLimiter } from './attempt-limiter.js'

describe('AttemptLimiter', () => {
  const make = () => {
    let now = 0
    const limiter = new AttemptLimiter({ max: 2, windowMs: 1000, now: () => now })
    return { limiter, advance: (ms: number) => (now += ms) }
  }

  it('refuses the attempt after max within the window, with the wait', () => {
    const { limiter, advance } = make()
    expect(limiter.tryAcquire(['a'])).toEqual({ allowed: true })
    advance(100)
    expect(limiter.tryAcquire(['a'])).toEqual({ allowed: true })
    expect(limiter.tryAcquire(['a'])).toEqual({ allowed: false, retryAfterMs: 900 })
  })

  it('starts over once the window has passed', () => {
    const { limiter, advance } = make()
    limiter.tryAcquire(['a'])
    limiter.tryAcquire(['a'])
    advance(1000)
    expect(limiter.tryAcquire(['a'])).toEqual({ allowed: true })
  })

  it('refuses when any key is full, and then counts none of them', () => {
    const { limiter } = make()
    limiter.tryAcquire(['ip'])
    limiter.tryAcquire(['ip'])
    expect(limiter.tryAcquire(['ip', 'email']).allowed).toBe(false)
    // `email` was not charged for the refused attempt.
    expect(limiter.tryAcquire(['email'])).toEqual({ allowed: true })
    expect(limiter.tryAcquire(['email'])).toEqual({ allowed: true })
  })

  it('gives an attempt back on release', () => {
    const { limiter } = make()
    limiter.tryAcquire(['a'])
    limiter.tryAcquire(['a'])
    limiter.release(['a'])
    expect(limiter.tryAcquire(['a'])).toEqual({ allowed: true })
  })
})
