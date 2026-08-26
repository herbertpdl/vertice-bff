import type { FastifyInstance } from 'fastify'
import { parseId } from '../../lib/net.js'
import { studentCreateSchema, studentUpdateSchema } from './schemas.js'
import * as studentService from './service.js'
import * as userService from '../users/service.js'

export default async function studentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole('TRAINER', 'ADMIN'))

  app.get('/', async (req) => studentService.listStudentsOverviewForTrainer(req.user!.id))

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const id = parseId(req.params.id)
    await studentService.assertIsTrainersClient(req.user!.id, id)
    return userService.getUser(id)
  })

  app.get<{ Params: { id: string } }>('/:id/overview', async (req) => {
    const id = parseId(req.params.id)
    await studentService.assertIsTrainersClient(req.user!.id, id)
    return studentService.getStudentOverview(req.user!.id, id)
  })

  app.post('/', async (req, reply) => {
    const body = studentCreateSchema.parse(req.body)
    reply.status(201)
    return studentService.createStudent(body)
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const id = parseId(req.params.id)
    await studentService.assertIsTrainersClient(req.user!.id, id)
    const body = studentUpdateSchema.parse(req.body)
    return userService.updateUser(id, { ...body, role: 'CLIENT' })
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = parseId(req.params.id)
    await studentService.assertIsTrainersClient(req.user!.id, id)
    await userService.deleteUser(id)
    reply.status(204)
  })
}
