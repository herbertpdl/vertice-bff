import * as grpc from '@grpc/grpc-js'
import { HttpError, NotFoundError, ValidationError } from '../lib/errors.js'

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

function mapGrpcError(error: grpc.ServiceError): HttpError {
  switch (error.code) {
    case grpc.status.NOT_FOUND:
      return new NotFoundError(error.details || 'Resource')
    case grpc.status.INVALID_ARGUMENT:
    case grpc.status.FAILED_PRECONDITION:
      return new ValidationError(error.details || 'Invalid request')
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
