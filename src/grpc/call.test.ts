import { afterEach, describe, expect, it, vi } from 'vitest'
import * as grpc from '@grpc/grpc-js'
import {
  grpcCall,
  mapGrpcError,
  MissingCallerIdentityError,
  redactUpstreamText,
  SERVICE_TOKEN_RPCS,
  UPSTREAM_MESSAGES,
  type GrpcCallOptions,
} from './call.js'
import { env } from '../config/env.js'
import { ForbiddenError, HttpError, NotFoundError, PreconditionFailedError, ValidationError } from '../lib/errors.js'
import { serviceToken } from '../lib/jwt.js'
import { requestContext } from '../lib/request-context.js'

/** A stand-in grpc-js client exposing `method`, recording the metadata of its last call. */
function stubClient(method: string) {
  const stub: { seen?: grpc.Metadata } & Record<string, unknown> = {}
  stub[method] = (_request: unknown, metadata: grpc.Metadata, cb: (err: null, res: object) => void) => {
    stub.seen = metadata
    cb(null, {})
  }
  return stub
}

describe('grpcCall', () => {
  const callRpc = (method: string, options?: GrpcCallOptions) => {
    const stub = stubClient(method)
    return { stub, call: grpcCall(stub as unknown as grpc.Client, method, {}, options) }
  }
  const ping = (options?: GrpcCallOptions) => callRpc('Ping', options)

  it('attaches "authorization: Bearer <token>" when the request context holds a verified token', async () => {
    const { stub, call } = requestContext.run({ bearerToken: 'abc' }, () => ping())
    await call
    expect(stub.seen!.get('authorization')).toEqual(['Bearer abc'])
  })

  it("prefers the user's token even where the service token is allowed (password change)", async () => {
    const { stub, call } = requestContext.run({ bearerToken: 'abc' }, () =>
      callRpc('VerifyCredentials', { asService: true }),
    )
    await call
    expect(stub.seen!.get('authorization')).toEqual(['Bearer abc'])
  })

  it('fails closed, without calling upstream, when there is no user and no explicit opt-in', async () => {
    const outside = ping()
    await expect(outside.call).rejects.toThrow(MissingCallerIdentityError)
    expect(outside.stub.seen).toBeUndefined()

    const inAnonymousRequest = requestContext.run({}, () => callRpc('VerifyCredentials'))
    await expect(inAnonymousRequest.call).rejects.toThrow(/no verified user token and no explicit service opt-in/)
    expect(inAnonymousRequest.stub.seen).toBeUndefined()
  })

  it.each(['VerifyCredentials', 'CreateUser', 'SetPasswordWithToken'])(
    'sends the service token on %s with asService and no user',
    async (method) => {
      const { stub, call } = requestContext.run({}, () => callRpc(method, { asService: true }))
      await call
      expect(stub.seen!.get('authorization')).toEqual([`Bearer ${serviceToken()}`])
    },
  )

  it('refuses asService on any other RPC', async () => {
    for (const method of ['ListUsers', 'CreatePasswordSetupToken', 'GetUser', 'Ping']) {
      const { stub, call } = callRpc(method, { asService: true })
      await expect(call, method).rejects.toThrow(/service token is not allowed on this RPC/)
      expect(stub.seen).toBeUndefined()
    }
  })

  it('allows the service token on exactly the three public auth RPCs', () => {
    expect([...SERVICE_TOKEN_RPCS].sort()).toEqual(['CreateUser', 'SetPasswordWithToken', 'VerifyCredentials'])
  })

  describe('anonymous', () => {
    const { VERIFY_PASSWORDS, NODE_ENV } = env
    afterEach(() => {
      env.VERIFY_PASSWORDS = VERIFY_PASSWORDS
      env.NODE_ENV = NODE_ENV
    })

    it.each(['', 'development', 'test'])(
      'sends no authorization with the opt-in, VERIFY_PASSWORDS=false and NODE_ENV=%j',
      async (nodeEnv) => {
        env.VERIFY_PASSWORDS = false
        env.NODE_ENV = nodeEnv
        const { stub, call } = ping({ anonymous: true })
        await call
        expect(stub.seen!.get('authorization')).toEqual([])
      },
    )

    it('is refused, without calling upstream, while VERIFY_PASSWORDS is true', async () => {
      env.VERIFY_PASSWORDS = true
      env.NODE_ENV = 'development'
      const { stub, call } = ping({ anonymous: true })
      await expect(call).rejects.toThrow(MissingCallerIdentityError)
      await expect(call).rejects.toThrow(/anonymous calls are only allowed/)
      expect(stub.seen).toBeUndefined()
    })

    it.each(['production', 'staging', 'prod'])('is refused with NODE_ENV=%s', async (nodeEnv) => {
      env.VERIFY_PASSWORDS = false
      env.NODE_ENV = nodeEnv
      const { stub, call } = ping({ anonymous: true })
      await expect(call).rejects.toThrow(MissingCallerIdentityError)
      expect(stub.seen).toBeUndefined()
    })

    it('still lets a verified user token win', async () => {
      env.VERIFY_PASSWORDS = true
      const { stub, call } = requestContext.run({ bearerToken: 'abc' }, () => ping({ anonymous: true }))
      await call
      expect(stub.seen!.get('authorization')).toEqual(['Bearer abc'])
    })
  })

  it('keeps caller-supplied metadata, and a caller-supplied authorization as is', async () => {
    const metadata = new grpc.Metadata()
    metadata.set('x-test', '1')
    const withUser = requestContext.run({ bearerToken: 'abc' }, () => ping({ metadata }))
    await withUser.call
    expect(withUser.stub.seen!.get('x-test')).toEqual(['1'])
    expect(withUser.stub.seen!.get('authorization')).toEqual(['Bearer abc'])

    const explicit = new grpc.Metadata()
    explicit.set('authorization', 'Bearer caller-supplied')
    const ops = ping({ metadata: explicit })
    await ops.call
    expect(ops.stub.seen!.get('authorization')).toEqual(['Bearer caller-supplied'])
  })
})

describe('mapGrpcError', () => {
  it('maps FAILED_PRECONDITION to 409 PRECONDITION_FAILED with a fixed message', () => {
    const details = "Cannot replace exercises: exercise 'Supino reto' (id 12) set 2 has recorded workout data"
    const err = mapGrpcError({ code: grpc.status.FAILED_PRECONDITION, details })
    expect(err).toBeInstanceOf(PreconditionFailedError)
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('PRECONDITION_FAILED')
    expect(err.message).toBe(UPSTREAM_MESSAGES.preconditionFailed)
  })

  it('relays the upstream message only for INVALID_ARGUMENT (field errors the forms show)', () => {
    const err = mapGrpcError({
      code: grpc.status.INVALID_ARGUMENT,
      details: 'exercise_id: one or more referenced exercises do not exist',
    })
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toBe('exercise_id: one or more referenced exercises do not exist')
    expect(mapGrpcError({ code: grpc.status.INVALID_ARGUMENT, details: '' }).message).toBe('Invalid request')
  })

  it('maps PERMISSION_DENIED to 403 FORBIDDEN with a fixed message', () => {
    const err = mapGrpcError({ code: grpc.status.PERMISSION_DENIED, details: 'You do not have access to exercise 12' })
    // A ForbiddenError, like the BFF's own refusals, so callers can treat both alike.
    expect(err).toBeInstanceOf(ForbiddenError)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('FORBIDDEN')
    expect(err.message).toBe(UPSTREAM_MESSAGES.permissionDenied)
  })

  it.each(['Session no longer valid', 'Unrecognized caller identity', 'internal detail: user 42 role CLIENT', ''])(
    'maps UNAUTHENTICATED (%j) to 401 UNAUTHENTICATED with a fixed message',
    (details) => {
      const err = mapGrpcError({ code: grpc.status.UNAUTHENTICATED, details })
      expect(err).toBeInstanceOf(HttpError)
      expect(err.statusCode).toBe(401)
      expect(err.code).toBe('UNAUTHENTICATED')
      expect(err.message).toBe('Session no longer valid')
    },
  )

  it('maps NOT_FOUND to 404 with a fixed message (no more "X not found not found")', () => {
    const err = mapGrpcError({ code: grpc.status.NOT_FOUND, details: 'Workout with id 5 not found' })
    expect(err).toBeInstanceOf(NotFoundError)
    expect(err.statusCode).toBe(404)
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toBe('Resource not found')
  })

  it.each(['CPF already in use: 529.982.247-25', 'Email already in use: ana@example.com', 'CPF already in use', ''])(
    'maps ALREADY_EXISTS (%j) to 409 CONFLICT with one fixed message, whichever value is taken',
    (details) => {
      const err = mapGrpcError({ code: grpc.status.ALREADY_EXISTS, details })
      expect(err.statusCode).toBe(409)
      expect(err.code).toBe('CONFLICT')
      expect(err.message).toBe('Email or CPF already in use')
      expect(err.details).toBeUndefined()
    },
  )

  it.each([grpc.status.UNKNOWN, grpc.status.INTERNAL, grpc.status.DATA_LOSS, grpc.status.DEADLINE_EXCEEDED])(
    'never relays upstream text for status %i: 502 "Upstream error"',
    (code) => {
      const err = mapGrpcError({
        code,
        details: 'org.springframework.dao.DataIntegrityViolationException: duplicate key value (cpf)=(52998224725)',
      })
      expect(err.statusCode).toBe(502)
      expect(err.code).toBe('UPSTREAM_ERROR')
      expect(err.message).toBe('Upstream error')
      expect(err.details).toBeUndefined()
    },
  )

  it('maps UNAVAILABLE to 503 with a fixed message', () => {
    const err = mapGrpcError({ code: grpc.status.UNAVAILABLE, details: 'connect ECONNREFUSED 10.0.0.5:9090' })
    expect(err).toMatchObject({ statusCode: 503, code: 'UPSTREAM_UNAVAILABLE', message: 'vertice-api is unavailable' })
  })
})

describe('upstream error logging', () => {
  function failingClient(code: grpc.status, details: string) {
    return {
      Fail: (_request: unknown, _metadata: grpc.Metadata, cb: (err: Partial<grpc.ServiceError>) => void) =>
        cb({ code, details }),
    } as unknown as grpc.Client
  }
  const logger = () => ({ info: vi.fn(), warn: vi.fn() })

  it('logs the RPC, the status and the redacted upstream text on the request logger', async () => {
    const log = logger()
    const details = 'DataIntegrityViolationException: (email, cpf)=(ana@example.com, 529.982.247-25) 52998224725'
    await expect(
      requestContext.run({ bearerToken: 'abc', log: log as never }, () =>
        grpcCall(failingClient(grpc.status.INTERNAL, details), 'Fail', {}),
      ),
    ).rejects.toMatchObject({ statusCode: 502, message: 'Upstream error' })
    expect(log.warn).toHaveBeenCalledWith(
      {
        rpc: 'Fail',
        grpcStatus: 'INTERNAL',
        upstreamMessage: 'DataIntegrityViolationException: (email, cpf)=([email], [number]) [number]',
      },
      'Upstream call failed',
    )
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/ana@|529|52998224725/)
  })

  it('logs refusals a request can cause at info', async () => {
    const log = logger()
    await expect(
      requestContext.run({ bearerToken: 'abc', log: log as never }, () =>
        grpcCall(failingClient(grpc.status.ALREADY_EXISTS, 'CPF already in use'), 'Fail', {}),
      ),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(log.info).toHaveBeenCalledWith(
      { rpc: 'Fail', grpcStatus: 'ALREADY_EXISTS', upstreamMessage: 'CPF already in use' },
      'Upstream refused the call',
    )
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('redacts emails and CPFs, with or without punctuation', () => {
    expect(redactUpstreamText('Email already in use: Ana.Silva+x@example.com.br')).toBe('Email already in use: [email]')
    expect(redactUpstreamText('CPF already in use: 529.982.247-25')).toBe('CPF already in use: [number]')
    expect(redactUpstreamText('CPF already in use: 52998224725')).toBe('CPF already in use: [number]')
    expect(redactUpstreamText('Workout with id 5 not found')).toBe('Workout with id 5 not found')
  })
})
