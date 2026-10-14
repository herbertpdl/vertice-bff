import { performance } from 'node:perf_hooks'

/**
 * In-memory fixed-window counter for the strict auth buckets (login, register, password
 * setup/change). Unlike `@fastify/rate-limit`, which counts every request, an attempt here can be
 * refunded once its outcome is known, so a bucket can count failures only.
 *
 * The attempt is counted up front and refunded afterwards (rather than counted after it fails)
 * so a burst of concurrent guesses can't all pass the check before the first failure lands. A
 * bucket refunded back to zero is deleted, so only attempts that still count hold memory.
 *
 * Memory is bounded three ways (callers keep keys short and fixed-size; see `plugins/rate-limit.ts`):
 * - **Incremental sweep.** Every bucket has the same `windowMs` and a bucket is only ever
 *   (re)inserted at the back of the Map, so insertion order is `resetAt` order. Each call drops
 *   expired buckets from the front, at most `sweepBudget` of them, and stops at the first live
 *   one. An expired bucket the sweep hasn't reached yet counts as missing.
 * - **Per-key limits.** A key can carry its own `max`, e.g. a coarse network bucket checked with
 *   the others before anything is allocated, which bounds how many keys one network can mint.
 * - **Hard cap (`maxKeys`), fail closed.** When the Map is full, an attempt that needs a new
 *   bucket is refused until older buckets expire. Evicting live buckets instead would let an
 *   attacker flush a victim's counter by spraying new keys, which is the attack these buckets
 *   exist to stop. Keys already tracked keep working while the Map is full.
 *
 * The clock is monotonic (`performance.now()`), so a wall-clock jump can't stretch or end a
 * window. State lives in this process: with several BFF instances each keeps its own counts (a
 * shared store such as Redis is the follow-up for that).
 */
export interface AttemptLimiterOptions {
  /** Attempts allowed per key per window (unless the key carries its own); the next one is refused. */
  max: number
  windowMs: number
  /** Most buckets held at once; beyond it, new keys are refused. */
  maxKeys: number
  /** Most expired buckets one call deletes, so a burst of expiries can't stall a request. */
  sweepBudget?: number
  now?: () => number
}

/** A bucket key, optionally with its own limit (e.g. a looser aggregate bucket). */
export type AttemptKey = string | { key: string; max: number }

/** What `release` needs to refund exactly the buckets this attempt was counted in. */
export type AttemptTicket = readonly { key: string; resetAt: number }[]

export type AcquireResult =
  | { allowed: true; ticket: AttemptTicket }
  | { allowed: false; retryAfterMs: number; reason: 'limit' | 'capacity' }

interface Bucket {
  count: number
  resetAt: number
}

const DEFAULT_SWEEP_BUDGET = 1000

export class AttemptLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly now: () => number
  private readonly sweepBudget: number
  /** Map entries the sweep has looked at, ever. Exposed so tests can check the sweep stays cheap. */
  sweepVisits = 0

  constructor(private readonly options: AttemptLimiterOptions) {
    this.now = options.now ?? (() => performance.now())
    this.sweepBudget = options.sweepBudget ?? DEFAULT_SWEEP_BUDGET
  }

  get size(): number {
    return this.buckets.size
  }

  /**
   * Counts one attempt against every key, unless any key is already at its limit (or a new key
   * doesn't fit under `maxKeys`): then nothing is counted or allocated, and the wait is returned.
   */
  tryAcquire(attemptKeys: AttemptKey[]): AcquireResult {
    const now = this.now()
    this.sweep(now)

    const keys = new Map<string, number>()
    for (const k of attemptKeys) {
      if (typeof k === 'string') keys.set(k, this.options.max)
      else keys.set(k.key, k.max)
    }

    let retryAfterMs = 0
    let missing = 0
    for (const [key, max] of keys) {
      const bucket = this.live(key, now)
      if (!bucket) missing += 1
      else if (bucket.count >= max) retryAfterMs = Math.max(retryAfterMs, bucket.resetAt - now)
    }
    if (retryAfterMs > 0) return { allowed: false, retryAfterMs, reason: 'limit' }
    if (missing > 0 && this.buckets.size + missing > this.options.maxKeys) {
      // Full: wait until the oldest bucket expires and frees a slot. (An empty Map here means the
      // attempt needs more keys than maxKeys allows at all: a full window is the honest wait.)
      const oldest = this.buckets.values().next().value as Bucket | undefined
      const retryAfterMs = oldest ? Math.max(1, oldest.resetAt - now) : this.options.windowMs
      return { allowed: false, retryAfterMs, reason: 'capacity' }
    }

    const ticket: { key: string; resetAt: number }[] = []
    for (const key of keys.keys()) {
      let bucket = this.live(key, now)
      if (!bucket) {
        // Always appended at the back, which keeps the Map in resetAt order.
        bucket = { count: 0, resetAt: now + this.options.windowMs }
        this.buckets.set(key, bucket)
      }
      bucket.count += 1
      ticket.push({ key, resetAt: bucket.resetAt })
    }
    return { allowed: true, ticket }
  }

  /**
   * Gives back the attempt `ticket` counted. A bucket whose window ended in between (it now
   * belongs to a later window, or is gone) is left alone: the attempt was never counted there.
   * A bucket back at zero is deleted: it no longer limits anything.
   */
  release(ticket: AttemptTicket): void {
    for (const { key, resetAt } of ticket) {
      const bucket = this.buckets.get(key)
      if (!bucket || bucket.resetAt !== resetAt || bucket.count === 0) continue
      bucket.count -= 1
      if (bucket.count === 0) this.buckets.delete(key)
    }
  }

  /** The key's bucket if it's in its window; an expired one is dropped (re-inserted at the back on reuse). */
  private live(key: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(key)
    if (bucket && bucket.resetAt <= now) {
      this.buckets.delete(key)
      return undefined
    }
    return bucket
  }

  /** Drops up to `sweepBudget` expired buckets from the front; stops at the first live one. */
  private sweep(now: number): void {
    let deleted = 0
    for (const [key, bucket] of this.buckets) {
      this.sweepVisits += 1
      if (bucket.resetAt > now || deleted >= this.sweepBudget) return
      this.buckets.delete(key)
      deleted += 1
    }
  }
}
