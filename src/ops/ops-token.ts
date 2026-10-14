import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from '../lib/jwt.js'

/**
 * Identity of the ops scripts under `scripts/`, separate from the running BFF's `service:bff`:
 * they need RPCs the server must never call without a user (listing every user, issuing a
 * password setup token for anyone). Minted only inside a script process; nothing under
 * `src/` outside `src/ops/` imports this module.
 */
export const OPS_SUBJECT = 'service:ops'
export const OPS_ROLE = 'SERVICE'
export const OPS_TOKEN_TTL_SECONDS = 60

/** The only RPCs vertice-api allows `service:ops` on: what `issue-setup-tokens` needs. */
export const OPS_TOKEN_RPCS: ReadonlySet<string> = new Set(['ListUsers', 'CreatePasswordSetupToken'])

/** A fresh short-lived ops token. Cheap (one HMAC), so scripts mint one per call. */
export function opsToken(): string {
  return jwt.sign({ role: OPS_ROLE }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: OPS_TOKEN_TTL_SECONDS,
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
    subject: OPS_SUBJECT,
  })
}
