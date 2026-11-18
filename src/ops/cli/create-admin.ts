/**
 * Creates an admin (admin-panel spec §2.1, vertice-api `AdminOpsService.CreateAdmin`). Usage:
 *
 *   npm run ops:create-admin -- --name "Ana Souza" --email ana@vertice.fit
 *
 * In production it runs compiled inside the BFF task, through ECS Exec (README "Admin accounts"):
 *
 *   node dist/ops/cli/create-admin.js --name "Ana Souza" --email ana@vertice.fit
 *
 * Prints the new user id and a single-use "Definir senha" link on stdout (a credential: hand it to
 * the admin out of band); progress and errors go to stderr. See the README's "Operations".
 */
import { createAdmin, parseCreateAdminArgs } from '../admin-ops.js'
import { opsToken } from '../ops-token.js'
import { grpcTarget } from '../../config/env.js'
import { adminOpsClient } from '../../grpc/clients.js'

const args = parseCreateAdminArgs(process.argv.slice(2))
if (!args.ok) {
  process.stderr.write(`${args.message}\n`)
  process.exit(2) // nothing written to stdout yet
}

process.stderr.write(`Creating an admin via ${grpcTarget}\n`)
// exitCode, not process.exit(): exiting right away could cut off the link still being flushed.
try {
  const { userId, setupLink, expiresAt } = await createAdmin(args.value, opsToken)
  process.stdout.write(`userId=${userId}\nsetupLink=${setupLink}\nexpiresAt=${expiresAt}\n`)
} catch (err) {
  process.stderr.write(`Failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
} finally {
  adminOpsClient.close()
}
