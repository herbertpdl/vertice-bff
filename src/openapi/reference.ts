/**
 * The route reference in `docs/api-contract.md`, rendered from the generated OpenAPI document so
 * the list of routes, their access rules and their operation ids cannot go stale. Everything
 * else in the contract (error mapping, ownership, rate limits, the shapes' semantics) stays prose.
 */
export const REFERENCE_BEGIN = '<!-- BEGIN GENERATED ROUTE REFERENCE (npm run openapi) -->'
export const REFERENCE_END = '<!-- END GENERATED ROUTE REFERENCE -->'

interface Operation {
  operationId: string
  summary: string
  tags: string[]
  security?: unknown[]
  'x-roles'?: string[]
}

interface Spec {
  tags?: { name: string; description?: string }[]
  paths: Record<string, Record<string, Operation>>
}

const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete']

function access(op: Operation): string {
  if (op.security && op.security.length === 0) return 'public'
  return op['x-roles']?.join(', ') ?? 'any role'
}

export function renderRouteReference(spec: Spec): string {
  const byTag = new Map<string, { method: string; path: string; op: Operation }[]>()
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const method of METHOD_ORDER) {
      const op = methods[method]
      if (!op) continue
      const tag = op.tags[0] ?? 'Other'
      byTag.set(tag, [...(byTag.get(tag) ?? []), { method, path, op }])
    }
  }

  const lines = [
    REFERENCE_BEGIN,
    '<!-- Generated from the routes by `npm run openapi`; CI fails when it is stale. Do not edit by hand. -->',
    '',
    'Paths are absolute, `/api` included (the dev server is `http://localhost:3000`). The full request and response schemas,',
    'with the error responses of each operation, are in [`openapi.json`](./openapi.json) (OpenAPI 3.1).',
    '',
  ]
  for (const tag of spec.tags ?? []) {
    const rows = byTag.get(tag.name)
    if (!rows) continue
    lines.push(`### ${tag.name}`, '', tag.description ?? '', '', '| Method | Path | Access | `operationId` | Summary |', '|---|---|---|---|---|')
    for (const { method, path, op } of rows) {
      lines.push(`| ${method.toUpperCase()} | \`${path}\` | ${access(op)} | \`${op.operationId}\` | ${op.summary} |`)
    }
    lines.push('')
  }
  lines.push(REFERENCE_END)
  return lines.join('\n')
}

export function replaceRouteReference(contract: string, reference: string): string {
  const start = contract.indexOf(REFERENCE_BEGIN)
  const end = contract.indexOf(REFERENCE_END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`docs/api-contract.md needs the markers ${REFERENCE_BEGIN} and ${REFERENCE_END}`)
  }
  return contract.slice(0, start) + reference + contract.slice(end + REFERENCE_END.length)
}
