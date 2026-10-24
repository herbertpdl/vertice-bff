import { userClient } from '../../grpc/clients.js'
import { grpcCall, type GrpcCallOptions } from '../../grpc/call.js'
import { HttpError, UnauthorizedError } from '../../lib/errors.js'
import { maskCpf } from '../../lib/cpf.js'

export type Role = 'ADMIN' | 'TRAINER' | 'CLIENT'

export interface User {
  id: number
  name: string
  email: string
  cpf: string
  cref: string
  role: Role
}

/** vertice-api's `ConsentState` on the wire: empty strings mean "not given yet". */
export interface ConsentStateResponse {
  acceptedTermsVersion: string
  termsAcceptedAt: string
  healthDataConsentVersion: string
  healthDataConsentAt: string
}

export interface UserResponse {
  id: string
  name: string
  email: string
  cpf: string
  cref: string
  role: Role
  /** A trainer's contacts and what their clients see (self and detail views; empty otherwise). */
  whatsapp?: string
  instagram?: string
  showEmail?: boolean
  showWhatsapp?: boolean
  showInstagram?: boolean
  /** Only in the self view (`GetUser` on the caller's own id); null otherwise. */
  consent?: ConsentStateResponse | null
}

export function toUser(r: UserResponse): User {
  return { id: Number(r.id), name: r.name, email: r.email, cpf: r.cpf, cref: r.cref, role: r.role }
}

/**
 * What the caller has consented to (P1-04), `null` where nothing was given yet. Versions are the
 * text versions the user was shown; the `...At` fields are ISO-8601 instants stamped by
 * vertice-api. The web compares the versions with `GET /legal/versions` to tell whether to ask
 * again.
 */
export interface Consent {
  termsVersion: string | null
  termsAcceptedAt: string | null
  healthDataVersion: string | null
  healthDataConsentAt: string | null
}

export type ConsentType = 'TERMS' | 'HEALTH_DATA'

export function toConsent(r: ConsentStateResponse | null | undefined): Consent {
  return {
    termsVersion: r?.acceptedTermsVersion || null,
    termsAcceptedAt: r?.termsAcceptedAt || null,
    healthDataVersion: r?.healthDataConsentVersion || null,
    healthDataConsentAt: r?.healthDataConsentAt || null,
  }
}

/**
 * `GET`/`PATCH /auth/me`: the caller's own account and consent state. The CPF is masked
 * (`***.***.***-25`, `''` when there is none), with no reveal: it lets the profile screen show
 * that a CPF is on file, and the user corrects it by typing the full new one (LGPD art. 18 III).
 * The full value is in their data export (`GET /auth/me/export`), so a plain read of the profile
 * never carries it.
 */
export interface Me {
  id: number
  name: string
  email: string
  cpf: string
  cref: string
  role: Role
  /** A trainer's WhatsApp (digits) and Instagram handle, and what their clients see; `""`/false otherwise. */
  whatsapp: string
  instagram: string
  showEmail: boolean
  showWhatsapp: boolean
  showInstagram: boolean
  consent: Consent
}

/** The contact fields of a self-view user (all empty/false for anyone but a trainer). */
export function toContacts(r: UserResponse) {
  return {
    whatsapp: r.whatsapp ?? '',
    instagram: r.instagram ?? '',
    showEmail: r.showEmail ?? false,
    showWhatsapp: r.showWhatsapp ?? false,
    showInstagram: r.showInstagram ?? false,
  }
}

/** Built field by field from the self view, the CPF masked. */
export function toMe(r: UserResponse): Me {
  return {
    id: Number(r.id),
    name: r.name,
    email: r.email,
    cpf: maskCpf(r.cpf),
    cref: r.cref,
    role: r.role,
    ...toContacts(r),
    consent: toConsent(r.consent),
  }
}

/** The caller's own account in vertice-api's self view (consent included). */
export async function getMe(id: number): Promise<Me> {
  return toMe(await getSelf(id))
}

/** `GetUser` on the caller's own id: vertice-api's self view, every field in full. Never return it as is. */
export async function getSelf(id: number): Promise<UserResponse> {
  return grpcCall<{ id: number }, UserResponse>(userClient, 'GetUser', { id })
}

/**
 * Records a consent of the calling user (`RecordConsent`). The request has no user id: vertice-api
 * takes it from the forwarded token, so nobody can consent for someone else.
 */
export async function recordConsent(type: ConsentType, version: string): Promise<Consent> {
  const res = await grpcCall<{ type: ConsentType; version: string }, ConsentStateResponse>(
    userClient,
    'RecordConsent',
    { type, version },
  )
  return toConsent(res)
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

/** Whose first access a redeemed setup token was: what the web needs to pick its success screen. */
export interface RedeemedSetup {
  role: Role
  email: string
}

/**
 * Sets the password of the token's user, consumes the token and returns who that user is
 * (`RedeemPasswordSetupToken`, contact view upstream; only the role and email are kept). A bad
 * token rejects with a 401 HttpError and returns nothing. Public (first access), so it goes out
 * with the service token.
 */
export async function redeemPasswordSetupToken(token: string, password: string): Promise<RedeemedSetup> {
  const res = await grpcCall<{ token: string; password: string }, UserResponse>(
    userClient,
    'RedeemPasswordSetupToken',
    { token, password },
    { asService: true },
  )
  return { role: res.role, email: res.email }
}

export interface UserCreateInput {
  name: string
  email: string
  password: string
  cpf?: string
  cref?: string
  role: Role
  /** The Terms / Privacy Policy version accepted at registration (vertice-api stamps the time). */
  acceptedTermsVersion: string
}

/** Public registration: no user yet, so it goes out with the service token. */
export async function createUser(input: UserCreateInput): Promise<User> {
  const res = await grpcCall<UserCreateInput, UserResponse>(
    userClient,
    'CreateUser',
    {
      name: input.name,
      email: input.email,
      password: input.password,
      cpf: input.cpf ?? '',
      cref: input.cref ?? '',
      role: input.role,
      acceptedTermsVersion: input.acceptedTermsVersion,
    },
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
  /** A trainer's contacts; `undefined` keeps the stored value (proto3 `optional`). */
  whatsapp?: string
  instagram?: string
  showEmail?: boolean
  showWhatsapp?: boolean
  showInstagram?: boolean
}

export async function updateUser(id: number, input: UserUpdateInput): Promise<User> {
  return toUser(await updateUserRaw(id, input))
}

/** `UpdateUser`, answering vertice-api's detail view as is (contacts included). */
export async function updateUserRaw(id: number, input: UserUpdateInput): Promise<UserResponse> {
  return grpcCall<{ id: number; user: UserUpdateInput }, UserResponse>(userClient, 'UpdateUser', {
    id,
    user: { ...input, cpf: input.cpf ?? '', cref: input.cref ?? '' },
  })
}

/**
 * Deletes the calling user's own account (`DeleteAccount`, P1-05): vertice-api deletes their
 * health data and the plans written for them, and anonymises the user row. The request has no
 * id: the token says whose account it is. A TRAINER with active clients gets FAILED_PRECONDITION
 * (409); afterwards every token of the account is UNAUTHENTICATED.
 */
export async function deleteAccount(): Promise<void> {
  await grpcCall(userClient, 'DeleteAccount', {})
}

/**
 * Everything vertice-api stores about the calling user, as one UTF-8 JSON document
 * (`ExportUserData`, LGPD art. 18 II and V). Self only, no id. Over the export bounds upstream
 * answers RESOURCE_EXHAUSTED (413) rather than a truncated document.
 */
export async function exportUserData(): Promise<string> {
  const res = await grpcCall<Record<string, never>, { json: string }>(userClient, 'ExportUserData', {})
  return res.json
}

export async function setUserPassword(id: number, password: string): Promise<void> {
  await grpcCall(userClient, 'SetUserPassword', { id, password })
}
