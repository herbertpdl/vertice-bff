import jwt from 'jsonwebtoken'
import { DEV_NODE_ENVS, DEV_SERVICE_JWT_SECRET, env } from '../config/env.js'
import { SERVICE_SUBJECT, TOKEN_ISSUER, type AuthUser } from '../lib/jwt.js'

/**
 * The token the BFF sends to vertice-ai, and the only one. Its own signer on purpose (BFF
 * assessment F7): signed with `SERVICE_JWT_SECRET`, never `JWT_SECRET`, for `aud: "vertice-ai"`,
 * never `vertice-api`. `serviceToken()` in `lib/jwt.ts` must never be sent to vertice-ai: the
 * service most exposed to untrusted text would hold a live vertice-api credential. Neither
 * `verifyToken` (other secret, other audience) nor vertice-api accept this one.
 *
 * Claims (vertice-ai `auth.py`): `iss: "vertice-bff"`, `aud: "vertice-ai"`, `sub: "service:bff"`,
 * `iat`, `exp` 60 seconds later, plus `uid` (the trainer's id, a positive integer) and `role` for
 * attribution only; vertice-ai authorizes nothing from them. Minted per request, not cached: the
 * claims are per user.
 */
export const AI_TOKEN_AUDIENCE = 'vertice-ai'
export const AI_TOKEN_TTL_SECONDS = 60

export function signAiServiceToken(user: Pick<AuthUser, 'id' | 'role'>): string {
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('signAiServiceToken: invalid user id')
  // The env check only runs when VERTICE_AI_URL is set (feature-flags FF2); refuse here too, as the
  // backstop, so a deployment without that check can never sign with the public dev value.
  if (!DEV_NODE_ENVS.includes(env.NODE_ENV) && env.SERVICE_JWT_SECRET === DEV_SERVICE_JWT_SECRET) {
    throw new Error('signAiServiceToken: SERVICE_JWT_SECRET is not configured')
  }
  return jwt.sign({ uid: user.id, role: user.role }, env.SERVICE_JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: AI_TOKEN_TTL_SECONDS,
    issuer: TOKEN_ISSUER,
    audience: AI_TOKEN_AUDIENCE,
    subject: SERVICE_SUBJECT,
  })
}
