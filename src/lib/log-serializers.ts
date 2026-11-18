import type { FastifyRequest } from 'fastify'

/**
 * Fastify's request log line ("incoming request") without the query string. A query can carry
 * personal data (the admin directory's `q` is a name or an e-mail, admin-panel spec B15), and the
 * request line is written at INFO for every request, so no query value ever reaches the logs: the
 * path is kept, everything from `?` on is dropped. Otherwise the same fields as Fastify's default.
 */
export function requestSerializer(req: FastifyRequest) {
  return {
    method: req.method,
    url: stripQuery(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  }
}

export const stripQuery = (url: string) => {
  const index = url.indexOf('?')
  return index === -1 ? url : url.slice(0, index)
}

/** The serializers of the BFF's logger, in production and in tests that capture log lines. */
export const LOG_SERIALIZERS = { req: requestSerializer }
