/**
 * Lifts an admin's suspension (vertice-api `AdminOpsService.ReactivateAdmin`, admin-panel R14):
 * they can sign in again; sessions from before the suspension stay void.
 * Usage:
 *
 *   npm run ops:reactivate-admin -- --user-id 42
 *
 * In production it runs compiled inside the BFF task, through ECS Exec (README "Admin accounts"):
 *
 *   node dist/ops/cli/reactivate-admin.js --user-id 42
 */
import { reactivateAdmin, parseUserIdArgs } from '../admin-ops.js'
import { opsToken } from '../ops-token.js'
import { grpcTarget } from '../../config/env.js'
import { adminOpsClient } from '../../grpc/clients.js'
import { PreconditionFailedError } from '../../lib/errors.js'

const args = parseUserIdArgs(process.argv.slice(2), 'ops:reactivate-admin')
if (!args.ok) {
  process.stderr.write(`${args.message}\n`)
  process.exit(2)
}

process.stderr.write(`Reactivating the admin via ${grpcTarget}\n`)
try {
  await reactivateAdmin(args.value['user-id'], opsToken)
  process.stdout.write(`Admin ${args.value['user-id']} reactivated; they can sign in again.\n`)
} catch (err) {
  const message =
    err instanceof PreconditionFailedError ? 'the admin is not suspended' : err instanceof Error ? err.message : String(err)
  process.stderr.write(`Failed: ${message}\n`)
  process.exitCode = 1
} finally {
  adminOpsClient.close()
}
