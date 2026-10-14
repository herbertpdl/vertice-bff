import { afterEach, describe, expect, it } from 'vitest'
import * as grpc from '@grpc/grpc-js'
import { grpcCall, mapGrpcError, MissingCallerIdentityError, SERVICE_TOKEN_RPCS, type GrpcCallOptions } from './call.js'
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
  it('maps FAILED_PRECONDITION to 409 PRECONDITION_FAILED with the upstream message verbatim', () => {
    const details = "Cannot replace exercises: exercise 'Supino reto' (id 12) set 2 has recorded workout data"
    const err = mapGrpcError({ code: grpc.status.FAILED_PRECONDITION, details })
    expect(err).toBeInstanceOf(PreconditionFailedError)
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('PRECONDITION_FAILED')
    expect(err.message).toBe(details)
  })

  it('still maps INVALID_ARGUMENT to 400 VALIDATION_ERROR', () => {
    const err = mapGrpcError({
      code: grpc.status.INVALID_ARGUMENT,
      details: 'exercise_id: one or more referenced exercises do not exist',
    })
    expect(err).toBeInstanceOf(ValidationError)
    expect(err.statusCode).toBe(400)
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toBe('exercise_id: one or more referenced exercises do not exist')
  })

  it('mapGrpcError maps PERMISSION_DENIED to 403 FORBIDDEN with the upstream message verbatim', () => {
    const details = 'You do not have access to exercise 12'
    const err = mapGrpcError({ code: grpc.status.PERMISSION_DENIED, details })
    // A ForbiddenError, like the BFF's own refusals, so callers can treat both alike.
    expect(err).toBeInstanceOf(ForbiddenError)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('FORBIDDEN')
    expect(err.message).toBe(details)
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

  it('maps NOT_FOUND to 404', () => {
    const err = mapGrpcError({ code: grpc.status.NOT_FOUND, details: 'Workout' })
    expect(err).toBeInstanceOf(NotFoundError)
    expect(err.statusCode).toBe(404)
    expect(err.code).toBe('NOT_FOUND')
  })
})
