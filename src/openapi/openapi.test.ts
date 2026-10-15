import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { generateOpenapi } from './generate.js'
import { ERROR_CODES } from './responses.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')
const { version } = JSON.parse(read('package.json')) as { version: string }

interface Operation {
  operationId: string
  summary: string
  tags: string[]
  security?: unknown[]
  responses: Record<string, unknown>
}
interface Spec {
  openapi: string
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> }
}

describe('OpenAPI document', () => {
  it('docs/openapi.json and the route reference in docs/api-contract.md are current (run `npm run openapi`)', async () => {
    const generated = await generateOpenapi({ contract: read('docs/api-contract.md'), version })
    expect(read('docs/openapi.json') === generated.spec, 'docs/openapi.json is out of date').toBe(true)
    expect(read('docs/api-contract.md') === generated.contract, 'docs/api-contract.md is out of date').toBe(true)
  })

  const spec = JSON.parse(read('docs/openapi.json')) as Spec
  const operations = Object.entries(spec.paths).flatMap(([p, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ key: `${method.toUpperCase()} ${p}`, op })),
  )

  it('describes every operation for a generated client: id, summary, tag, success and error responses', () => {
    const ids = operations.map(({ op }) => op.operationId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const { key, op } of operations) {
      expect(op.operationId, key).toMatch(/^[a-z][A-Za-z0-9]+$/)
      expect(op.summary, key).toBeTruthy()
      expect(op.tags, key).toHaveLength(1)
      expect(Object.keys(op.responses).some((status) => status.startsWith('2')), key).toBe(true)
      if (op.security?.length) expect(op.responses['401'], key).toBeDefined()
    }
  })

  it('declares the bearer scheme and exactly the public routes without it', () => {
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.components.securitySchemes).toMatchObject({ bearerAuth: { type: 'http', scheme: 'bearer' } })
    const open = operations.filter(({ op }) => op.security?.length === 0).map(({ key }) => key)
    expect(open.sort()).toEqual(
      [
        'GET /health',
        'GET /api/legal/versions',
        'POST /api/auth/login',
        'POST /api/auth/register',
        'POST /api/auth/password/setup',
      ].sort(),
    )
    expect(operations.filter(({ op }) => op.security === undefined).map(({ key }) => key)).toEqual([])
  })

  it('names its enums and keeps request and response copies of a schema as one component', () => {
    const names = Object.keys(spec.components.schemas)
    for (const name of ['DayOfWeek', 'SetStrategy', 'PlanLevel', 'Role', 'ErrorResponse', 'ErrorCode']) {
      expect(names).toContain(name)
    }
    expect(names.filter((name) => name.endsWith('Input') && names.includes(name.slice(0, -5)))).toEqual([])
    expect(spec.components.schemas.ErrorCode).toMatchObject({ enum: [...ERROR_CODES] })
  })

  it('lists every error code the BFF can emit', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !full.includes(`${path.sep}test${path.sep}`)) files.push(full)
      }
    }
    walk(path.join(root, 'src'))
    const emitted = new Set<string>()
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/(?:HttpError\(|super\()\s*\d{3},[^,]+,\s*'([A-Z_]+)'/g)) emitted.add(match[1]!)
      for (const match of source.matchAll(/\bcode: '([A-Z_]+)'/g)) emitted.add(match[1]!)
    }
    expect(emitted.size).toBeGreaterThan(8)
    expect([...emitted].filter((code) => !(ERROR_CODES as readonly string[]).includes(code))).toEqual([])
  })

  it('is not served by the app, in any environment', async () => {
    const app = await buildApp()
    try {
      await app.ready()
      expect((app as { swagger?: unknown }).swagger).toBeUndefined()
      for (const url of ['/documentation/json', '/documentation', '/api/openapi.json', '/openapi.json', '/api/docs']) {
        expect((await app.inject({ url })).statusCode, url).toBe(404)
      }
    } finally {
      await app.close()
    }
  })
})
