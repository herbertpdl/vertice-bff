import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import { AttemptLimiter, type AttemptKey, type AttemptTicket } from '../lib/attempt-limiter.js'
import { clientIpKey, clientNetworkKey } from '../lib/client-ip.js'
import { TooManyRequestsError } from '../lib/errors.js'

export interface RateLimitSettings {
  /** Loose per-IP bucket over every route (`@fastify/rate-limit`, counts every request). */
  globalMax: number
  globalWindowMs: number
  /** Strict buckets on the auth routes: the attempt after `authMax` within the window is a 429. */
  authMax: number
  authWindowMs: number
  /**
   * Strict-bucket limit per client network (IPv6 /48, IPv4 /24), checked before any per-IP or
   * per-email bucket is allocated, so one network can only mint a bounded number of keys.
   */
  authNetworkMax: number
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

/** RFC 5321's limit on a forward path; anything longer can't be an address anyone logs in with. */
const MAX_EMAIL_LENGTH = 254
const emailShape = z.string().max(MAX_EMAIL_LENGTH).email()

/**
 * The per-email bucket key. This runs before the route's Zod validation, so the body is raw:
 * the email is trimmed and lower-cased (the way vertice-api stores it), anything that isn't a
 * plausible address gets no email key at all (the IP and network buckets still apply), and the
 * key is a SHA-256 of the address, so it has a fixed size and keeps no raw email in memory.
 */
export function emailKey(req: FastifyRequest): string | undefined {
  const email = (req.body as { email?: unknown } | undefined)?.email
  if (typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH * 2) return undefined
  const normalized = email.trim().toLowerCase()
  if (!emailShape.safeParse(normalized).success) return undefined
  return `email:${createHash('sha256').update(normalized).digest('hex')}`
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
        const keys: AttemptKey[] = [
          // Checked with the rest before anything is allocated: one network mints a bounded number of keys.
          { key: `${name}:net:${clientNetworkKey(req.ip)}`, max: settings.authNetworkMax },
          ...options
            .keys(req)
            .filter((key): key is string => Boolean(key))
            .map((key) => `${name}:${key}`),
        ]
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
