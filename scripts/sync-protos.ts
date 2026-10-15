/**
 * Keeps `protos/vertice/**` identical to vertice-api's `src/main/proto/vertice/**` at the commit
 * pinned in `protos/.api-ref` (XREPO-005). Only `*.proto` files are copied (never `buf.yaml`).
 *
 *   npm run sync:protos                  # fetch the pinned commit from GitHub and overwrite protos/vertice
 *   npm run sync:protos -- --check       # same fetch, change nothing, exit 1 if protos/vertice differs
 *   npm run sync:protos -- --local       # read the pinned commit from the sibling ../vertice-api clone
 *   npm run sync:protos -- --local=PATH  # ...or from another clone (needs the pinned commit to exist there)
 *
 * Bumping the pin: merge the proto change in vertice-api, put the merge commit's full SHA in
 * `protos/.api-ref`, run `npm run sync:protos`, commit both. CI runs `--check`.
 * vertice-api is public, so the remote mode needs no token (set GITHUB_TOKEN to lift rate limits).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'herbertpdl/vertice-api'
const SRC_DIR = 'src/main/proto/vertice'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const refFile = path.join(root, 'protos', '.api-ref')
const destDir = path.join(root, 'protos', 'vertice')

function fail(message: string): never {
  process.stderr.write(`sync:protos: ${message}\n`)
  process.exit(2)
}

/** The pinned SHA: the first non-blank, non-`#` line of protos/.api-ref, which must be 40 hex chars. */
export function parsePin(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find((l) => l !== '' && !l.startsWith('#'))
  if (!line || !/^[0-9a-f]{40}$/.test(line)) {
    throw new Error('protos/.api-ref must hold a full 40-character lowercase commit SHA of vertice-api')
  }
  return line
}

/** Every `*.proto` under `dir`, keyed by its posix path relative to `dir`. */
function readProtos(dir: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.proto')) {
        files.set(path.relative(dir, full).split(path.sep).join('/'), readFileSync(full, 'utf8'))
      }
    }
  }
  walk(dir)
  return files
}

async function fetchSource(sha: string, local: string | null, scratch: string): Promise<string> {
  if (local !== null) {
    const archive = path.join(scratch, 'src.tar')
    try {
      execFileSync('git', ['-C', local, 'archive', '--output', archive, sha, SRC_DIR], { stdio: 'pipe' })
    } catch {
      fail(`commit ${sha} (or ${SRC_DIR}) not found in ${local}; run "git -C ${local} fetch" first`)
    }
    execFileSync('tar', ['-xf', archive, '-C', scratch])
    return path.join(scratch, SRC_DIR)
  }
  const headers: Record<string, string> = { 'User-Agent': 'vertice-bff-sync-protos' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${sha}`, { headers })
  if (!res.ok) fail(`could not fetch ${REPO}@${sha}: HTTP ${res.status}`)
  const archive = path.join(scratch, 'src.tar.gz')
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()))
  execFileSync('tar', ['-xzf', archive, '-C', scratch])
  return path.join(scratch, `vertice-api-${sha}`, SRC_DIR)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const localArg = args.find((a) => a === '--local' || a.startsWith('--local='))
  const unknown = args.filter((a) => a !== '--check' && a !== localArg)
  if (unknown.length > 0) fail(`unknown argument(s): ${unknown.join(' ')}\nUsage: sync-protos [--check] [--local[=PATH]]`)
  const local = localArg === undefined ? null : path.resolve(root, localArg.split('=')[1] ?? '../vertice-api')

  let sha: string
  try {
    sha = parsePin(readFileSync(refFile, 'utf8'))
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'sync-protos-'))
  try {
    const source = readProtos(await fetchSource(sha, local, scratch))
    if (source.size === 0) fail(`no .proto files under ${SRC_DIR} at ${sha}`)
    const current = (() => {
      try {
        return readProtos(destDir)
      } catch {
        return new Map<string, string>()
      }
    })()

    const added = [...source.keys()].filter((f) => !current.has(f))
    const removed = [...current.keys()].filter((f) => !source.has(f))
    const changed = [...source.keys()].filter((f) => current.has(f) && current.get(f) !== source.get(f))
    const inSync = added.length + removed.length + changed.length === 0

    if (check) {
      if (inSync) {
        process.stdout.write(`protos/vertice matches ${REPO}@${sha.slice(0, 10)} (${source.size} files)\n`)
        return
      }
      for (const f of added) process.stderr.write(`  missing in BFF:   ${f}\n`)
      for (const f of removed) process.stderr.write(`  not in API ref:   ${f}\n`)
      for (const f of changed) process.stderr.write(`  differs:          ${f}\n`)
      process.stderr.write(
        `protos/vertice is out of sync with ${REPO}@${sha}.\n` +
          'Run "npm run sync:protos" and commit the result (or fix protos/.api-ref if the pin is wrong).\n',
      )
      process.exit(1)
    }

    for (const f of removed) rmSync(path.join(destDir, f))
    for (const f of [...added, ...changed]) {
      const target = path.join(destDir, f)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, source.get(f) as string)
    }
    process.stdout.write(
      inSync
        ? `protos/vertice already matches ${REPO}@${sha.slice(0, 10)} (${source.size} files)\n`
        : `Synced protos/vertice to ${REPO}@${sha.slice(0, 10)}: ${added.length} added, ${changed.length} updated, ${removed.length} removed\n`,
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
