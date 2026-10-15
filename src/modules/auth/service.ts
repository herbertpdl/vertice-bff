import * as userService from '../users/service.js'
import { env } from '../../config/env.js'
import { signToken, type Role } from '../../lib/jwt.js'
import { HttpError, UnauthorizedError } from '../../lib/errors.js'
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
  user: SessionUser
}

function session(user: userService.User): Session {
  return {
    token: signToken({ id: user.id, role: user.role }),
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
export async function login(email: string, password: string): Promise<Session> {
  if (!env.VERIFY_PASSWORDS) {
    const user = await userService.findUserByEmail(email)
    if (!user) throw new UnauthorizedError(userService.INVALID_CREDENTIALS_MESSAGE)
    return session(user)
  }
  // No stored password can be longer (it is vertice-api's policy), and bcrypt would only read
  // the first 72 bytes anyway, so this can only be a wrong password.
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw new UnauthorizedError(userService.INVALID_CREDENTIALS_MESSAGE)
  }
  return session(await userService.verifyCredentials(email, password))
}

export async function register(input: {
  name: string
  email: string
  password: string
  role: 'TRAINER'
  cpf?: string
  cref?: string
  acceptedTermsVersion: string
}): Promise<Session> {
  // No pre-check by email: vertice-api's unique email index refuses a duplicate (ALREADY_EXISTS → 409).
  return session(await userService.createUser(input))
}

/**
 * Changes the caller's own password after re-checking the current one. A wrong current
 * password is a 400, not a 401: clients treat a 401 as "session over" and log out.
 */
export async function changePassword(userId: number, currentPassword: string, newPassword: string): Promise<void> {
  const invalidCurrent = () => new HttpError(400, 'Current password is incorrect', 'INVALID_CURRENT_PASSWORD')
  const { email } = await userService.getUser(userId)
  let verified: userService.User
  try {
    verified = await userService.verifyCredentials(email, currentPassword)
  } catch (err) {
    throw err instanceof UnauthorizedError ? invalidCurrent() : err
  }
  if (verified.id !== userId) throw invalidCurrent()
  await userService.setUserPassword(userId, newPassword)
}

/**
 * First access: sets the password with a setup token. An unknown, expired or used token is a
 * 400 `INVALID_SETUP_TOKEN` rather than the upstream 401, which clients read as a logout.
 */
export async function setupPassword(token: string, newPassword: string): Promise<void> {
  try {
    await userService.setPasswordWithToken(token, newPassword)
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 401) {
      throw new HttpError(400, 'Invalid or expired password setup link', 'INVALID_SETUP_TOKEN')
    }
    throw err
  }
}
