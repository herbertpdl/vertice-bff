import type { FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import { AttemptLimiter } from '../lib/attempt-limiter.js'
import { TooManyRequestsError } from '../lib/errors.js'

export interface RateLimitSettings {
  /** Loose per-IP bucket over every route (`@fastify/rate-limit`, counts every request). */
  globalMax: number
  globalWindowMs: number
  /** Strict buckets on the auth routes: the attempt after `authMax` within the window is a 429. */
  authMax: number
  authWindowMs: number
}

export interface AttemptLimitOptions {
  /** Bucket keys for this request, e.g. `ip:…`, `email:…`. Undefined entries are skipped. */
  keys: (req: FastifyRequest) => (string | undefined)[]
  /**
   * `failures` (default): a response below 400 refunds the attempt, so only failed attempts
   * count. `all`: every attempt counts (register, where a success is what an abuser repeats).
   * A 5xx is always refunded: an upstream outage must not lock anyone out.
   */
  count?: 'failures' | 'all'
}

export interface AttemptLimitHooks {
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  onResponse: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Route hooks for a strict auth bucket named `name` (buckets are separate per name). */
    attemptLimit: (name: string, options: AttemptLimitOptions) => AttemptLimitHooks
  }
}

/** The request's email, normalized the way vertice-api stores it, for a per-email bucket. */
export function emailKey(req: FastifyRequest): string | undefined {
  const email = (req.body as { email?: unknown } | undefined)?.email
  return typeof email === 'string' && email.trim() ? `email:${email.trim().toLowerCase()}` : undefined
}

export const ipKey = (req: FastifyRequest) => `ip:${req.ip}`

export default fp<{ settings: RateLimitSettings }>(async function rateLimitPlugin(app, { settings }) {
  await app.register(rateLimit, {
    global: true,
    max: settings.globalMax,
    timeWindow: settings.globalWindowMs,
    errorResponseBuilder: () => new TooManyRequestsError('Too many requests, try again later'),
  })

  const limiter = new AttemptLimiter({ max: settings.authMax, windowMs: settings.authWindowMs })

  app.decorate('attemptLimit', (name: string, options: AttemptLimitOptions): AttemptLimitHooks => {
    const acquired = new WeakMap<FastifyRequest, string[]>()
    const countAll = options.count === 'all'
    return {
      async preHandler(req, reply) {
        const keys = options.keys(req).filter((key): key is string => Boolean(key)).map((key) => `${name}:${key}`)
        const result = limiter.tryAcquire(keys)
        if (!result.allowed) {
          reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000))
          throw new TooManyRequestsError()
        }
        acquired.set(req, keys)
      },
      async onResponse(req, reply) {
        const keys = acquired.get(req)
        if (!keys) return
        const status = reply.statusCode
        if (status >= 500 || (!countAll && status < 400)) limiter.release(keys)
      },
    }
  })
})
