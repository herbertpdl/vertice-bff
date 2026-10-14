import * as grpc from '@grpc/grpc-js'
import { ForbiddenError, HttpError, NotFoundError, PreconditionFailedError, ValidationError } from '../lib/errors.js'
import { serviceToken } from '../lib/jwt.js'
import { requestContext } from '../lib/request-context.js'

/**
 * Promisifies a grpc-js callback-style unary call and maps gRPC status codes to HttpErrors.
 * Every call carries `authorization` metadata: the caller's verified bearer token, or the BFF's
 * service token when no user is behind the call (see `withCallerIdentity`).
 */
export function grpcCall<TRequest, TResponse>(
  client: grpc.Client,
  method: string,
  request: TRequest,
  metadata: grpc.Metadata = new grpc.Metadata(),
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(client as any)[method](
      request,
      withCallerIdentity(metadata),
      (error: grpc.ServiceError | null, response: TResponse) => {
        if (error) {
          reject(mapGrpcError(error))
          return
        }
        resolve(response)
      },
    )
  })
}

/**
 * Attaches `authorization: Bearer <token>`, so vertice-api can tell who is calling: the user token
 * `app.authenticate` verified and put in the request context, or, when there is none, the BFF's
 * short-lived service token (`serviceToken`). That covers routes that don't authenticate
 * (`/auth/login`, `/auth/register`, `/auth/password/setup`) and calls outside a request (ops
 * scripts). An unverified `Authorization` header is never relayed, and a caller-supplied
 * `authorization` is never overwritten. Mutates and returns `metadata`.
 */
export function withCallerIdentity(metadata: grpc.Metadata): grpc.Metadata {
  if (metadata.get('authorization').length > 0) return metadata
  const token = requestContext.getStore()?.bearerToken ?? serviceToken()
  metadata.set('authorization', `Bearer ${token}`)
  return metadata
}

/** Maps a gRPC status to the HttpError the global error handler will render. Exported for tests. */
export function mapGrpcError(error: Pick<grpc.ServiceError, 'code' | 'details'>): HttpError {
  switch (error.code) {
    case grpc.status.NOT_FOUND:
      return new NotFoundError(error.details || 'Resource')
    case grpc.status.INVALID_ARGUMENT:
      return new ValidationError(error.details || 'Invalid request')
    // "Valid request, but the resource's state forbids it" (e.g. replacing a
    // workout's exercises after a client recorded data under it) — the web must
    // tell this apart from a malformed payload, so it is not folded into 400.
    // The upstream message is passed through verbatim.
    case grpc.status.FAILED_PRECONDITION:
      return new PreconditionFailedError(error.details || 'Precondition failed')
    case grpc.status.ALREADY_EXISTS:
      return new HttpError(409, error.details || 'Already exists', 'CONFLICT')
    case grpc.status.UNAUTHENTICATED:
      return new HttpError(401, error.details || 'Unauthenticated', 'UNAUTHENTICATED')
    case grpc.status.PERMISSION_DENIED:
      return new ForbiddenError(error.details || 'Forbidden')
    case grpc.status.UNAVAILABLE:
      return new HttpError(503, 'vertice-api is unavailable', 'UPSTREAM_UNAVAILABLE')
    default:
      return new HttpError(502, error.details || 'Upstream error', 'UPSTREAM_ERROR')
  }
}
