/**
 * Resets a lost authenticator (vertice-api `AdminOpsService.ResetAdminSecondFactor`): deletes the
 * admin's second factor and ends every session of theirs; they enrol again at the next sign-in.
 * Usage:
 *
 *   npm run ops:reset-admin-2fa -- --user-id 42
 *
 * In production it runs compiled inside the BFF task, through ECS Exec (README "Admin accounts"):
 *
 *   node dist/ops/cli/reset-admin-2fa.js --user-id 42
 */
import { parseUserIdArgs, resetAdminSecondFactor } from '../admin-ops.js'
import { opsToken } from '../ops-token.js'
import { grpcTarget } from '../../config/env.js'
import { adminOpsClient } from '../../grpc/clients.js'

const args = parseUserIdArgs(process.argv.slice(2), 'ops:reset-admin-2fa')
if (!args.ok) {
  process.stderr.write(`${args.message}\n`)
  process.exit(2)
}

process.stderr.write(`Resetting the admin's second factor via ${grpcTarget}\n`)
try {
  await resetAdminSecondFactor(args.value['user-id'], opsToken)
  process.stdout.write(`Second factor reset for user ${args.value['user-id']}; their sessions have ended.\n`)
} catch (err) {
  process.stderr.write(`Failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
} finally {
  adminOpsClient.close()
}
