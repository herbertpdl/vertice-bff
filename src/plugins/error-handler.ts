import type { FastifyInstance, FastifyError } from 'fastify'
import fp from 'fastify-plugin'
import { ZodError } from 'zod'
import { HttpError } from '../lib/errors.js'

export default fp(async function errorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      })
      return
    }

    if (error instanceof ZodError) {
      reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: error.flatten() },
      })
      return
    }

    if (error.validation) {
      reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: error.message, details: error.validation },
      })
      return
    }

    request.log.error({ err: error }, 'Unhandled error')
    reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    })
  })

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    })
  })
})
