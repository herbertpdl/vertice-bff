import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { clientCreateSchema, clientDetailQuerySchema, clientUpdateSchema } from './schemas.js'
import * as clientService from './service.js'
import * as userService from '../users/service.js'

export default async function clientRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  // TRAINER only: every route here is scoped to "one of *your* clients", which an ADMIN has
  // none of. ADMIN has no defined product yet (P1-02); it gets a 403 until a PRD defines it.
  app.addHook('preHandler', app.requireRole('TRAINER'))

  app.get('/', async (req) => clientService.listClientsOverviewForTrainer(req.user!.id))

  // CPF masked unless `?reveal=cpf`. The reveal has no extra gate beyond the route's (TRAINER, one
  // of your clients), but every one is logged: who saw whose CPF, never the value.
  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const id = parseId(req.params.id)
    const { reveal } = clientDetailQuerySchema.parse(req.query)
    await clientService.assertIsTrainersClient(req.user!.id, id)
    const client = clientService.toClientDetail(await userService.getUser(id), { revealCpf: reveal === 'cpf' })
    if (reveal === 'cpf') {
      req.log.info({ audit: 'client.cpf.reveal', actorId: req.user!.id, clientId: id }, 'Client CPF revealed')
    }
    return client
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

  app.post<{ Params: { id: string } }>('/:id/setup-token', async (req, reply) => {
    const id = parseId(req.params.id)
    await clientService.assertIsTrainersClient(req.user!.id, id)
    reply.status(201)
    return clientService.reissueSetupToken(id)
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const id = parseId(req.params.id)
    await clientService.assertIsTrainersClient(req.user!.id, id)
    const body = clientUpdateSchema.parse(req.body)
    // UpdateUser replaces every field and '' removes the CPF, so an omitted `cpf` must send the
    // stored one back (the active trainer gets the detail view, CPF in full). Only an explicit
    // `null` removes it; a CPF is optional for a CLIENT (vertice-api #65).
    const cpf = body.cpf === undefined ? (await userService.getUser(id)).cpf : (body.cpf ?? '')
    return clientService.toClientDetail(
      await userService.updateUser(id, { name: body.name, email: body.email, cpf, role: 'CLIENT' }),
    )
  })

  // Ends the trainer's relationship with the client ("Encerrar acompanhamento"), nothing more: the
  // client's account, their plans and their logs stay (PRIV-BFF-003). Deleting an account is the
  // user's own data-subject action (`DELETE /auth/me`), never the trainer's.
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = parseId(req.params.id)
    await clientService.assertIsTrainersClient(req.user!.id, id)
    await clientService.endRelationship(req.user!.id, id)
    reply.status(204)
  })
}
