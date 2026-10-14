import { userClient } from '../../grpc/clients.js'
import { grpcCall } from '../../grpc/call.js'
import { HttpError, UnauthorizedError } from '../../lib/errors.js'

export type Role = 'ADMIN' | 'TRAINER' | 'CLIENT'

export interface User {
  id: number
  name: string
  email: string
  cpf: string
  cref: string
  role: Role
}

export interface UserResponse {
  id: string
  name: string
  email: string
  cpf: string
  cref: string
  role: Role
}

export function toUser(r: UserResponse): User {
  return { id: Number(r.id), name: r.name, email: r.email, cpf: r.cpf, cref: r.cref, role: r.role }
}

export async function listUsers(role?: Role): Promise<User[]> {
  const res = await grpcCall<{ role: string }, { users: UserResponse[] }>(userClient, 'ListUsers', {
    role: role ?? 'ROLE_UNSPECIFIED',
  })
  return res.users.map(toUser)
}

export async function getUser(id: number): Promise<User> {
  const res = await grpcCall<{ id: number }, UserResponse>(userClient, 'GetUser', { id })
  return toUser(res)
}

/**
 * Loads every user to find one email. Only the `VERIFY_PASSWORDS=false` rollout path of login
 * still uses it; everything else goes through `verifyCredentials`.
 */
export async function findUserByEmail(email: string): Promise<User | undefined> {
  const users = await listUsers()
  return users.find((u) => u.email.toLowerCase() === email.toLowerCase())
}

/** The same message for every failure, so it never says whether the email exists. */
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password'

/**
 * Checks an email/password pair upstream (`VerifyCredentials`, bcrypt + a dummy compare for an
 * unknown email). Every refusal becomes the same `UnauthorizedError`.
 */
export async function verifyCredentials(email: string, password: string): Promise<User> {
  try {
    const res = await grpcCall<{ email: string; password: string }, UserResponse>(userClient, 'VerifyCredentials', {
      email,
      password,
    })
    return toUser(res)
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 401) throw new UnauthorizedError(INVALID_CREDENTIALS_MESSAGE)
    throw err
  }
}

/** Users who never set a password (e.g. trainer-created clients since password setup tokens). */
export async function listUsersWithoutPassword(role?: Role): Promise<User[]> {
  const res = await grpcCall<{ role: string }, { users: UserResponse[] }>(userClient, 'ListUsersWithoutPassword', {
    role: role ?? 'ROLE_UNSPECIFIED',
  })
  return res.users.map(toUser)
}

export interface PasswordSetupToken {
  /** Raw single-use token (URL-safe); upstream only stores its hash, so this is the one chance to read it. */
  token: string
  /** ISO-8601 instant after which the token is rejected (72h after issue by default). */
  expiresAt: string
}

/** Issues a first-access token; any earlier unused token of the user stops working. */
export async function createPasswordSetupToken(userId: number): Promise<PasswordSetupToken> {
  const res = await grpcCall<{ userId: number }, { token: string; expiresAt: string }>(
    userClient,
    'CreatePasswordSetupToken',
    { userId },
  )
  return { token: res.token, expiresAt: res.expiresAt }
}

/** Sets the password of the token's user and consumes the token. A bad token rejects with a 401 HttpError. */
export async function setPasswordWithToken(token: string, password: string): Promise<void> {
  await grpcCall(userClient, 'SetPasswordWithToken', { token, password })
}

export interface UserCreateInput {
  name: string
  email: string
  password: string
  cpf?: string
  cref?: string
  role: Role
}

export async function createUser(input: UserCreateInput): Promise<User> {
  const res = await grpcCall<UserCreateInput, UserResponse>(userClient, 'CreateUser', {
    ...input,
    cpf: input.cpf ?? '',
    cref: input.cref ?? '',
  })
  return toUser(res)
}

export interface UserUpdateInput {
  name: string
  email: string
  cpf?: string
  cref?: string
  role: Role
}

export async function updateUser(id: number, input: UserUpdateInput): Promise<User> {
  const res = await grpcCall<{ id: number; user: UserUpdateInput }, UserResponse>(userClient, 'UpdateUser', {
    id,
    user: { ...input, cpf: input.cpf ?? '', cref: input.cref ?? '' },
  })
  return toUser(res)
}

export async function deleteUser(id: number): Promise<void> {
  await grpcCall(userClient, 'DeleteUser', { id })
}

export async function setUserPassword(id: number, password: string): Promise<void> {
  await grpcCall(userClient, 'SetUserPassword', { id, password })
}
