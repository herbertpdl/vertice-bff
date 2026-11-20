import { beforeEach, describe, expect, it, vi } from 'vitest'
import { status } from '@grpc/grpc-js'
import type { FastifyBaseLogger } from 'fastify'
import { grpcCall, mapGrpcError } from '../../grpc/call.js'
import { requestContext } from '../../lib/request-context.js'
import { bearer, fakeGrpcCall, ids } from '../../test/fakeUpstream.js'
import { createClient } from './service.js'

// Keep the real mapGrpcError: the fake upstream raises its errors through it.
vi.mock('../../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

/** feature-flags spec FF12: how `createClient` logs a setup link it could not issue. */
describe('createClient setup-link logging', () => {
  const log = { info: vi.fn(), warn: vi.fn() }
  const token = bearer('trainerA').authorization.replace(/^Bearer /, '')
  const createWithSetupError = (code: status) => {
    grpcCallMock.mockImplementation(async (client, method, request, options) => {
      if (method === 'CreatePasswordSetupToken') throw mapGrpcError({ code, details: '' })
      return fakeGrpcCall(client, method, request, options)
    })
    return requestContext.run({ bearerToken: token }, () =>
      createClient(ids.trainerA, { name: 'Novo', email: 'novo@vertice.test' }, log as unknown as FastifyBaseLogger),
    )
  }

  beforeEach(() => {
    grpcCallMock.mockReset()
    log.info.mockReset()
    log.warn.mockReset()
  })

  it('logs a ForbiddenError (first-access e-mail on for this trainer) at INFO, with setup null', async () => {
    const created = await createWithSetupError(status.PERMISSION_DENIED)
    expect(created.setup).toBeNull()
    expect(log.info).toHaveBeenCalledWith(
      { clientId: created.id },
      'Client created; no setup link: first-access e-mail is on for this trainer',
    )
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('logs any other failure at WARN, with setup null', async () => {
    const created = await createWithSetupError(status.UNAVAILABLE)
    expect(created.setup).toBeNull()
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: created.id }),
      'Client created, but issuing the password setup token failed',
    )
    expect(log.info).not.toHaveBeenCalled()
  })
})
