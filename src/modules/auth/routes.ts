import type { FastifyInstance } from 'fastify'
import { loginSchema, registerSchema } from './schemas.js'
import * as authService from './service.js'
import * as userService from '../users/service.js'

export default async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (req) => {
    const body = loginSchema.parse(req.body)
    return authService.login(body.email, body.password)
  })

  app.post('/register', async (req, reply) => {
    const body = registerSchema.parse(req.body)
    reply.status(201)
    return authService.register(body)
  })

  app.get('/me', { preHandler: app.authenticate }, async (req) => {
    return userService.getUser(req.user!.id)
  })
}
