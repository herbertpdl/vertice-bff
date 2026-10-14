/**
 * In-memory fixed-window counter for the strict auth buckets (login, register, password
 * setup/change). Unlike `@fastify/rate-limit`, which counts every request, an attempt here can be
 * refunded once its outcome is known, so a bucket can count failures only.
 *
 * The attempt is counted up front and refunded afterwards (rather than counted after it fails)
 * so a burst of concurrent guesses can't all pass the check before the first failure lands.
 *
 * State lives in this process: with several BFF instances each keeps its own counts (a shared
 * store such as Redis is the follow-up for that).
 */
export interface AttemptLimiterOptions {
  /** Attempts allowed per key per window; the next one is refused. */
  max: number
  windowMs: number
  now?: () => number
}

export type AcquireResult = { allowed: true } | { allowed: false; retryAfterMs: number }

interface Bucket {
  count: number
  resetAt: number
}

/** Expired buckets are swept once the map grows past this, so unique keys can't grow it forever. */
const SWEEP_THRESHOLD = 10_000

export class AttemptLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly now: () => number

  constructor(private readonly options: AttemptLimiterOptions) {
    this.now = options.now ?? Date.now
  }

  /**
   * Counts one attempt against every key, unless any key is already at the limit: then nothing
   * is counted and the wait until the longest-blocked key frees up is returned.
   */
  tryAcquire(keys: string[]): AcquireResult {
    const now = this.now()
    if (this.buckets.size > SWEEP_THRESHOLD) this.sweep(now)

    let retryAfterMs = 0
    for (const key of keys) {
      const bucket = this.live(key, now)
      if (bucket && bucket.count >= this.options.max) {
        retryAfterMs = Math.max(retryAfterMs, bucket.resetAt - now)
      }
    }
    if (retryAfterMs > 0) return { allowed: false, retryAfterMs }

    for (const key of keys) {
      const bucket = this.live(key, now)
      if (bucket) bucket.count += 1
      else this.buckets.set(key, { count: 1, resetAt: now + this.options.windowMs })
    }
    return { allowed: true }
  }

  /** Gives back one attempt per key (the attempt turned out not to count). */
  release(keys: string[]): void {
    const now = this.now()
    for (const key of keys) {
      const bucket = this.live(key, now)
      if (bucket && bucket.count > 0) bucket.count -= 1
    }
  }

  private live(key: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(key)
    if (bucket && bucket.resetAt <= now) {
      this.buckets.delete(key)
      return undefined
    }
    return bucket
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }
}
