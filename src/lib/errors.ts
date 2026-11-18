export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export class NotFoundError extends HttpError {
  constructor(resource: string) {
    super(404, `${resource} not found`, 'NOT_FOUND')
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message, 'CONFLICT')
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED')
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, message, 'FORBIDDEN')
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, message, 'VALIDATION_ERROR', details)
  }
}

/**
 * The request was well-formed but the resource's current state forbids it
 * (gRPC FAILED_PRECONDITION) — distinct from a malformed payload (400).
 */
export class PreconditionFailedError extends HttpError {
  constructor(message: string) {
    super(409, message, 'PRECONDITION_FAILED')
  }
}

/**
 * A rate limit was hit; the caller should wait `Retry-After` seconds. With `retryAfterSeconds` the
 * error handler writes that header itself (an upstream lock, e.g. the admin second factor's);
 * without it, whoever throws sets the header (the BFF's own buckets, `plugins/rate-limit.ts`).
 */
export class TooManyRequestsError extends HttpError {
  constructor(
    message = 'Too many attempts, try again later',
    public readonly retryAfterSeconds?: number,
  ) {
    super(429, message, 'RATE_LIMITED')
  }
}

/**
 * vertice-api's RESOURCE_EXHAUSTED, globally a 413 `TOO_LARGE` (the export bounds). When the
 * upstream text says "retry after N seconds" (a lock or a send limit), N rides along here, never
 * in the body, so a route that means "wait" can turn it into a 429 with `Retry-After`.
 */
export class UpstreamExhaustedError extends HttpError {
  constructor(
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(413, message, 'TOO_LARGE')
  }
}
