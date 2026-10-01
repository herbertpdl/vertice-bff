import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Request-scoped ambient data, available to anything running under a request
 * (route handlers, services, `src/lib/ownership.ts`) without threading a
 * parameter through every signature. Created empty per request by
 * `src/plugins/request-context.ts`; `bearerToken` is filled by
 * `app.authenticate` only after the token has been verified.
 */
export interface RequestContext {
  bearerToken?: string
}

export const requestContext = new AsyncLocalStorage<RequestContext>()
