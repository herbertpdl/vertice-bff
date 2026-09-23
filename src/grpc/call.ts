import * as grpc from '@grpc/grpc-js'
import { HttpError, PreconditionFailedError, ValidationError } from '../lib/errors.js'

/** Promisifies a grpc-js callback-style unary call and maps gRPC status codes to HttpErrors. */
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
      metadata,
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

/** Maps a gRPC status to the HttpError the global error handler will render. Exported for tests. */
export function mapGrpcError(error: Pick<grpc.ServiceError, 'code' | 'details'>): HttpError {
  switch (error.code) {
    // vertice-api's description is already a full sentence ("Exercise with id 5
    // not found"), so it is passed through verbatim rather than wrapped by
    // NotFoundError, which would append a second "not found".
    case grpc.status.NOT_FOUND:
      return new HttpError(404, error.details || 'Resource not found', 'NOT_FOUND')
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
      return new HttpError(403, error.details || 'Forbidden', 'FORBIDDEN')
    case grpc.status.UNAVAILABLE:
      return new HttpError(503, 'vertice-api is unavailable', 'UPSTREAM_UNAVAILABLE')
    default:
      return new HttpError(502, error.details || 'Upstream error', 'UPSTREAM_ERROR')
  }
}
