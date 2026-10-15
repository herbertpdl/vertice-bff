import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import helmet from '@fastify/helmet'

/**
 * Security headers for a JSON API (SEC-BFF-011). The BFF serves no HTML, so there is no document
 * CSP to tune: the policy only forbids everything (`default-src 'none'`) and framing
 * (`frame-ancestors 'none'`), in case a response is ever rendered. The rest is helmet's default
 * (`X-Content-Type-Options: nosniff`, HSTS, `Referrer-Policy: no-referrer`, ...), with
 * `X-Frame-Options: DENY` for browsers without `frame-ancestors`.
 *
 * Every `/api/*` response, errors included, is `Cache-Control: no-store`: they carry personal and
 * training data, which no browser, proxy or CDN may keep. A route that serves the same public,
 * personal-data-free answer to everyone may opt out with `config: { cacheControl: '...' }`
 * (`GET /api/legal/versions`); its error responses stay `no-store`.
 */
export default fp(async function securityHeaders(app: FastifyInstance) {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    xFrameOptions: { action: 'deny' },
  })

  app.addHook('onSend', async (request, reply, payload) => {
    if (!isApiPath(request.url)) return payload
    const cacheControl = request.routeOptions.config.cacheControl
    reply.header('Cache-Control', cacheControl && reply.statusCode < 400 ? cacheControl : 'no-store')
    return payload
  })
})

const isApiPath = (url: string) => url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')

declare module 'fastify' {
  interface FastifyContextConfig {
    /** `Cache-Control` for this route's successful responses instead of `no-store`. Public data only. */
    cacheControl?: string
  }
}
