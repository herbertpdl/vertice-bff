/**
 * In-memory fixed-window counter for the strict auth buckets (login, register, password
 * setup/change). Unlike `@fastify/rate-limit`, which counts every request, an attempt here can be
 * refunded once its outcome is known, so a bucket can count failures only.
 *
 * The attempt is counted up front and refunded afterwards (rather than counted after it fails)
 * so a burst of concurrent guesses can't all pass the check before the first failure lands.
 *
 * Memory is bounded two ways:
 * - **Incremental sweep.** Every bucket has the same `windowMs` and a bucket is only ever
 *   (re)inserted at the back of the Map, so insertion order is `resetAt` order. Each call drops
 *   expired buckets from the front and stops at the first live one: amortized O(1), since each
 *   bucket is removed once, and a single visit when nothing has expired.
 * - **Hard cap (`maxKeys`), fail closed.** When the Map is full, an attempt that needs a new
 *   bucket is refused (429) until the oldest bucket expires. Evicting live buckets instead would
 *   let an attacker flush a victim's counter by spraying new keys, which is the attack these
 *   buckets exist to stop. Keys already tracked keep working while the Map is full.
 *
 * State lives in this process: with several BFF instances each keeps its own counts (a shared
 * store such as Redis is the follow-up for that).
 */
export interface AttemptLimiterOptions {
  /** Attempts allowed per key per window; the next one is refused. */
  max: number
  windowMs: number
  /** Most buckets held at once; beyond it, new keys are refused. */
  maxKeys: number
  now?: () => number
}

/** What `release` needs to refund exactly the buckets this attempt was counted in. */
export type AttemptTicket = readonly { key: string; resetAt: number }[]

export type AcquireResult =
  | { allowed: true; ticket: AttemptTicket }
  | { allowed: false; retryAfterMs: number; reason: 'limit' | 'capacity' }

interface Bucket {
  count: number
  resetAt: number
}

export class AttemptLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly now: () => number
  /** Map entries the sweep has looked at, ever. Exposed so tests can check the sweep stays cheap. */
  sweepVisits = 0

  constructor(private readonly options: AttemptLimiterOptions) {
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.buckets.size
  }

  /**
   * Counts one attempt against every key, unless any key is already at the limit (or a new key
   * doesn't fit under `maxKeys`): then nothing is counted and the wait is returned.
   */
  tryAcquire(keys: string[]): AcquireResult {
    const now = this.now()
    this.sweep(now)

    let retryAfterMs = 0
    let missing = 0
    for (const key of new Set(keys)) {
      const bucket = this.buckets.get(key)
      if (!bucket) missing += 1
      else if (bucket.count >= this.options.max) retryAfterMs = Math.max(retryAfterMs, bucket.resetAt - now)
    }
    if (retryAfterMs > 0) return { allowed: false, retryAfterMs, reason: 'limit' }
    if (missing > 0 && this.buckets.size + missing > this.options.maxKeys) {
      // Full: wait until the oldest bucket expires and frees a slot.
      const oldest = this.buckets.values().next().value as Bucket
      return { allowed: false, retryAfterMs: Math.max(1, oldest.resetAt - now), reason: 'capacity' }
    }

    const ticket: { key: string; resetAt: number }[] = []
    for (const key of new Set(keys)) {
      let bucket = this.buckets.get(key)
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
   */
  release(ticket: AttemptTicket): void {
    for (const { key, resetAt } of ticket) {
      const bucket = this.buckets.get(key)
      if (bucket && bucket.resetAt === resetAt && bucket.count > 0) bucket.count -= 1
    }
  }

  /** Drops expired buckets from the front; stops at the first live one. */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      this.sweepVisits += 1
      if (bucket.resetAt > now) return
      this.buckets.delete(key)
    }
  }
}
