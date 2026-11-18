import * as userService from '../users/service.js'
import { trainerClientClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'
import { env } from '../../config/env.js'
import { MOBILE_SESSION, signToken, tokenExpiresAt, type AuthUser, type Role } from '../../lib/jwt.js'
import { HttpError, PreconditionFailedError, UnauthorizedError, ValidationError } from '../../lib/errors.js'
import { maskCpf } from '../../lib/cpf.js'
import { PASSWORD_MAX_BYTES } from './schemas.js'

/** The `user` of a login/register response. Name and email are in the body, never in the token. */
export interface SessionUser {
  id: number
  name: string
  email: string
  role: Role
}

export interface Session {
  token: string
  /** When `token` expires (its `exp`), an ISO-8601 instant: 8h out for the web, 90 days for mobile. */
  expiresAt: string
  user: SessionUser
}

/**
 * Which app asks for the session: `mobile` when the request carries `X-Vertice-Client: mobile`
 * (see `sessionClientOf` in routes.ts), `web` otherwise, as every client did before mobile sessions.
 */
export type SessionClient = 'mobile' | 'web'

/**
 * Only trainers and clients use the mobile app (PRD §2); an admin signs in at `POST
 * /admin/auth/login` (admin-panel spec). Until VRT-28 refuses it (403 `ADMIN_LOGIN_ELSEWHERE`),
 * `/auth/login` still signs an ADMIN the plain 8h web token, only so the web can read the role and
 * drop it; `verifyToken` and vertice-api both refuse that token (no `amr`/`auth_time`).
 */
const MOBILE_ROLES: readonly Role[] = ['TRAINER', 'CLIENT']

function session(user: userService.User, client: SessionClient, issuedAt?: number): Session {
  const mobile = client === 'mobile' && MOBILE_ROLES.includes(user.role)
  const token = signToken({ id: user.id, role: user.role, ...(mobile ? { session: MOBILE_SESSION } : {}) }, { issuedAt })
  return {
    token,
    expiresAt: tokenExpiresAt(token),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  }
}

/**
 * Checks the password upstream (`VerifyCredentials`). A wrong password, an unknown email and a
 * user without a password all get the same 401 body.
 *
 * `VERIFY_PASSWORDS=false` (development/test only, see `config/env.ts`) keeps the old
 * email-only login for the rollout window: it finds the user by scanning `ListUsers` and
 * accepts any non-empty password.
 */
export async function login(email: string, password: string, client: SessionClient = 'web'): Promise<Session> {
  if (!env.VERIFY_PASSWORDS) {
    const user = await userService.findUserByEmail(email)
    if (!user) throw new UnauthorizedError(userService.INVALID_CREDENTIALS_MESSAGE)
    return session(user, client)
  }
  // No stored password can be longer (it is vertice-api's policy), and bcrypt would only read
  // the first 72 bytes anyway, so this can only be a wrong password.
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new UnauthorizedError(userService.INVALID_CREDENTIALS_MESSAGE)
  }
  return session(await userService.verifyCredentials(email, password), client)
}

export async function register(input: {
  name: string
  email: string
  password: string
  role: 'TRAINER'
  cpf?: string
  cref?: string
  acceptedTermsVersion: string
}, client: SessionClient = 'web'): Promise<Session> {
  // No pre-check by email: vertice-api's unique email index refuses a duplicate (ALREADY_EXISTS → 409).
  return session(await userService.createUser(input), client)
}

/** The 403 of `POST /auth/session/renew` for a token that is not a mobile session. */
export const NOT_RENEWABLE_MESSAGE = 'Only a mobile session can be renewed'

/**
 * Trades a valid mobile session token for a fresh 90-day one (PRD R3, R4: 90 days since the last
 * use). The caller is the verified token's (`caller`); whether it is renewable is decided from its
 * `session` claim only, never from a request header, so a web token is refused (403
 * `SESSION_NOT_RENEWABLE`) whatever the request says.
 *
 * Before signing, vertice-api must still accept the token: `GetUser` on the caller's own id, sent
 * with that very token. Its `CallerIdentityResolver` refuses a deleted user, a changed role and
 * (once vertice-api ships it) a token issued before the last password change, as
 * `UNAUTHENTICATED`, which `grpcCall` turns into the 401 `UNAUTHENTICATED` clients log out on. So a
 * revoked token is never renewed on the strength of the BFF's own signature check.
 */
export async function renewSession(caller: AuthUser): Promise<Session> {
  if (caller.session !== MOBILE_SESSION) throw new HttpError(403, NOT_RENEWABLE_MESSAGE, 'SESSION_NOT_RENEWABLE')
  // The new token's `iat` is one second before the upstream check started. vertice-api voids
  // tokens issued before a password change's mark (truncated to the second); a change committed
  // just after the check, in the same second as the signing, would otherwise leave this token with
  // `iat` equal to the mark, outliving the change and every later renewal.
  const issuedAt = Math.floor(Date.now() / 1000) - 1
  const user = userService.toUser(await userService.getSelf(caller.id))
  // vertice-api already refuses a mismatch; checked again so nothing but the caller is ever signed.
  if (user.id !== caller.id || user.role !== caller.role) throw new HttpError(401, 'Session no longer valid', 'UNAUTHENTICATED')
  return session(user, 'mobile', issuedAt)
}

/**
 * Changes the caller's own password after re-checking the current one. A wrong current
 * password is a 400, not a 401: clients treat a 401 as "session over" and log out.
 */
export async function changePassword(userId: number, currentPassword: string, newPassword: string): Promise<void> {
  await assertCurrentPassword(userId, currentPassword)
  await userService.setUserPassword(userId, newPassword)
}

/**
 * Re-checks the caller's own password (`VerifyCredentials` on their stored email, with their own
 * token) before a sensitive change of their account. A wrong one is a 400
 * `INVALID_CURRENT_PASSWORD`, not a 401: clients treat a 401 as "session over" and log out.
 */
async function assertCurrentPassword(userId: number, password: string): Promise<void> {
  const invalidCurrent = () => new HttpError(400, 'Current password is incorrect', 'INVALID_CURRENT_PASSWORD')
  // bcrypt reads only the first 72 bytes, and no stored password is longer: this can only be wrong.
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) throw invalidCurrent()
  const { email } = await userService.getUser(userId)
  let verified: userService.User
  try {
    verified = await userService.verifyCredentials(email, password)
  } catch (err) {
    throw err instanceof UnauthorizedError ? invalidCurrent() : err
  }
  if (verified.id !== userId) throw invalidCurrent()
}

export interface UpdateMeInput {
  name?: string
  email?: string
  cpf?: string | null
  cref?: string | null
  whatsapp?: string | null
  instagram?: string | null
  showEmail?: boolean
  showWhatsapp?: boolean
  showInstagram?: boolean
}

/**
 * Corrects the caller's own profile (`PATCH /auth/me`) through `UpdateUser` with their own token.
 * `UpdateUser` replaces every field, so whatever the body omits is read from the self view and
 * sent back; the role is always the stored one. A TRAINER's CPF is required (vertice-api refuses
 * an empty one too; checking here gives the form a clear message), and only a TRAINER has a CREF.
 * Returns the new `Me`; the consent state is the one just read, which a profile update doesn't touch.
 */
export async function updateMe(userId: number, input: UpdateMeInput): Promise<userService.Me> {
  const stored = await userService.getSelf(userId)
  if (stored.role !== 'TRAINER' && input.cref) throw new ValidationError('cref: only a trainer has a CREF')
  const setsContacts =
    !!input.whatsapp || !!input.instagram || !!input.showEmail || !!input.showWhatsapp || !!input.showInstagram
  if (stored.role !== 'TRAINER' && setsContacts) {
    throw new ValidationError('contacts: only a trainer shares contacts with clients')
  }
  const cpf = input.cpf === undefined ? stored.cpf : (input.cpf ?? '')
  if (stored.role === 'TRAINER' && !cpf.trim()) throw new ValidationError('cpf: required for a trainer')
  // Contacts are proto3 `optional`: an omitted key stays absent, so vertice-api keeps the stored value.
  const updated = await userService.updateUserRaw(userId, {
    name: input.name ?? stored.name,
    email: input.email ?? stored.email,
    cpf,
    cref: input.cref === undefined ? stored.cref : (input.cref ?? ''),
    role: stored.role,
    ...(input.whatsapp === undefined ? {} : { whatsapp: input.whatsapp ?? '' }),
    ...(input.instagram === undefined ? {} : { instagram: input.instagram ?? '' }),
    ...(input.showEmail === undefined ? {} : { showEmail: input.showEmail }),
    ...(input.showWhatsapp === undefined ? {} : { showWhatsapp: input.showWhatsapp }),
    ...(input.showInstagram === undefined ? {} : { showInstagram: input.showInstagram }),
  })
  return {
    id: Number(updated.id),
    name: updated.name,
    email: updated.email,
    cpf: maskCpf(updated.cpf),
    cref: updated.cref,
    role: updated.role,
    ...userService.toContacts(updated),
    consent: userService.toConsent(stored.consent),
  }
}

/** The 409 of `DELETE /auth/me` for a TRAINER who still has active clients. */
export const ACTIVE_CLIENTS_MESSAGE = 'End your client relationships before deleting your account'

/**
 * Deletes the caller's own account (`DELETE /auth/me`) once their password checks out, so a
 * stolen session alone can't. vertice-api's only FAILED_PRECONDITION here is a TRAINER with active
 * clients, answered as 409 `ACTIVE_CLIENTS` so the web can point them at their roster.
 */
export async function deleteAccount(userId: number, password: string): Promise<void> {
  await assertCurrentPassword(userId, password)
  try {
    await userService.deleteAccount()
  } catch (err) {
    if (err instanceof PreconditionFailedError) throw new HttpError(409, ACTIVE_CLIENTS_MESSAGE, 'ACTIVE_CLIENTS')
    throw err
  }
}

/**
 * First access: sets the password with a setup token. An unknown, expired or used token is a
 * 400 `INVALID_SETUP_TOKEN` rather than the upstream 401, which clients read as a logout.
 */
export async function setupPassword(token: string, newPassword: string): Promise<userService.RedeemedSetup> {
  try {
    return await userService.redeemPasswordSetupToken(token, newPassword)
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 401) {
      throw new HttpError(400, 'Invalid or expired password setup link', 'INVALID_SETUP_TOKEN')
    }
    throw err
  }
}

export interface ClientTrainer {
  name: string
  email: string
  whatsapp: string
  instagram: string
}

/** The caller's (a CLIENT's) active trainer with the contacts they show (`GetClientTrainer`). */
export async function getMyTrainer(clientId: number): Promise<ClientTrainer> {
  const res = await grpcCall<
    { clientId: number },
    { trainerId: string; name: string; email: string; whatsapp: string; instagram: string }
  >(trainerClientClient, 'GetClientTrainer', { clientId })
  return { name: res.name, email: res.email, whatsapp: res.whatsapp, instagram: res.instagram }
}
