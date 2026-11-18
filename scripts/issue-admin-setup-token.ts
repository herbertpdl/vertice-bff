/**
 * Issues a new "Definir senha" link to an existing admin (forgotten password; vertice-api
 * `AdminOpsService.IssueAdminSetupToken`). Their earlier unused links stop working. Usage:
 *
 *   npm run ops:issue-admin-setup-token -- --user-id 42
 *
 * The link goes to stdout only (a credential); progress and errors go to stderr.
 */
import { issueAdminSetupToken, parseUserIdArgs } from '../src/ops/admin-ops.js'
import { opsToken } from '../src/ops/ops-token.js'
import { grpcTarget } from '../src/config/env.js'
import { adminOpsClient } from '../src/grpc/clients.js'

const args = parseUserIdArgs(process.argv.slice(2), 'ops:issue-admin-setup-token')
if (!args.ok) {
  process.stderr.write(`${args.message}\n`)
  process.exit(2)
}

process.stderr.write(`Issuing an admin setup link via ${grpcTarget}\n`)
try {
  const { userId, setupLink, expiresAt } = await issueAdminSetupToken(args.value['user-id'], opsToken)
  process.stdout.write(`userId=${userId}\nsetupLink=${setupLink}\nexpiresAt=${expiresAt}\n`)
} catch (err) {
  process.stderr.write(`Failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
} finally {
  adminOpsClient.close()
}
