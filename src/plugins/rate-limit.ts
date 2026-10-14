import type { FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import { AttemptLimiter, type AttemptTicket } from '../lib/attempt-limiter.js'
import { clientIpKey } from '../lib/client-ip.js'
import { TooManyRequestsError } from '../lib/errors.js'

export interface RateLimitSettings {
  /** Loose per-IP bucket over every route (`@fastify/rate-limit`, counts every request). */
  globalMax: number
  globalWindowMs: number
  /** Strict buckets on the auth routes: the attempt after `authMax` within the window is a 429. */
  authMax: number
  authWindowMs: number
  /** Most strict-bucket keys held at once; when full, attempts needing a new key are refused (429). */
  authMaxKeys: number
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

/**
 * The client's address (IPv6 cut to its /64). `req.ip` is the real client only when
 * `TRUST_PROXY` names the peer that forwards it (vertice-web-react's server, a reverse proxy).
 */
export const ipKey = (req: FastifyRequest) => `ip:${clientIpKey(req.ip)}`

/** At most one "limiter full" warning per this many ms, so an attack doesn't flood the logs. */
const CAPACITY_WARNING_INTERVAL_MS = 60_000

export default fp<{ settings: RateLimitSettings }>(async function rateLimitPlugin(app, { settings }) {
  await app.register(rateLimit, {
    global: true,
    max: settings.globalMax,
    timeWindow: settings.globalWindowMs,
    keyGenerator: (req) => clientIpKey(req.ip),
    errorResponseBuilder: () => new TooManyRequestsError('Too many requests, try again later'),
  })

  const limiter = new AttemptLimiter({
    max: settings.authMax,
    windowMs: settings.authWindowMs,
    maxKeys: settings.authMaxKeys,
  })
  let lastCapacityWarningAt = -Infinity

  app.decorate('attemptLimit', (name: string, options: AttemptLimitOptions): AttemptLimitHooks => {
    const acquired = new WeakMap<FastifyRequest, AttemptTicket>()
    const countAll = options.count === 'all'
    return {
      async preHandler(req, reply) {
        const keys = options.keys(req).filter((key): key is string => Boolean(key)).map((key) => `${name}:${key}`)
        const result = limiter.tryAcquire(keys)
        if (!result.allowed) {
          if (result.reason === 'capacity' && Date.now() - lastCapacityWarningAt > CAPACITY_WARNING_INTERVAL_MS) {
            lastCapacityWarningAt = Date.now()
            req.log.warn({ maxKeys: settings.authMaxKeys }, 'Auth rate limiter is full; refusing new clients until buckets expire')
          }
          reply.header('retry-after', Math.ceil(result.retryAfterMs / 1000))
          throw new TooManyRequestsError()
        }
        acquired.set(req, result.ticket)
      },
      async onResponse(req, reply) {
        const ticket = acquired.get(req)
        if (!ticket) return
        const status = reply.statusCode
        if (status >= 500 || (!countAll && status < 400)) limiter.release(ticket)
      },
    }
  })
})
