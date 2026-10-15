import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseId } from '../../lib/net.js'
import { clientCreateSchema, clientDetailQuerySchema, clientUpdateSchema } from './schemas.js'
import * as clientService from './service.js'
import * as userService from '../users/service.js'
import { idParams, routeDoc } from '../../openapi/docs.js'
import {
  clientDetailSchema,
  clientOverviewSchema,
  clientSummarySchema,
  createdClientSchema,
  passwordSetupTokenSchema,
} from '../../openapi/responses.js'

export default async function clientRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  // TRAINER only: every route here is scoped to "one of *your* clients", which an ADMIN has
  // none of. ADMIN has no defined product yet (P1-02); it gets a 403 until a PRD defines it.
  app.addHook('preHandler', app.requireRole('TRAINER'))

  app.get(
    '/',
    {
      schema: routeDoc({
        operationId: 'listClients',
        summary: 'The trainer’s roster',
        description:
          'No email, CPF, CREF or role: the detail routes carry the email. `lastWorkoutAt` and `weekActivity` ' +
          'only reflect the current week.',
        tag: 'Clients',
        roles: ['TRAINER'],
        ok: { status: 200, description: 'One entry per active client.', schema: z.array(clientSummarySchema) },
        errors: [403],
      }),
    },
    async (req) => clientService.listClientsOverviewForTrainer(req.user!.id),
  )

  // CPF masked unless `?reveal=cpf`. The reveal has no extra gate beyond the route's (TRAINER, one
  // of your clients), but every one is logged: who saw whose CPF, never the value.
  app.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: routeDoc({
        operationId: 'getClient',
        summary: 'A client’s details',
        description:
          'One of your clients. The CPF is masked unless `reveal=cpf`; every reveal is logged ' +
          '(who saw whose CPF, never the value). Any other query is a 400.',
        tag: 'Clients',
        roles: ['TRAINER'],
        params: idParams('id'),
        query: clientDetailQuerySchema,
        ok: { status: 200, description: 'The client.', schema: clientDetailSchema },
        errors: [400, 403, 404],
      }),
    },
    async (req) => {
      const id = parseId(req.params.id)
      const { reveal } = clientDetailQuerySchema.parse(req.query)
      await clientService.assertIsTrainersClient(req.user!.id, id)
      const client = clientService.toClientDetail(await userService.getUser(id), { revealCpf: reveal === 'cpf' })
      if (reveal === 'cpf') {
        req.log.info({ audit: 'client.cpf.reveal', actorId: req.user!.id, clientId: id }, 'Client CPF revealed')
      }
      return client
    },
  )

  app.get<{ Params: { id: string } }>(
    '/:id/overview',
    {
      schema: routeDoc({
        operationId: 'getClientOverview',
        summary: 'The header of a client’s detail screen',
        description:
          'One of your clients. `adherence4Weeks` is an approximation over the last 4 weeks (vertice-api has no ' +
          'general history query).',
        tag: 'Clients',
        roles: ['TRAINER'],
        params: idParams('id'),
        ok: { status: 200, description: 'Active plan, this week’s progress, last workout and adherence.', schema: clientOverviewSchema },
        errors: [403, 404],
      }),
    },
    async (req) => {
      const id = parseId(req.params.id)
      await clientService.assertIsTrainersClient(req.user!.id, id)
      return clientService.getClientOverview(req.user!.id, id)
    },
  )

  app.post(
    '/',
    {
      schema: routeDoc({
        operationId: 'createClient',
        summary: 'Create a client',
        description:
          'Creates a CLIENT without a password, linked to the trainer, and issues a first-access token ' +
          '(`setup`) the trainer shares; the client redeems it at `POST /auth/password/setup`. `cpf` is optional. ' +
          'A taken email or CPF is 409 `CONFLICT`.',
        tag: 'Clients',
        roles: ['TRAINER'],
        body: clientCreateSchema,
        ok: { status: 201, description: 'The client, with the setup token.', schema: createdClientSchema },
        errors: [400, 403, 409],
      }),
    },
    async (req, reply) => {
      const body = clientCreateSchema.parse(req.body)
      reply.status(201)
      return clientService.createClient(req.user!.id, body, req.log)
    },
  )

  app.post<{ Params: { id: string } }>(
    '/:id/setup-token',
    {
      schema: routeDoc({
        operationId: 'reissueClientSetupToken',
        summary: 'Re-issue a client’s first-access link',
        description:
          'One of your clients. The previous token stops working. Only while the client has no password yet: ' +
          'afterwards it is 409 `PRECONDITION_FAILED`.',
        tag: 'Clients',
        roles: ['TRAINER'],
        params: idParams('id'),
        ok: { status: 201, description: 'The new token.', schema: passwordSetupTokenSchema },
        errors: [403, 404, 409],
      }),
    },
    async (req, reply) => {
      const id = parseId(req.params.id)
      await clientService.assertIsTrainersClient(req.user!.id, id)
      reply.status(201)
      return clientService.reissueSetupToken(id)
    },
  )

  app.patch<{ Params: { id: string } }>(
    '/:id',
    {
      schema: routeDoc({
        operationId: 'updateClient',
        summary: 'Update a client',
        description:
          'One of your clients. `name` and `email` are required. `cpf`: omitted keeps the stored CPF, a string ' +
          'sets it (`""` removes it), `null` removes it; a masked value is a 400. A taken email or CPF is 409 `CONFLICT`.',
        tag: 'Clients',
        roles: ['TRAINER'],
        params: idParams('id'),
        body: clientUpdateSchema,
        ok: { status: 200, description: 'The updated client (CPF masked).', schema: clientDetailSchema },
        errors: [400, 403, 404, 409],
      }),
    },
    async (req) => {
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
    },
  )

  // Ends the trainer's relationship with the client ("Encerrar acompanhamento"), nothing more: the
  // client's account, their plans and their logs stay (PRIV-BFF-003). Deleting an account is the
  // user's own data-subject action (`DELETE /auth/me`), never the trainer's.
  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: routeDoc({
        operationId: 'endClientRelationship',
        summary: 'End the relationship with a client',
        description:
          '“Encerrar acompanhamento”: the client leaves the roster and the trainer loses what the link grants. ' +
          'It does not delete the client’s account; their plans and logs stay.',
        tag: 'Clients',
        roles: ['TRAINER'],
        params: idParams('id'),
        ok: { status: 204, description: 'Ended; no body.' },
        errors: [403, 404],
      }),
    },
    async (req, reply) => {
      const id = parseId(req.params.id)
      await clientService.assertIsTrainersClient(req.user!.id, id)
      await clientService.endRelationship(req.user!.id, id)
      reply.status(204)
    },
  )
}
