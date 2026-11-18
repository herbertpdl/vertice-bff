/**
 * Suspends an admin (vertice-api `AdminOpsService.SuspendAdmin`, admin-panel R14): every session
 * of theirs ends at the next call, and their sign-in answers 403 `ACCOUNT_SUSPENDED` until
 * `ops:reactivate-admin`. The admin panel cannot suspend an admin; this is the only path.
 * Usage:
 *
 *   npm run ops:suspend-admin -- --user-id 42
 */
import { suspendAdmin, parseUserIdArgs } from '../src/ops/admin-ops.js'
import { opsToken } from '../src/ops/ops-token.js'
import { grpcTarget } from '../src/config/env.js'
import { adminOpsClient } from '../src/grpc/clients.js'
import { PreconditionFailedError } from '../src/lib/errors.js'

const args = parseUserIdArgs(process.argv.slice(2), 'ops:suspend-admin')
if (!args.ok) {
  process.stderr.write(`${args.message}\n`)
  process.exit(2)
}

process.stderr.write(`Suspending the admin via ${grpcTarget}\n`)
try {
  await suspendAdmin(args.value['user-id'], opsToken)
  process.stdout.write(`Admin ${args.value['user-id']} suspended; their sessions have ended.\n`)
} catch (err) {
  const message =
    err instanceof PreconditionFailedError ? 'the admin is already suspended' : err instanceof Error ? err.message : String(err)
  process.stderr.write(`Failed: ${message}\n`)
  process.exitCode = 1
} finally {
  adminOpsClient.close()
}
