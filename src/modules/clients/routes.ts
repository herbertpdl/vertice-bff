import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { clientCreateSchema, clientUpdateSchema } from './schemas.js'
import * as clientService from './service.js'
import * as userService from '../users/service.js'

export default async function clientRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'ADMIN'))

  app.get('/', async (req) => clientService.listClientsOverviewForTrainer(req.user!.id))

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const id = parseId(req.params.id)
    await clientService.assertIsTrainersClient(req.user!.id, id)
    return userService.getUser(id)
  })

  app.get<{ Params: { id: string } }>('/:id/overview', async (req) => {
    const id = parseId(req.params.id)
    await clientService.assertIsTrainersClient(req.user!.id, id)
    return clientService.getClientOverview(req.user!.id, id)
  })

  app.post('/', async (req, reply) => {
    const body = clientCreateSchema.parse(req.body)
    reply.status(201)
    return clientService.createClient(req.user!.id, body, req.log)
  })

  // TRAINER only: the ownership check is "one of *your* clients", which ADMIN has none of.
  app.post<{ Params: { id: string } }>(
    '/:id/setup-token',
    { preHandler: app.requireRole('TRAINER') },
    async (req, reply) => {
      const id = parseId(req.params.id)
      await clientService.assertIsTrainersClient(req.user!.id, id)
      reply.status(201)
      return clientService.reissueSetupToken(id)
    },
  )

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const id = parseId(req.params.id)
    await clientService.assertIsTrainersClient(req.user!.id, id)
    const body = clientUpdateSchema.parse(req.body)
    return userService.updateUser(id, { ...body, role: 'CLIENT' })
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = parseId(req.params.id)
    await clientService.assertIsTrainersClient(req.user!.id, id)
    await userService.deleteUser(id)
    reply.status(204)
  })
}
