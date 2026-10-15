/**
 * Writes `docs/openapi.json` (OpenAPI 3.1) and the route reference inside `docs/api-contract.md`
 * from the routes' Zod schemas, so neither is written by hand.
 *
 *   npm run openapi              # regenerate both files
 *   npm run openapi -- --check   # change nothing, exit 1 if either is out of date (CI)
 *
 * The output is deterministic (no timestamps, fixed ordering, no env values), so the check is a
 * plain string comparison. Web and mobile generate their TypeScript types from `docs/openapi.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Before anything imports `config/env`: a fixed, quiet environment whatever the shell or .env says.
process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'fatal'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const specFile = path.join(root, 'docs', 'openapi.json')
const contractFile = path.join(root, 'docs', 'api-contract.md')
const check = process.argv.includes('--check')

const { generateOpenapi } = await import('../src/openapi/generate.js')
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
const generated = await generateOpenapi({ contract: readFileSync(contractFile, 'utf8'), version })

const outputs = [
  { file: specFile, next: generated.spec },
  { file: contractFile, next: generated.contract },
]

const stale = outputs.filter(({ file, next }) => {
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    // missing counts as out of date
  }
  return current !== next
})

if (check) {
  if (stale.length > 0) {
    for (const { file } of stale) process.stderr.write(`openapi: ${path.relative(root, file)} is out of date\n`)
    process.stderr.write('Run `npm run openapi` and commit the result.\n')
    process.exit(1)
  }
  process.stdout.write('openapi: docs/openapi.json and docs/api-contract.md are up to date\n')
} else {
  for (const { file, next } of stale) {
    writeFileSync(file, next)
    process.stdout.write(`openapi: wrote ${path.relative(root, file)}\n`)
  }
  if (stale.length === 0) process.stdout.write('openapi: already up to date\n')
}
