import type { FastifyInstance, FastifySchema } from 'fastify'
import { z } from 'zod'
import type { Role } from '../lib/jwt.js'
import { errorResponseSchema } from './responses.js'

/**
 * Per-route OpenAPI metadata. A route passes `routeDoc({...})` as its `schema`; the Zod schemas in
 * it are the very ones the handler parses with, so the document cannot drift from the validation.
 * Nothing here validates or serializes (see `./index.ts`): the handlers still call `schema.parse`
 * themselves, after authentication and ownership checks, exactly as before.
 */

/** Tag order is the order of the generated reference. */
export const TAGS = [
  { name: 'Auth', description: 'Login, registration, passwords and the caller’s own account (`/auth/me`, LGPD data-subject rights).' },
  { name: 'Legal', description: 'Versions of the legal texts, for the consent flow.' },
  { name: 'Clients', description: 'A trainer’s roster of clients (TRAINER only).' },
  { name: 'Exercises', description: 'The exercise catalog (shared starter set plus each trainer’s own) and muscle groups.' },
  { name: 'Training plans', description: 'A plan is one trainer’s and one client’s.' },
  { name: 'Workouts', description: 'Workouts of a plan, including the full aggregate (`/full`) and cloning.' },
  { name: 'Workout exercises', description: 'The exercises of a workout.' },
  { name: 'Exercise sets', description: 'The sets of a workout exercise.' },
  { name: 'Workout sessions', description: 'The client’s “do a workout” flow: the session aggregate, set logs and workout logs.' },
  { name: 'Feedback', description: 'Client feedback on a workout log, read by the trainer.' },
  { name: 'Dashboard', description: 'The trainer’s landing page in one call.' },
  { name: 'Health', description: 'Liveness.' },
] as const

type Tag = (typeof TAGS)[number]['name']

const ERROR_DESCRIPTIONS = {
  400: 'A malformed path id, query or body (`VALIDATION_ERROR` with field `details`), or a route-specific 400 code.',
  401: 'Missing, invalid or expired token (`UNAUTHORIZED`), or the account no longer exists (`UNAUTHENTICATED`).',
  403: 'The role or the owner check refuses the caller (`FORBIDDEN`).',
  404: 'Not found (`NOT_FOUND`).',
  409: 'Conflict with the current state (`CONFLICT`, `PRECONDITION_FAILED`, `ACTIVE_CLIENTS`).',
  413: 'The requested data is too large to return (`TOO_LARGE`).',
  429: 'Rate limited (`RATE_LIMITED`); `Retry-After` carries the seconds to wait.',
} as const

type ErrorStatus = keyof typeof ERROR_DESCRIPTIONS

export interface RouteDoc {
  /** Unique, camelCase: the generated clients' function names. */
  operationId: string
  summary: string
  description?: string
  tag: Tag
  /** Default `bearer`. `public` routes carry no security requirement. */
  auth?: 'bearer' | 'public'
  /**
   * The roles that may call it; omitted means any authenticated role. Documentation of the
   * `requireRole` hooks, pinned against the route-authorization suite so the two cannot disagree.
   */
  roles?: Role[]
  params?: z.ZodType
  query?: z.ZodType
  body?: z.ZodType
  /** The success response. `schema` is omitted for a 204. */
  ok: { status: 200 | 201 | 204; description: string; schema?: z.ZodType; contentType?: string }
  /**
   * Error statuses this route can answer with, beyond the derived ones: 401 for `bearer`, and 400
   * whenever the route reads input (`parseId` refuses a malformed path id, and a schema refuses a
   * malformed query or body).
   */
  errors?: ErrorStatus[]
}

export function routeDoc(doc: RouteDoc): FastifySchema {
  const auth = doc.auth ?? 'bearer'
  const errorStatuses = new Set<ErrorStatus>(doc.errors ?? [])
  if (auth === 'bearer') errorStatuses.add(401)
  // Derived, not per route: every route that reads a path id, a query or a body can answer 400,
  // and listing that by hand made equivalent routes disagree.
  if (doc.params || doc.query || doc.body) errorStatuses.add(400)

  const response: Record<number, unknown> = {
    [doc.ok.status]: doc.ok.schema
      ? {
          description: doc.ok.description,
          content: { [doc.ok.contentType ?? 'application/json']: { schema: doc.ok.schema } },
        }
      : z.undefined().describe(doc.ok.description),
  }
  for (const status of [...errorStatuses].sort()) {
    response[status] = {
      description: ERROR_DESCRIPTIONS[status],
      content: { 'application/json': { schema: errorResponseSchema } },
    }
  }

  const access =
    auth === 'public'
      ? 'Public: no token needed.'
      : doc.roles
        ? `Roles: ${doc.roles.join(', ')}.`
        : 'Any authenticated role.'

  return {
    operationId: doc.operationId,
    summary: doc.summary,
    description: doc.description ? `${access} ${doc.description}` : access,
    ...(doc.roles ? { 'x-roles': doc.roles } : {}),
    tags: [doc.tag],
    security: auth === 'public' ? [] : [{ bearerAuth: [] }],
    ...(doc.params ? { params: doc.params } : {}),
    ...(doc.query ? { querystring: doc.query } : {}),
    ...(doc.body ? { body: doc.body } : {}),
    response,
  } as FastifySchema
}

/** A path parameter that is a positive integer id (the routes read it with `parseId`). */
export const idParams = (...names: string[]) =>
  z.object(Object.fromEntries(names.map((name) => [name, z.number().int().positive()])))

/** A query-string id (documentation only; the routes read it with `optionalIdQuery`). */
export const idQuery = (description: string) => z.number().int().positive().optional().describe(description)

/**
 * The schemas on the routes are documentation only. Validation stays where it was: handlers call
 * `schema.parse(req.body)` themselves, after authentication and ownership checks, so a request is
 * still answered 401/403 before 400 and the error bodies (`plugins/error-handler.ts`) are
 * unchanged. A Fastify validation hook would reorder those. So these two compilers accept
 * everything and serialize exactly like Fastify does without a schema.
 */
export function useDocumentationOnlySchemas(app: FastifyInstance) {
  app.setValidatorCompiler(() => (data) => ({ value: data }))
  app.setSerializerCompiler(() => (data) => JSON.stringify(data))
}
