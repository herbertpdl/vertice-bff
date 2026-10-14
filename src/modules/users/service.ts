import { userClient } from '../../grpc/clients.js'
import { grpcCall, type GrpcCallOptions } from '../../grpc/call.js'
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

/** `GET /auth/me`: the caller's own account, without their CPF (no screen shows it, P1-03). */
export interface Me {
  id: number
  name: string
  email: string
  cref: string
  role: Role
}

export function toMe(user: User): Me {
  return { id: user.id, name: user.name, email: user.email, cref: user.cref, role: user.role }
}

export interface UserPage {
  users: User[]
  /** Pass back as `pageToken` for the next page; empty on the last page. Opaque. */
  nextPageToken: string
}

/** vertice-api's `ListUsers` page cap (and default): asking for more is lowered to this. */
export const LIST_USERS_MAX_PAGE_SIZE = 100

/** One page of `ListUsers` (contact view: id, name, role, email), ordered by id. */
export async function listUsersPage(
  role: Role | undefined,
  page: { pageSize?: number; pageToken?: string } = {},
  options?: GrpcCallOptions,
): Promise<UserPage> {
  const res = await grpcCall<
    { role: string; pageSize: number; pageToken: string },
    { users: UserResponse[]; nextPageToken?: string }
  >(
    userClient,
    'ListUsers',
    { role: role ?? 'ROLE_UNSPECIFIED', pageSize: page.pageSize ?? LIST_USERS_MAX_PAGE_SIZE, pageToken: page.pageToken ?? '' },
    options,
  )
  return { users: res.users.map(toUser), nextPageToken: res.nextPageToken ?? '' }
}

/**
 * Pages through `ListUsers` until `next_page_token` is empty (vertice-api returns at most 100 users
 * per call). `options` is called once per page, so a short-lived caller token (the ops script's) is
 * fresh on each call. A token that comes back twice would loop forever, so it throws instead.
 */
export async function* userPages(
  role: Role | undefined,
  options: () => GrpcCallOptions | undefined = () => undefined,
): AsyncGenerator<User[]> {
  const seen = new Set<string>()
  let pageToken = ''
  do {
    const page = await listUsersPage(role, { pageToken }, options())
    yield page.users
    pageToken = page.nextPageToken
    if (seen.has(pageToken)) throw new Error('ListUsers returned the same next_page_token twice')
    seen.add(pageToken)
  } while (pageToken)
}

/** Every user of `role` (every role when omitted), across all `ListUsers` pages. */
export async function listAllUsers(role?: Role, options?: () => GrpcCallOptions | undefined): Promise<User[]> {
  const users: User[] = []
  for await (const page of userPages(role, options)) users.push(...page)
  return users
}

export async function getUser(id: number): Promise<User> {
  const res = await grpcCall<{ id: number }, UserResponse>(userClient, 'GetUser', { id })
  return toUser(res)
}

/**
 * Pages through every user to find one email. Only the `VERIFY_PASSWORDS=false` dev login still
 * uses it; everything else goes through `verifyCredentials`. It calls `ListUsers` with no token at
 * all (`anonymous`), which only vertice-api's `local` profile accepts: the BFF's service token is
 * deliberately not allowed to list users.
 */
export async function findUserByEmail(email: string): Promise<User | undefined> {
  const wanted = email.toLowerCase()
  for await (const page of userPages(undefined, () => ({ anonymous: true }))) {
    const user = page.find((u) => u.email.toLowerCase() === wanted)
    if (user) return user
  }
  return undefined
}

/** The same message for every failure, so it never says whether the email exists. */
export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password'

/**
 * Checks an email/password pair upstream (`VerifyCredentials`, bcrypt + a dummy compare for an
 * unknown email). Every refusal becomes the same `UnauthorizedError`. Login has no user yet, so
 * it goes out with the service token; a password change keeps the user's own token.
 */
export async function verifyCredentials(email: string, password: string): Promise<User> {
  try {
    const res = await grpcCall<{ email: string; password: string }, UserResponse>(
      userClient,
      'VerifyCredentials',
      { email, password },
      { asService: true },
    )
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
export async function createPasswordSetupToken(userId: number, options?: GrpcCallOptions): Promise<PasswordSetupToken> {
  const res = await grpcCall<{ userId: number }, { token: string; expiresAt: string }>(
    userClient,
    'CreatePasswordSetupToken',
    { userId },
    options,
  )
  return { token: res.token, expiresAt: res.expiresAt }
}

/**
 * Sets the password of the token's user and consumes the token. A bad token rejects with a 401
 * HttpError. Public (first access), so it goes out with the service token.
 */
export async function setPasswordWithToken(token: string, password: string): Promise<void> {
  await grpcCall(userClient, 'SetPasswordWithToken', { token, password }, { asService: true })
}

export interface UserCreateInput {
  name: string
  email: string
  password: string
  cpf?: string
  cref?: string
  role: Role
}

/** Public registration: no user yet, so it goes out with the service token. */
export async function createUser(input: UserCreateInput): Promise<User> {
  const res = await grpcCall<UserCreateInput, UserResponse>(
    userClient,
    'CreateUser',
    { ...input, cpf: input.cpf ?? '', cref: input.cref ?? '' },
    { asService: true },
  )
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
