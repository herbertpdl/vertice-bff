import type { FastifyInstance } from 'fastify'
import swagger from '@fastify/swagger'
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod'
import { TAGS } from './docs.js'

/**
 * OpenAPI for the REST surface, generated from the routes' Zod schemas (`docs/openapi.json`,
 * written by `npm run openapi`, checked in CI). It is a build artifact: no route serves it and
 * there is no docs UI, in any environment. `buildApp({ openapi })` loads this module and registers
 * the generator; a normal start never imports it, so production carries none of it.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const REF_PREFIX = '#/components/schemas/'

function collectRefs(value: Json, into: Set<string>) {
  if (Array.isArray(value)) value.forEach((child) => collectRefs(child, into))
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string') into.add(child.slice(REF_PREFIX.length))
      else collectRefs(child, into)
    }
  }
}

/**
 * Tidies what `fastify-type-provider-zod` emits so the generated TypeScript types are readable:
 * - It writes every registered schema twice, `<id>` (for responses) and `<id>Input` (for requests).
 *   Drop the ones nothing references, and where an `Input` twin is the same JSON as its `<id>`
 *   (the enums) merge them; a request-only schema just loses the suffix.
 * - Fastify mounts a route at `/prefix` and `/prefix/`; the document lists the one clients call.
 */
function tidy(doc: Json): Json {
  const root = doc as { paths?: Record<string, Json>; components?: { schemas?: Record<string, Json> } }
  const schemas = root.components?.schemas ?? {}

  // Keep what the operations reach, directly or through other schemas.
  const used = new Set<string>()
  collectRefs({ ...root, components: undefined } as unknown as Json, used)
  for (let grew = true; grew; ) {
    grew = false
    for (const name of [...used]) {
      const nested = new Set<string>()
      collectRefs(schemas[name] ?? null, nested)
      for (const ref of nested) {
        if (!used.has(ref)) {
          used.add(ref)
          grew = true
        }
      }
    }
  }

  const renames = new Map<string, string>()
  for (const name of used) {
    if (!name.endsWith('Input')) continue
    const base = name.slice(0, -'Input'.length)
    if (!used.has(base) || JSON.stringify(schemas[base]) === JSON.stringify(schemas[name])) renames.set(name, base)
  }

  const rewrite = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
          if (key === '$ref' && typeof child === 'string') {
            const name = child.slice(REF_PREFIX.length)
            return [key, REF_PREFIX + (renames.get(name) ?? name)]
          }
          return [key, rewrite(child)]
        }),
      )
    }
    return value
  }

  const kept: Record<string, Json> = {}
  for (const name of [...used].sort()) kept[renames.get(name) ?? name] ??= rewrite(schemas[name]!)

  const paths: Record<string, Json> = {}
  for (const [path, item] of Object.entries(root.paths ?? {})) {
    paths[path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path] = rewrite(item)
  }

  return { ...root, paths, components: { ...root.components, schemas: kept } } as Json
}

export async function registerOpenapi(app: FastifyInstance, version: string) {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'vertice-bff',
        version,
        description:
          'The REST API the Vertice web and mobile apps call; it bridges HTTP/JSON to vertice-api over gRPC.\n\n' +
          'Every error is `{ error: { code, message, details? } }`: key on `code`, never on `message`. ' +
          'Besides the errors listed per operation, any call can answer 429 (global rate limit), ' +
          '502 `UPSTREAM_ERROR` or 503 `UPSTREAM_UNAVAILABLE` (vertice-api refused or is down). ' +
          'Rules that do not fit a schema (ownership, rate limits, the time-zone rule) are in docs/api-contract.md.',
      },
      servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
      tags: TAGS.map((tag) => ({ ...tag })),
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'The token `POST /api/auth/login` or `/api/auth/register` returned. Treat it as opaque.',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: (document) => {
      const doc = jsonSchemaTransformObject(document) as unknown as Json
      return tidy(doc) as unknown as ReturnType<typeof jsonSchemaTransformObject>
    },
  })
}
