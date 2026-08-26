import * as userService from '../users/service.js'
import { signToken, type AuthUser } from '../../lib/jwt.js'
import { UnauthorizedError, ConflictError } from '../../lib/errors.js'

/**
 * KNOWN MVP GAP: vertice-api's UserService (see user.proto) exposes no RPC to
 * verify a password — CreateUser/SetUserPassword are write-only, and
 * UserResponse never carries the hash. Until vertice-api grows a real
 * Login/VerifyPassword RPC, the BFF can only confirm the email exists and
 * trusts any non-empty password. This is NOT secure — fine for local MVP
 * testing, not for anything beyond that.
 */
export async function login(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  if (!password) throw new UnauthorizedError('Password is required')

  const user = await userService.findUserByEmail(email)
  if (!user) throw new UnauthorizedError('Invalid email or password')

  const authUser: AuthUser = { id: user.id, name: user.name, email: user.email, role: user.role }
  return { token: signToken(authUser), user: authUser }
}

export async function register(input: {
  name: string
  email: string
  password: string
  role: 'TRAINER' | 'CLIENT'
  cpf?: string
  cref?: string
}): Promise<{ token: string; user: AuthUser }> {
  const existing = await userService.findUserByEmail(input.email)
  if (existing) throw new ConflictError('Email already registered')

  const user = await userService.createUser(input)
  const authUser: AuthUser = { id: user.id, name: user.name, email: user.email, role: user.role }
  return { token: signToken(authUser), user: authUser }
}
