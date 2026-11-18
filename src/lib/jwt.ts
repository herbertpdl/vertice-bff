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
  /**
   * Set only on a mobile session token (`session: "mobile"` claim, see `signToken`): the 90-day
   * token the mobile app gets and may renew (`POST /auth/session/renew`). Absent on a web token.
   */
  session?: typeof MOBILE_SESSION
  /**
   * Set only on an admin token (`role: ADMIN`, see `signAdminToken`): the sign-in instant, seconds
   * since the epoch (`auth_time`). Renewal keeps it, so the 12h cap counts from the sign-in.
   */
  authTime?: number
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
 * The `session` claim's one value, and the only kind of token `POST /auth/session/renew` renews.
 * vertice-api ignores the claim (it reads `sub` and `role`); it is the BFF's own marker. Changing
 * its name or value is a cross-repo change all the same (CLAUDE.md, "Trust model").
 */
export const MOBILE_SESSION = 'mobile'
/** A mobile session's lifetime: 90 days from its issue, restarted by every renewal (PRD R3, R4). */
export const MOBILE_SESSION_TTL_SECONDS = 90 * 24 * 60 * 60

/**
 * Admin sessions (admin-panel spec B2-B4, vertice-api D6/D7). Constants, not env: vertice-api
 * checks the same bounds (`exp - iat` at most 30 minutes, at most 12h since `auth_time`), so a
 * configurable value could only make the BFF sign tokens the API refuses.
 */
export const ADMIN_SESSION_TTL_SECONDS = 30 * 60
export const ADMIN_SESSION_MAX_SECONDS = 12 * 60 * 60
export const ADMIN_CHALLENGE_TTL_SECONDS = 5 * 60
/**
 * The challenge's audience. Not `vertice-api`: `verifyToken` and vertice-api's decoder both
 * require that one, so a challenge authenticates no REST route and no RPC.
 */
export const ADMIN_CHALLENGE_AUDIENCE = 'vertice-bff:admin-challenge'
/** The challenge's `token_use`, a second marker beside the audience. */
export const ADMIN_CHALLENGE_USE = 'admin_challenge'
/** RFC 8176 methods: the password, then the authenticator code. vertice-api requires `"otp"`. */
export const ADMIN_AMR = ['pwd', 'otp'] as const

/**
 * User token claims: `sub` (the user id as a string, the standard subject, which vertice-api reads)
 * and `role`, plus `iss`/`aud`/`iat`/`exp`. A mobile session (`user.session === "mobile"`) also
 * carries `session: "mobile"` and expires after `MOBILE_SESSION_TTL_SECONDS`; any other token
 * expires after `JWT_EXPIRES_IN` (8h) and has no `session` claim. `issuedAt` overrides `iat`
 * (renewal backdates it, see `renewSession`).
 */
export function signToken(user: AuthUser, options: { issuedAt?: number } = {}): string {
  // An admin's only session is `signAdminToken`'s, after the second factor (admin-panel spec B3,
  // B9): `/auth/login` refuses an ADMIN before signing, so this would be a bug, not a login.
  if (user.role === 'ADMIN') throw new Error('signToken: an ADMIN token is signed only by signAdminToken')
  const mobile = user.session === MOBILE_SESSION
  const claims = mobile ? { role: user.role, session: MOBILE_SESSION } : { role: user.role }
  // An explicit `iat` (seconds) also moves `exp`, which jsonwebtoken derives from the payload's `iat`.
  const payload = options.issuedAt === undefined ? claims : { ...claims, iat: options.issuedAt }
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: mobile ? MOBILE_SESSION_TTL_SECONDS : (env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn']),
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
 *
 * A `session` claim, when present, must be `"mobile"`; the result then says so. A token without
 * one is a web (8h) session, as every token issued before mobile sessions existed.
 */
export function verifyToken(token: string): AuthUser {
  const payload = jwt.verify(token, env.JWT_SECRET, {
    algorithms: [ALGORITHM],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  })
  if (typeof payload === 'string') throw new jwt.JsonWebTokenError('jwt payload must be an object')
  const { role, sub, exp, session } = payload
  if (typeof exp !== 'number') throw new jwt.JsonWebTokenError('jwt exp required')
  const id = subjectId(sub)
  if ('id' in payload && payload.id !== id) throw new jwt.JsonWebTokenError('jwt subject invalid')
  if (!ROLES.includes(role)) throw new jwt.JsonWebTokenError('jwt role invalid')
  if (session !== undefined && session !== MOBILE_SESSION) throw new jwt.JsonWebTokenError('jwt session invalid')
  if (role === 'ADMIN') {
    if (session !== undefined) throw new jwt.JsonWebTokenError('jwt admin session invalid')
    return { id, role, authTime: adminAuthTime(payload) }
  }
  return session === MOBILE_SESSION ? { id, role, session } : { id, role }
}

/** A `sub` that is a user id: a positive integer in canonical decimal form, within the safe integers. */
function subjectId(sub: unknown): number {
  const id = typeof sub === 'string' && /^[1-9][0-9]*$/.test(sub) ? Number(sub) : NaN
  if (!Number.isSafeInteger(id)) throw new jwt.JsonWebTokenError('jwt subject invalid')
  return id
}

/**
 * vertice-api's D6 checks on a `role: ADMIN` token, applied here too so a BFF signing bug fails in
 * the BFF: `amr` contains `"otp"`; `auth_time` (NumericDate) present and not after `iat`; now at
 * most 12h after `auth_time`; `exp - iat` at most 30 minutes. Any other ADMIN token (the 8h one
 * `POST /auth/login` still signs until VRT-28) is refused. Returns `auth_time`.
 */
function adminAuthTime(payload: jwt.JwtPayload): number {
  const { amr, auth_time: authTime, iat, exp } = payload
  const invalid = () => new jwt.JsonWebTokenError('jwt admin second factor invalid')
  if (!Array.isArray(amr) || !amr.includes('otp')) throw invalid()
  if (!Number.isSafeInteger(authTime) || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) throw invalid()
  if (authTime > iat!) throw invalid()
  if (Date.now() / 1000 > authTime + ADMIN_SESSION_MAX_SECONDS) throw invalid()
  if (exp! - iat! > ADMIN_SESSION_TTL_SECONDS) throw invalid()
  return authTime
}

/**
 * The admin token (admin-panel spec B3, B4): `role: ADMIN`, `amr: ["pwd", "otp"]`, `auth_time`,
 * `iat = issuedAt`, `exp = min(iat + 30 min, auth_time + 12h)`. The only signer that adds `amr` and
 * `auth_time`. Sign-in passes `issuedAt = authTime`; renewal passes `max(floor(now) - 1, authTime)`.
 * Throws rather than sign a token vertice-api would refuse (`iat` before `auth_time`, or nothing
 * left before the 12h cap).
 */
export function signAdminToken({ id, authTime, issuedAt }: { id: number; authTime: number; issuedAt: number }): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('signAdminToken: invalid id')
  if (!Number.isSafeInteger(authTime) || !Number.isSafeInteger(issuedAt) || issuedAt < authTime) {
    throw new Error('signAdminToken: iat must be an integer not before auth_time')
  }
  const exp = Math.min(issuedAt + ADMIN_SESSION_TTL_SECONDS, authTime + ADMIN_SESSION_MAX_SECONDS)
  if (exp <= issuedAt) throw new Error('signAdminToken: the admin session is past its 12h cap')
  // `exp` in the payload, not `expiresIn`: jsonwebtoken refuses both, and this one is computed.
  return jwt.sign({ role: 'ADMIN', amr: [...ADMIN_AMR], auth_time: authTime, iat: issuedAt, exp }, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
    subject: String(id),
  })
}

/** When an admin session ends at the latest (`auth_time + 12h`), as an ISO-8601 instant. */
export const adminSessionEndsAt = (authTime: number) =>
  new Date((authTime + ADMIN_SESSION_MAX_SECONDS) * 1000).toISOString()

/**
 * The admin challenge (admin-panel spec B2): what the password step returns, and the only thing
 * enroll and verify accept. `aud: "vertice-bff:admin-challenge"`, `token_use: "admin_challenge"`,
 * `amr: ["pwd"]`, no `role`, 5 minutes. Stateless and reusable until it expires; a replayed one
 * still needs a fresh code, which vertice-api accepts once per time step. Never sent upstream.
 */
export function signAdminChallenge(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('signAdminChallenge: invalid id')
  return jwt.sign({ token_use: ADMIN_CHALLENGE_USE, amr: ['pwd'] }, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: ADMIN_CHALLENGE_TTL_SECONDS,
    issuer: TOKEN_ISSUER,
    audience: ADMIN_CHALLENGE_AUDIENCE,
    subject: String(id),
  })
}

/** Verifies an admin challenge and returns the admin's id. Throws on anything else, a user token included. */
export function verifyAdminChallenge(token: string): { id: number } {
  const payload = jwt.verify(token, env.JWT_SECRET, {
    algorithms: [ALGORITHM],
    issuer: TOKEN_ISSUER,
    audience: ADMIN_CHALLENGE_AUDIENCE,
  })
  if (typeof payload === 'string') throw new jwt.JsonWebTokenError('jwt payload must be an object')
  if (typeof payload.exp !== 'number') throw new jwt.JsonWebTokenError('jwt exp required')
  if (payload.token_use !== ADMIN_CHALLENGE_USE || 'role' in payload) {
    throw new jwt.JsonWebTokenError('jwt is not an admin challenge')
  }
  return { id: subjectId(payload.sub) }
}

/** When a token this BFF signed expires, as an ISO-8601 instant (its `exp`). */
export function tokenExpiresAt(token: string): string {
  const payload = jwt.decode(token)
  if (!payload || typeof payload === 'string' || typeof payload.exp !== 'number') {
    throw new Error('token has no exp')
  }
  return new Date(payload.exp * 1000).toISOString()
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
