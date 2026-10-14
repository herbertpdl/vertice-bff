import * as grpc from '@grpc/grpc-js'
import { DEV_NODE_ENVS, env } from '../config/env.js'
import { ForbiddenError, HttpError, NotFoundError, PreconditionFailedError, ValidationError } from '../lib/errors.js'
import { serviceToken } from '../lib/jwt.js'
import { requestContext } from '../lib/request-context.js'

/**
 * The only RPCs the BFF's runtime service token (`serviceToken()`) may be sent on: the public
 * auth routes, where no user is behind the call (login, register, password setup). vertice-api
 * allows `service:bff` on exactly these.
 */
export const SERVICE_TOKEN_RPCS: ReadonlySet<string> = new Set(['VerifyCredentials', 'CreateUser', 'SetPasswordWithToken'])

export interface GrpcCallOptions {
  /** Extra metadata. An `authorization` already in it is sent as is (the ops script's own token). */
  metadata?: grpc.Metadata
  /**
   * With no verified user token in the request context, send the BFF's service token instead.
   * Only for an RPC in `SERVICE_TOKEN_RPCS`; a verified user token still wins.
   */
  asService?: boolean
  /**
   * With no verified user token, send no `authorization` at all. Only the `VERIFY_PASSWORDS=false`
   * dev login uses it, and it only works against vertice-api's `local` profile. Refused unless
   * `VERIFY_PASSWORDS` is false and `NODE_ENV` is a dev value (`DEV_NODE_ENVS`).
   */
  anonymous?: boolean
}

/** Thrown, before anything goes upstream, when a call has no caller identity it may use. */
export class MissingCallerIdentityError extends Error {
  constructor(method: string, reason: string) {
    super(`grpcCall ${method}: ${reason}`)
    this.name = 'MissingCallerIdentityError'
  }
}

/**
 * Promisifies a grpc-js callback-style unary call and maps gRPC status codes to HttpErrors.
 * Every call carries the caller's identity as `authorization` metadata (see
 * `withCallerIdentity`); a call with none fails closed instead of going out.
 */
export function grpcCall<TRequest, TResponse>(
  client: grpc.Client,
  method: string,
  request: TRequest,
  options: GrpcCallOptions = {},
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    const metadata = withCallerIdentity(method, options)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(client as any)[method](request, metadata, (error: grpc.ServiceError | null, response: TResponse) => {
      if (error) {
        reject(mapGrpcError(error))
        return
      }
      resolve(response)
    })
  })
}

/**
 * Returns the metadata to send, with `authorization: Bearer <token>` so vertice-api can tell who
 * is calling, in this order:
 * 1. an `authorization` the caller put in `options.metadata` (the ops script's `service:ops`);
 * 2. the user token `app.authenticate` verified and put in the request context;
 * 3. the BFF's service token, only with `asService` and only on `SERVICE_TOKEN_RPCS`;
 * 4. nothing, only with `anonymous` (dev login against the API's `local` profile), and only while
 *    `VERIFY_PASSWORDS` is false in a dev `NODE_ENV`, so the opt-in is inert anywhere else.
 * Anything else throws `MissingCallerIdentityError`: a call without a user never silently runs
 * as the BFF. An unverified `Authorization` header is never relayed.
 */
export function withCallerIdentity(method: string, options: GrpcCallOptions = {}): grpc.Metadata {
  const metadata = options.metadata ?? new grpc.Metadata()
  if (metadata.get('authorization').length > 0) return metadata
  const userToken = requestContext.getStore()?.bearerToken
  if (userToken) {
    metadata.set('authorization', `Bearer ${userToken}`)
    return metadata
  }
  if (options.asService) {
    if (!SERVICE_TOKEN_RPCS.has(method)) {
      throw new MissingCallerIdentityError(method, 'the service token is not allowed on this RPC')
    }
    metadata.set('authorization', `Bearer ${serviceToken()}`)
    return metadata
  }
  if (options.anonymous) {
    if (env.VERIFY_PASSWORDS || !DEV_NODE_ENVS.includes(env.NODE_ENV)) {
      throw new MissingCallerIdentityError(method, 'anonymous calls are only allowed for the VERIFY_PASSWORDS=false dev login')
    }
    return metadata
  }
  throw new MissingCallerIdentityError(method, 'no verified user token and no explicit service opt-in')
}

/** The message of every 401 caused by vertice-api refusing the caller's identity. */
export const SESSION_INVALID_MESSAGE = 'Session no longer valid'

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
    // vertice-api refused the forwarded identity, e.g. "Session no longer valid" for a user who was
    // deleted or given another role since the token was minted. Clients treat a 401 as logout, so
    // the body is fixed: a stable code and message, nothing from upstream. (The password routes
    // turn this into their own 400/401 first.)
    case grpc.status.UNAUTHENTICATED:
      return new HttpError(401, SESSION_INVALID_MESSAGE, 'UNAUTHENTICATED')
    case grpc.status.PERMISSION_DENIED:
      return new ForbiddenError(error.details || 'Forbidden')
    case grpc.status.UNAVAILABLE:
      return new HttpError(503, 'vertice-api is unavailable', 'UPSTREAM_UNAVAILABLE')
    default:
      return new HttpError(502, error.details || 'Upstream error', 'UPSTREAM_ERROR')
  }
}
