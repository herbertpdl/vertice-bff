import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export type Role = 'ADMIN' | 'TRAINER' | 'CLIENT'

const ROLES: readonly Role[] = ['ADMIN', 'TRAINER', 'CLIENT']

/**
 * What a verified user token carries, and all `req.user` holds. Name and email are not in the
 * token (it would put PII wherever the token is stored or logged); read them from `/auth/me`.
 */
export interface AuthUser {
  id: number
  role: Role
}

// Pinned on both sides so a token signed with any other algorithm (or `none`) is rejected,
// and so the BFF stays in step with vertice-api, which only verifies HS256.
const ALGORITHM = 'HS256' satisfies jwt.Algorithm

/**
 * Every token the BFF mints is scoped: issued by the BFF, for vertice-api. vertice-api is the
 * authoritative layer and will require both (P1-01); the BFF requires them on its own tokens too.
 */
export const TOKEN_ISSUER = 'vertice-bff'
export const TOKEN_AUDIENCE = 'vertice-api'

/** Identity of the BFF itself, for upstream calls made without a user (see `serviceToken`). */
export const SERVICE_SUBJECT = 'service:bff'
export const SERVICE_ROLE = 'SERVICE'
export const SERVICE_TOKEN_TTL_SECONDS = 60
/** A cached service token is replaced once it has less than this left, so none expires in flight. */
const SERVICE_TOKEN_MIN_REMAINING_SECONDS = 15

/**
 * User token claims: `sub` (the user id as a string, the standard subject, which vertice-api reads)
 * and `role`, plus `iss`/`aud`/`iat`/`exp`.
 */
export function signToken(user: AuthUser): string {
  return jwt.sign({ role: user.role }, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
    subject: String(user.id),
  })
}

/**
 * Verifies a user token: HS256, this issuer and audience, not expired, and shaped like a user
 * (an `exp`, a `sub` that is a positive integer in canonical decimal form, a user role). The
 * service token fails the `sub` check, so it can never authenticate a REST request.
 *
 * Tokens minted before `id` was dropped still carry it; they are accepted only when `id` equals
 * `sub` (the rule vertice-api applies), and stop existing once `JWT_EXPIRES_IN` has passed.
 */
export function verifyToken(token: string): AuthUser {
  const payload = jwt.verify(token, env.JWT_SECRET, {
    algorithms: [ALGORITHM],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  })
  if (typeof payload === 'string') throw new jwt.JsonWebTokenError('jwt payload must be an object')
  const { role, sub, exp } = payload
  if (typeof exp !== 'number') throw new jwt.JsonWebTokenError('jwt exp required')
  const id = typeof sub === 'string' && /^[1-9][0-9]*$/.test(sub) ? Number(sub) : NaN
  if (!Number.isSafeInteger(id)) throw new jwt.JsonWebTokenError('jwt subject invalid')
  if ('id' in payload && payload.id !== id) throw new jwt.JsonWebTokenError('jwt subject invalid')
  if (!ROLES.includes(role)) throw new jwt.JsonWebTokenError('jwt role invalid')
  return { id, role }
}

let cachedServiceToken: { token: string; issuedAtMs: number; expiresAtMs: number } | undefined

/**
 * Short-lived token the BFF sends upstream when no user is behind the call (login, register,
 * password setup, ops scripts): `sub: "service:bff"`, `role: "SERVICE"`, scoped like user tokens.
 * Cached and reused until it gets close to expiry.
 */
export function serviceToken(): string {
  const now = Date.now()
  if (
    cachedServiceToken &&
    now >= cachedServiceToken.issuedAtMs && // the clock went back: re-mint rather than send a future iat
    cachedServiceToken.expiresAtMs - now > SERVICE_TOKEN_MIN_REMAINING_SECONDS * 1000
  ) {
    return cachedServiceToken.token
  }
  const iat = Math.floor(now / 1000)
  const token = jwt.sign({ role: SERVICE_ROLE, iat }, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: SERVICE_TOKEN_TTL_SECONDS,
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
    subject: SERVICE_SUBJECT,
  })
  cachedServiceToken = { token, issuedAtMs: iat * 1000, expiresAtMs: (iat + SERVICE_TOKEN_TTL_SECONDS) * 1000 }
  return token
}
