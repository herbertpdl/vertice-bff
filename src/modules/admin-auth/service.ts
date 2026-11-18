import { Metadata } from '@grpc/grpc-js'
import { adminAuthClient, userClient } from '../../grpc/clients.js'
import { grpcCall, SESSION_INVALID_MESSAGE } from '../../grpc/call.js'
import {
  ForbiddenError,
  HttpError,
  PreconditionFailedError,
  TooManyRequestsError,
  UnauthorizedError,
  UpstreamExhaustedError,
} from '../../lib/errors.js'
import {
  adminSessionEndsAt,
  signAdminChallenge,
  signAdminToken,
  tokenExpiresAt,
  verifyAdminChallenge,
  type AuthUser,
} from '../../lib/jwt.js'
import * as userService from '../users/service.js'
import type { SessionUser } from '../auth/service.js'
import { PASSWORD_MAX_BYTES } from '../auth/schemas.js'

/**
 * Admin sign-in (admin-panel spec B1-B4, B8, B11, B14): password, then challenge, then the
 * authenticator code, then a 30-minute admin token renewed up to 12h after the sign-in. The code
 * check, its replay protection and the 5-failure lock are vertice-api's (`AdminAuthService`); the
 * BFF relays the code and signs only after vertice-api accepted it.
 *
 * This is the only module that sends the `AdminAuthService` RPCs, and the only one that may send
 * them with the BFF's service token (`SERVICE_TOKEN_RPCS`), always for the id of a matched admin
 * password or a valid challenge (pinned by a source scan in `route-authorization.test.ts`).
 */

/** Why an admin sign-in step failed: the `reason` of the `admin.signin` log line (spec §4, VRT-19's alarm). */
export type SigninReason =
  | 'invalid_credentials'
  | 'suspended'
  | 'invalid_request'
  | 'invalid_challenge'
  | 'invalid_code'
  | 'locked'
  | 'not_enrolled'
  | 'already_enrolled'
  | 'rate_limited'

/**
 * What a sign-in step learned, for its log line: the admin's id once known (a matched password or
 * a valid challenge) and why it failed. The service fills it before it returns or throws.
 */
export interface SigninTrace {
  userId?: number
  reason?: SigninReason
}

/** The second-factor state, without vertice-api's enum prefix. */
export type SecondFactorState = 'ENROLLED' | 'NOT_ENROLLED'

/** `POST /admin/auth/login`'s answer: a challenge, never a session. */
export interface AdminChallenge {
  challenge: string
  /** When `challenge` expires (5 minutes out), an ISO-8601 instant. */
  challengeExpiresAt: string
  /** `NOT_ENROLLED`: enroll, then verify. `ENROLLED`: verify. */
  secondFactor: SecondFactorState
}

export interface AdminEnrollment {
  /** The `otpauth://` URI (it contains the secret): render it as a QR code in-process, never log it. */
  provisioningUri: string
}

export interface AdminSession {
  token: string
  /** When `token` expires (its `exp`): at most 30 minutes out, never after `sessionEndsAt`. */
  expiresAt: string
  /** The sign-in's hard cap (`auth_time + 12h`); renewal never moves it. */
  sessionEndsAt: string
  user: SessionUser
}

export const CHALLENGE_INVALID_MESSAGE = 'Sign-in challenge is invalid or expired'
export const INVALID_SECOND_FACTOR_CODE_MESSAGE = 'Invalid second-factor code'
export const SECOND_FACTOR_LOCKED_MESSAGE = 'Too many second-factor attempts, try again later'
/** `Retry-After` for a lock whose upstream text has no seconds. */
const DEFAULT_LOCK_RETRY_SECONDS = 60

const asService = { asService: true } as const

function challengeInvalid(trace: SigninTrace): HttpError {
  trace.reason = 'invalid_challenge'
  return new HttpError(401, CHALLENGE_INVALID_MESSAGE, 'CHALLENGE_INVALID')
}

/** The challenge's admin id, or 401 `CHALLENGE_INVALID` (missing, malformed, expired, another audience). */
function challengeUser(challenge: string, trace: SigninTrace): number {
  let id: number
  try {
    id = verifyAdminChallenge(challenge).id
  } catch {
    throw challengeInvalid(trace)
  }
  trace.userId = id
  return id
}

/**
 * Checks the password with `VerifyCredentials { required_role: ADMIN }`, so a trainer's or a
 * client's correct password fails exactly like a wrong one (B8: same 401 body, same code path, and
 * no `userId` in the log line), then reads whether the admin has an authenticator yet. Never the
 * `VERIFY_PASSWORDS=false` email-only path.
 */
export async function login(email: string, password: string, trace: SigninTrace): Promise<AdminChallenge> {
  const invalid = () => {
    trace.reason = 'invalid_credentials'
    return new UnauthorizedError(userService.INVALID_CREDENTIALS_MESSAGE)
  }
  // No stored password is longer (and bcrypt reads 72 bytes): this can only be wrong, as on /auth/login.
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) throw invalid()
  let user: userService.User
  try {
    user = await userService.verifyCredentials(email, password, 'ADMIN')
  } catch (err) {
    if (err instanceof UnauthorizedError) throw invalid()
    // "Account suspended" (vertice-api VRT-27): the generic 409 until VRT-28 maps it.
    if (err instanceof PreconditionFailedError) trace.reason = 'suspended'
    throw err
  }
  // vertice-api already refused any other role; checked again so only an admin gets a challenge.
  if (user.role !== 'ADMIN') throw invalid()
  let state: string
  try {
    ;({ state } = await grpcCall<{ userId: number }, { state: string }>(
      adminAuthClient,
      'GetSecondFactorState',
      { userId: user.id },
      asService,
    ))
  } catch (err) {
    // Not a non-deleted ADMIN any more (a race with a role change or a deletion): as a wrong password.
    if (err instanceof ForbiddenError) throw invalid()
    throw err
  }
  trace.userId = user.id
  const challenge = signAdminChallenge(user.id)
  return {
    challenge,
    challengeExpiresAt: tokenExpiresAt(challenge),
    secondFactor: state === 'SECOND_FACTOR_STATE_ENROLLED' ? 'ENROLLED' : 'NOT_ENROLLED',
  }
}

/**
 * Starts (or restarts) enrolment: a new secret each call, returned once inside the provisioning
 * URI (B14). An admin who already has an authenticator gets vertice-api's FAILED_PRECONDITION, the
 * generic 409 `PRECONDITION_FAILED` (go to the code step).
 */
export async function startEnrollment(challenge: string, trace: SigninTrace): Promise<AdminEnrollment> {
  const userId = challengeUser(challenge, trace)
  let provisioningUri: string
  try {
    ;({ provisioningUri } = await grpcCall<{ userId: number }, { provisioningUri: string }>(
      adminAuthClient,
      'StartSecondFactorEnrollment',
      { userId },
      asService,
    ))
  } catch (err) {
    if (err instanceof ForbiddenError) throw challengeInvalid(trace)
    if (err instanceof PreconditionFailedError) trace.reason = 'already_enrolled'
    throw err
  }
  if (typeof provisioningUri !== 'string' || !provisioningUri.startsWith('otpauth://')) {
    throw new HttpError(502, 'Upstream error', 'UPSTREAM_ERROR')
  }
  return { provisioningUri }
}

/**
 * Checks the code with `VerifySecondFactor` and, only on success, signs the admin token with
 * `iat = auth_time = floor(now) - 1` (the renewal's one-second backdate, so a password change or a
 * 2FA reset committed in this second still voids it). Then `GetUser` on self with that new token
 * proves vertice-api accepts it (D6) and gives the name and email.
 */
export async function verify(challenge: string, code: string, trace: SigninTrace): Promise<AdminSession> {
  const userId = challengeUser(challenge, trace)
  try {
    await grpcCall<{ userId: number; code: string }, { enrolledNow: boolean }>(
      adminAuthClient,
      'VerifySecondFactor',
      { userId, code },
      asService,
    )
  } catch (err) {
    // Wrong, reused or out-of-window: a 400, not a 401, which every client reads as "session over".
    if (err instanceof HttpError && err.code === 'UNAUTHENTICATED') {
      trace.reason = 'invalid_code'
      throw new HttpError(400, INVALID_SECOND_FACTOR_CODE_MESSAGE, 'INVALID_SECOND_FACTOR_CODE')
    }
    if (err instanceof ForbiddenError) throw challengeInvalid(trace)
    // No confirmed or pending secret (reset since the password step): start again.
    if (err instanceof PreconditionFailedError) trace.reason = 'not_enrolled'
    // vertice-api's lock after 5 failures: wait the seconds its text names.
    if (err instanceof UpstreamExhaustedError) {
      trace.reason = 'locked'
      throw new TooManyRequestsError(SECOND_FACTOR_LOCKED_MESSAGE, err.retryAfterSeconds ?? DEFAULT_LOCK_RETRY_SECONDS)
    }
    throw err
  }
  const authTime = Math.floor(Date.now() / 1000) - 1
  const token = signAdminToken({ id: userId, authTime, issuedAt: authTime })
  const metadata = new Metadata()
  metadata.set('authorization', `Bearer ${token}`)
  let user: userService.User
  try {
    user = userService.toUser(await grpcCall<{ id: number }, userService.UserResponse>(userClient, 'GetUser', { id: userId }, { metadata }))
  } catch (err) {
    // Suspended, reset or re-roled since the code was accepted: start again.
    if (err instanceof HttpError && err.code === 'UNAUTHENTICATED') throw challengeInvalid(trace)
    throw err
  }
  if (user.id !== userId || user.role !== 'ADMIN') throw challengeInvalid(trace)
  return adminSession(token, authTime, user)
}

/**
 * Sliding renewal (B4): `GetUser` on self with the current admin token first, so vertice-api
 * re-checks suspension, a password change, the role and the 12h cap (D7); then a new token with the
 * same `auth_time`, `iat = max(floor(now) - 1, auth_time)` and
 * `exp = min(iat + 30 min, auth_time + 12h)`. The old token stays valid until its own `exp`.
 */
export async function renew(caller: AuthUser): Promise<AdminSession> {
  if (caller.role !== 'ADMIN' || caller.authTime === undefined) throw new UnauthorizedError('Invalid or expired token')
  const { authTime } = caller
  // Before the upstream check: a password change committed during it still voids the new token.
  const issuedAt = Math.max(Math.floor(Date.now() / 1000) - 1, authTime)
  const user = userService.toUser(await userService.getSelf(caller.id))
  if (user.id !== caller.id || user.role !== 'ADMIN') throw new HttpError(401, SESSION_INVALID_MESSAGE, 'UNAUTHENTICATED')
  return adminSession(signAdminToken({ id: caller.id, authTime, issuedAt }), authTime, user)
}

function adminSession(token: string, authTime: number, user: userService.User): AdminSession {
  return {
    token,
    expiresAt: tokenExpiresAt(token),
    sessionEndsAt: adminSessionEndsAt(authTime),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  }
}
