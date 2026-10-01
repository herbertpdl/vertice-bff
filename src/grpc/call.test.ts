import { describe, expect, it } from 'vitest'
import * as grpc from '@grpc/grpc-js'
import { grpcCall, mapGrpcError } from './call.js'
import { HttpError, PreconditionFailedError, ValidationError } from '../lib/errors.js'
import { requestContext } from '../lib/request-context.js'

/** A stand-in grpc-js client that records the metadata of the last call. */
function stubClient() {
  const stub = {
    seen: undefined as grpc.Metadata | undefined,
    Ping(_request: unknown, metadata: grpc.Metadata, cb: (err: null, res: object) => void) {
      stub.seen = metadata
      cb(null, {})
    },
  }
  return stub
}

describe('grpcCall', () => {
  it('grpcCall attaches "authorization: Bearer <token>" metadata when the request context holds a token', async () => {
    const stub = stubClient()
    await requestContext.run({ bearerToken: 'abc' }, () =>
      grpcCall(stub as unknown as grpc.Client, 'Ping', {}),
    )
    expect(stub.seen!.get('authorization')).toEqual(['Bearer abc'])
  })

  it('grpcCall sends no authorization metadata outside a request context', async () => {
    const stub = stubClient()
    await grpcCall(stub as unknown as grpc.Client, 'Ping', {})
    expect(stub.seen!.get('authorization')).toEqual([])
  })

  it('grpcCall keeps caller-supplied metadata and adds the bearer to it', async () => {
    const stub = stubClient()
    const metadata = new grpc.Metadata()
    metadata.set('x-test', '1')
    await requestContext.run({ bearerToken: 'abc' }, () =>
      grpcCall(stub as unknown as grpc.Client, 'Ping', {}, metadata),
    )
    expect(stub.seen!.get('x-test')).toEqual(['1'])
    expect(stub.seen!.get('authorization')).toEqual(['Bearer abc'])

    const explicit = new grpc.Metadata()
    explicit.set('authorization', 'Bearer caller-supplied')
    await requestContext.run({ bearerToken: 'abc' }, () =>
      grpcCall(stub as unknown as grpc.Client, 'Ping', {}, explicit),
    )
    expect(stub.seen!.get('authorization')).toEqual(['Bearer caller-supplied'])
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
    expect(err).toBeInstanceOf(HttpError)
    expect(err.statusCode).toBe(403)
    expect(err.code).toBe('FORBIDDEN')
    expect(err.message).toBe(details)
  })

  it('maps NOT_FOUND to 404', () => {
    const err = mapGrpcError({ code: grpc.status.NOT_FOUND, details: 'Workout' })
    expect(err.statusCode).toBe(404)
    expect(err.code).toBe('NOT_FOUND')
  })
})
