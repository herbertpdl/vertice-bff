/**
 * Issues a password setup link to every CLIENT (P0-02 migration). Usage:
 *
 *   npm run ops:issue-setup-tokens -- --dry-run   # list who would get one, issue nothing
 *   npm run ops:issue-setup-tokens > links.csv     # issue; CSV on stdout
 *
 * Output goes to stdout only (the links are credentials); progress and errors go to stderr.
 * See the README's "Operations" section.
 */
import { issueSetupTokens } from '../src/ops/issue-setup-tokens.js'
import { grpcTarget } from '../src/config/env.js'
import { userClient } from '../src/grpc/clients.js'

const args = process.argv.slice(2)
const unknown = args.filter((arg) => arg !== '--dry-run')
if (unknown.length > 0) {
  process.stderr.write(`Unknown argument(s): ${unknown.join(' ')}\nUsage: issue-setup-tokens [--dry-run]\n`)
  process.exit(2) // nothing written to stdout yet
}
const dryRun = args.includes('--dry-run')

process.stderr.write(`${dryRun ? '[dry run] listing' : 'Issuing setup tokens for'} every CLIENT via ${grpcTarget}\n`)
// exitCode, not process.exit(): exiting right away could cut off stdout writes still being
// flushed to a pipe, i.e. lose issued links. The open gRPC channel is closed so Node can exit.
try {
  const count = await issueSetupTokens({ dryRun, write: (line) => process.stdout.write(`${line}\n`) })
  process.stderr.write(`${dryRun ? 'Would issue' : 'Issued'} ${count} setup token(s)\n`)
} catch (err) {
  process.stderr.write(`Failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
} finally {
  userClient.close()
}
