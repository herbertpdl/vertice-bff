import type { FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js'
import { verifyToken, type AuthUser, type Role } from '../lib/jwt.js'

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser
  }
}

export default fp(async function authenticatePlugin(app) {
  app.decorateRequest('user', undefined)

  app.decorate('authenticate', async (request: FastifyRequest) => {
    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing bearer token')
    }
    try {
      request.user = verifyToken(header.slice('Bearer '.length))
    } catch {
      throw new UnauthorizedError('Invalid or expired token')
    }
  })

  app.decorate('requireRole', (...roles: Role[]) => {
    return async (request: FastifyRequest, _reply: FastifyReply) => {
      if (!request.user) throw new UnauthorizedError()
      if (!roles.includes(request.user.role)) {
        throw new ForbiddenError(`Requires role: ${roles.join(' or ')}`)
      }
    }
  })
})

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>
    requireRole: (...roles: Role[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}
