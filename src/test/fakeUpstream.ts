import { status } from '@grpc/grpc-js'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { mapGrpcError, withCallerIdentity, type GrpcCallOptions } from '../grpc/call.js'
import { todayInBusinessZone } from '../lib/dates.js'
import {
  ADMIN_SESSION_MAX_SECONDS,
  ADMIN_SESSION_TTL_SECONDS,
  MOBILE_SESSION,
  signAdminToken,
  signToken,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  type AuthUser,
  type Role,
} from '../lib/jwt.js'

/**
 * A small in-memory vertice-api for route tests. Use it with the grpcCall mock:
 *
 *   vi.mock('../grpc/call.js', () => ({ grpcCall: vi.fn() }))
 *   vi.mocked(grpcCall).mockImplementation(fakeGrpcCall)
 *
 * Two tenants that must never see each other: trainer A owns client A (and A2),
 * trainer B owns client B. Every id below belongs to exactly one of them, so a test
 * can put "the other tenant's id" in any path, query or body slot. Replies use the
 * proto-loader wire shape (int64 as string) so the real services map them.
 * Every call must carry a bearer token, as `grpcCall` attaches it (`withCallerIdentity`): a
 * valid user token, or a service subject on an RPC `API_SERVICE_SUBJECT_RPCS` allows it.
 * Anything else fails loudly, and each call's caller is recorded in `upstreamCallers`.
 * `GetExercise` reads the caller from the forwarded token, like vertice-api does.
 * Failures are gRPC statuses sent through the real `mapGrpcError`, so routes see
 * exactly the errors a real upstream produces. Test files must therefore keep the
 * real `mapGrpcError` when mocking `grpc/call.js`:
 *
 *   vi.mock('../grpc/call.js', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('../grpc/call.js')>()),
 *     grpcCall: vi.fn(),
 *   }))
 */
/** Throws what `grpcCall` would reject with for this upstream status. */
function upstreamError(code: status, details: string): never {
  throw mapGrpcError({ code, details })
}


export const ids = {
  admin: 1,
  trainerA: 10,
  trainerB: 11,
  clientA: 20,
  clientB: 21,
  /** Trainer A's second client, so a plan can belong to trainer A but not to client A. */
  clientA2: 22,
  planA: 100,
  planB: 101,
  planA2: 102,
  /** Client A's plan written by trainer B (a previous trainer): not trainer A's to read. */
  planBForClientA: 103,
  /** Trainer A's plan for client B, who is no longer on trainer A's roster. */
  planAForFormerClientB: 104,
  workoutA: 200,
  workoutB: 201,
  workoutExerciseA: 300,
  workoutExerciseB: 301,
  exerciseSetA: 400,
  exerciseSetB: 401,
  workoutLogA: 500,
  workoutLogB: 501,
  /** Starter exercise, visible to everyone. */
  exercise: 1,
  /** Trainer B's private exercise, used in no workout. */
  privateExerciseB: 2,
  /** Trainer A's private exercise, used in no workout. */
  privateExerciseA: 3,
  /** Trainer A's private exercise that a workout uses (the fake has no row for that workout). */
  inUseExerciseA: 4,
  /** A starter exercise that a workout uses: `DeleteStarterExerciseRequest` refuses it. */
  inUseStarterExercise: 5,
  /** The fixture's one muscle group (`ListMuscleGroups`). */
  muscleGroup: 1,
} as const

export type Actor = 'admin' | 'trainerA' | 'trainerB' | 'clientA' | 'clientB'

const users: { id: number; name: string; role: Role }[] = [
  { id: ids.admin, name: 'Admin', role: 'ADMIN' },
  { id: ids.trainerA, name: 'Trainer A', role: 'TRAINER' },
  { id: ids.trainerB, name: 'Trainer B', role: 'TRAINER' },
  { id: ids.clientA, name: 'Client A', role: 'CLIENT' },
  { id: ids.clientB, name: 'Client B', role: 'CLIENT' },
  { id: ids.clientA2, name: 'Client A2', role: 'CLIENT' },
]

/**
 * Adds `count` extra users of `role` (ids from 1000 up), e.g. to page past `ListUsers`' 100-user
 * cap. Returns their ids and a function that removes them again (call it in `afterEach`).
 */
export function addFakeUsers(count: number, role: Role = 'CLIENT'): { ids: number[]; remove: () => void } {
  const first = 1000 + users.length
  const added = Array.from({ length: count }, (_, i) => ({ id: first + i, name: `Extra ${first + i}`, role }))
  users.push(...added)
  return {
    ids: added.map((u) => u.id),
    remove: () => {
      for (const u of added) users.splice(users.indexOf(u), 1)
    },
  }
}

/** Every fixture user's password, except client A2's: a trainer-created client who hasn't set one yet. */
export const FAKE_PASSWORD = 'correct-horse-battery'
const withoutPassword = new Set<number>([ids.clientA2])

/**
 * Suspended users (admin-panel VRT-27): their tokens are refused (UNAUTHENTICATED) and their correct
 * password is FAILED_PRECONDITION "Account suspended", as upstream. Empty by default.
 */
export const fakeSuspended = new Set<number>()
export const resetFakeSuspended = () => fakeSuspended.clear()

/** E-mail send outcomes for the admin e-mail RPCs: `ok`, `limited`, `failed` or `disabled`. */
export const fakeEmailSends: { mode: 'ok' | 'limited' | 'failed' | 'disabled' } = { mode: 'ok' }
export const FAKE_EMAIL_RETRY_SECONDS = 42

/** What the fake `CreatePasswordSetupToken` issues; `RedeemPasswordSetupToken` accepts only these. */
export const setupTokenFor = (userId: number) => `issued-${userId}`

const trainerClients: [trainerId: number, clientId: number][] = [
  [ids.trainerA, ids.clientA],
  [ids.trainerA, ids.clientA2],
  [ids.trainerB, ids.clientB],
]

const plans = [
  { id: ids.planA, trainerId: ids.trainerA, clientId: ids.clientA },
  { id: ids.planB, trainerId: ids.trainerB, clientId: ids.clientB },
  { id: ids.planA2, trainerId: ids.trainerA, clientId: ids.clientA2 },
  { id: ids.planBForClientA, trainerId: ids.trainerB, clientId: ids.clientA },
  { id: ids.planAForFormerClientB, trainerId: ids.trainerA, clientId: ids.clientB },
]
const workouts = [
  { id: ids.workoutA, trainingPlanId: ids.planA },
  { id: ids.workoutB, trainingPlanId: ids.planB },
]
const workoutExercises = [
  { id: ids.workoutExerciseA, workoutId: ids.workoutA },
  { id: ids.workoutExerciseB, workoutId: ids.workoutB },
]
const exerciseSets = [
  { id: ids.exerciseSetA, workoutExerciseId: ids.workoutExerciseA },
  { id: ids.exerciseSetB, workoutExerciseId: ids.workoutExerciseB },
]
const workoutLogs = [
  { id: ids.workoutLogA, workoutId: ids.workoutA, clientId: ids.clientA },
  { id: ids.workoutLogB, workoutId: ids.workoutB, clientId: ids.clientB },
]

export function userOf(actor: Actor) {
  return users.find((u) => u.id === ids[actor])!
}

/**
 * A web (8h) token for `actor`, or with `{ mobile: true }` a 90-day mobile session token. The admin
 * gets an admin session token (`signAdminToken`, signed in a second ago), the only ADMIN token
 * `verifyToken` and vertice-api accept.
 */
export function bearer(actor: Actor, options: { mobile?: boolean } = {}) {
  const u = userOf(actor)
  if (u.role === 'ADMIN') return { authorization: `Bearer ${adminSessionToken(u.id)}` }
  const token = signToken({ id: u.id, role: u.role, ...(options.mobile ? { session: MOBILE_SESSION } : {}) })
  return { authorization: `Bearer ${token}` }
}

/** A valid admin session token for `id`, signed in `ageSeconds` ago (default 1). */
export function adminSessionToken(id: number = ids.admin, ageSeconds = 1): string {
  const authTime = Math.floor(Date.now() / 1000) - ageSeconds
  return signAdminToken({ id, authTime, issuedAt: authTime })
}

/**
 * An ADMIN token signed by hand with these claims (scope, `sub` and HS256 as the BFF's), for the
 * tokens `signAdminToken` refuses to make: no `amr`, no `auth_time`, past 12h, too long.
 */
export function craftedAdminToken(claims: Record<string, unknown>, id: number = ids.admin): string {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign(
    { role: 'ADMIN', amr: ['pwd', 'otp'], auth_time: now - 1, iat: now - 1, exp: now - 1 + ADMIN_SESSION_TTL_SECONDS, ...claims },
    env.JWT_SECRET,
    { algorithm: 'HS256', issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, subject: String(id) },
  )
}

/**
 * The plain 8h ADMIN token `/auth/login` signed before VRT-28 (no `amr`/`auth_time`): `signToken`
 * refuses to sign it now, but tokens like it may still be out there, so both verifiers must refuse it.
 */
export function plainAdminToken(id: number = ids.admin): string {
  const now = Math.floor(Date.now() / 1000)
  return craftedAdminToken({ amr: undefined, auth_time: undefined, iat: now, exp: now + 8 * 60 * 60 }, id)
}

export const emailOf = (id: number) => `user${id}@vertice.test`
/** Each fixture user's CPF: its last two digits are the user id (mod 100), so a mask is predictable. */
export const cpfOf = (id: number) => `529982247${String(id % 100).padStart(2, '0')}`
const str = (n: number) => String(n)
/**
 * The business day, as the services compute it — not `toISOString().slice(0, 10)`. The two differ
 * between 21:00 and 00:00 local, so a UTC "today" here would stop matching the services' "today"
 * for those three hours every evening, in any test that runs on the real clock.
 *
 * It is resolved once, at module load, so a test that pins the clock with fake timers gets this
 * value rather than its own "today". Those tests set the `completedAt` they need explicitly
 * (see `dashboard/routes.test.ts`) instead of relying on the fixture.
 */
const today = todayInBusinessZone()

function find<T extends { id: number }>(rows: T[], id: unknown, what: string): T {
  const row = rows.find((r) => r.id === Number(id))
  if (!row) upstreamError(status.NOT_FOUND, what)
  return row
}

/**
 * Each user's consent state, as vertice-api stores it (P1-04): empty strings until given. Trainer A
 * accepted the Terms at registration; nobody has consented to health data yet. `RecordConsent`
 * writes here; call `resetFakeConsents()` in `afterEach` when a test records one.
 */
const emptyConsent = () => ({
  acceptedTermsVersion: '',
  termsAcceptedAt: '',
  healthDataConsentVersion: '',
  healthDataConsentAt: '',
})
const initialConsents = (): Map<number, ReturnType<typeof emptyConsent>> =>
  new Map([[ids.trainerA, { ...emptyConsent(), acceptedTermsVersion: '2026-01', termsAcceptedAt: '2026-01-15T12:00:00Z' }]])
let consents = initialConsents()
export const resetFakeConsents = () => {
  consents = initialConsents()
}
const consentOf = (id: number) => ({ ...(consents.get(id) ?? emptyConsent()) })
/** What the fake `RecordConsent` stamps as "now". */
export const FAKE_CONSENT_AT = '2026-10-14T12:00:00Z'

/**
 * vertice-api's user views (P1-03, P1-04): every RPC fills one, leaving the other fields empty.
 * self = every field and the consent state; detail = every field but consent; contact = id, name,
 * role, email; summary = id, name, role. `consent` is null outside self (proto-loader's default
 * for an unset message).
 */
type UserView = 'self' | 'detail' | 'contact' | 'summary'
const userRes = (u: (typeof users)[number], view: UserView) => ({
  id: str(u.id),
  name: u.name,
  email: view === 'summary' ? '' : emailOf(u.id),
  cpf: view === 'detail' || view === 'self' ? cpfOf(u.id) : '',
  cref: (view === 'detail' || view === 'self') && u.role === 'TRAINER' ? `CREF-${u.id}` : '',
  role: u.role,
  consent: view === 'self' ? consentOf(u.id) : null,
})
const planRes = (p: (typeof plans)[number]) => ({
  id: str(p.id),
  name: `Plan ${p.id}`,
  description: '',
  trainerId: str(p.trainerId),
  clientId: str(p.clientId),
  startDate: '2026-01-01',
  endDate: '2099-12-31',
  level: 'BEGINNER',
})
const workoutRes = (w: (typeof workouts)[number]) => ({
  id: str(w.id),
  name: `Workout ${w.id}`,
  trainingPlanId: str(w.trainingPlanId),
  dayOfWeek: 'MONDAY',
})
const workoutExerciseRes = (we: (typeof workoutExercises)[number]) => ({
  id: str(we.id),
  workoutId: str(we.workoutId),
  exerciseId: str(ids.exercise),
  order: 0,
  restSecondsBetweenSets: 60,
  notes: '',
})
const exerciseSetRes = (s: (typeof exerciseSets)[number]) => ({
  id: str(s.id),
  workoutExerciseId: str(s.workoutExerciseId),
  setNumber: 1,
  reps: 10,
  durationSeconds: 0,
  weight: '20',
  loadPercentage: '',
  strategy: 'STRAIGHT',
  restSeconds: 60,
  notes: '',
})
const workoutLogRes = (l: (typeof workoutLogs)[number]) => ({
  id: str(l.id),
  workoutId: str(l.workoutId),
  clientId: str(l.clientId),
  weekStartDate: today,
  startedAt: `${today}T08:00:00Z`,
  completedAt: '',
  status: 'WORKOUT_LOG_STATUS_IN_PROGRESS',
  completionKind: 'COMPLETION_KIND_UNSPECIFIED',
})
const exercises: { id: number; ownerId: number | null; inUse?: true }[] = [
  { id: ids.exercise, ownerId: null },
  { id: ids.privateExerciseB, ownerId: ids.trainerB },
  { id: ids.privateExerciseA, ownerId: ids.trainerA },
  { id: ids.inUseExerciseA, ownerId: ids.trainerA, inUse: true },
  { id: ids.inUseStarterExercise, ownerId: null, inUse: true },
]
const exerciseRes = (e: (typeof exercises)[number] = exercises[0]!) => ({
  id: str(e.id),
  name: `Exercise ${e.id}`,
  description: '',
  videoUrl: '',
  muscleGroups: [{ id: '1', name: 'Peito' }],
  isStarter: e.ownerId === null,
})

/**
 * The contract vertice-api enforces on non-user callers, written out independently of the BFF's
 * own lists (`SERVICE_TOKEN_RPCS` in `grpc/call.ts`, `OPS_TOKEN_RPCS` in `ops/ops-token.ts`) so
 * tests can pin those to it: the running BFF's `service:bff` only on the public auth RPCs, and the
 * ops scripts' `service:ops` only on what `issue-setup-tokens` needs. Both carry `role: SERVICE`.
 */
export const API_SERVICE_SUBJECT_RPCS: Readonly<Record<string, readonly string[]>> = {
  'service:bff': [
    'VerifyCredentials',
    'CreateUser',
    'RedeemPasswordSetupToken',
    'GetSecondFactorState',
    'StartSecondFactorEnrollment',
    'VerifySecondFactor',
  ],
  'service:ops': [
    'ListUsers',
    'CreatePasswordSetupToken',
    'CreateAdmin',
    'IssueAdminSetupToken',
    'ResetAdminSecondFactor',
    'SuspendAdmin',
    'ReactivateAdmin',
  ],
}

/**
 * Mimics vertice-api's `local` profile, which lets a call without a token through (the
 * `VERIFY_PASSWORDS=false` dev login relies on it). Off by default: every call needs a token.
 */
export const fakeUpstreamProfile = { local: false }

export type UpstreamCaller = AuthUser | 'service:bff' | 'service:ops' | 'anonymous'

/**
 * The caller of every call the fake served, in order, plus the call's `deadlineMs` when it had
 * one. Cleared with `resetUpstreamCallers()`.
 */
export const upstreamCallers: { method: string; caller: UpstreamCaller; deadlineMs?: number }[] = []
export const resetUpstreamCallers = () => {
  upstreamCallers.length = 0
  listUsersPageCalls.length = 0
}

/** The verified caller of the current call, read from the token `grpcCall` forwards upstream. */
let currentCaller: UpstreamCaller | undefined

function caller(): AuthUser | undefined {
  return typeof currentCaller === 'object' ? currentCaller : undefined
}

/**
 * What vertice-api will check: a scoped token, and a service subject only on its RPCs. The
 * metadata comes from the real `withCallerIdentity`, which already throws on a call with no
 * identity and no explicit opt-in.
 */
function authenticateCall(method: string, options: GrpcCallOptions): UpstreamCaller {
  const [header] = withCallerIdentity(method, options).get('authorization')
  if (header === undefined) {
    if (fakeUpstreamProfile.local) return 'anonymous'
    throw new Error(`fakeUpstream: ${method} was called without a bearer token`)
  }
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  const claims = jwt.verify(token, env.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  }) as jwt.JwtPayload
  const subject = String(claims.sub)
  const allowed = API_SERVICE_SUBJECT_RPCS[subject]
  if (!allowed) return userCaller(claims)
  if (claims.role !== 'SERVICE' || typeof claims.exp !== 'number') {
    throw new Error(`fakeUpstream: ${method} got a malformed ${subject} token`)
  }
  // FeatureFlagService answers a service subject PERMISSION_DENIED (feature-flags spec D10).
  if (method === 'EvaluateFeatureFlag') upstreamError(status.PERMISSION_DENIED, 'FeatureFlagService needs a user token')
  if (!allowed.includes(method)) throw new Error(`fakeUpstream: ${subject} is not allowed to call ${method}`)
  return subject as 'service:bff' | 'service:ops'
}

/**
 * Mirrors vertice-api's `CallerIdentityResolver` for a user token: the user id is the numeric
 * `sub` (a legacy `id` claim is accepted only when it equals `sub`), the role a user role, and the
 * user must still exist with that role, or the call is UNAUTHENTICATED "Session no longer valid".
 */
function userCaller(claims: jwt.JwtPayload): AuthUser {
  const id = typeof claims.sub === 'string' && /^[1-9][0-9]*$/.test(claims.sub) ? Number(claims.sub) : NaN
  if (!Number.isSafeInteger(id) || ('id' in claims && claims.id !== id)) {
    upstreamError(status.UNAUTHENTICATED, 'Unrecognized caller identity')
  }
  const role = claims.role as Role
  if (!['ADMIN', 'TRAINER', 'CLIENT'].includes(role)) upstreamError(status.UNAUTHENTICATED, 'Unrecognized caller identity')
  const stored = users.find((u) => u.id === id)
  if (stored?.role !== role) upstreamError(status.UNAUTHENTICATED, 'Session no longer valid')
  if (fakeSuspended.has(id)) upstreamError(status.UNAUTHENTICATED, 'Session no longer valid')
  if (role === 'ADMIN' && !acceptsAdminToken(claims)) upstreamError(status.UNAUTHENTICATED, 'Session no longer valid')
  return { id, role }
}

/**
 * vertice-api's D6 checks on an ADMIN token, written out independently of the BFF's `verifyToken`:
 * `amr` contains "otp", `auth_time` present and not after `iat`, now at most 12h after `auth_time`,
 * `exp - iat` at most 30 minutes. So a BFF that signs a bad admin token fails here too.
 */
function acceptsAdminToken(claims: jwt.JwtPayload): boolean {
  const { amr, auth_time: authTime, iat, exp } = claims
  if (!Array.isArray(amr) || !amr.includes('otp')) return false
  if (typeof authTime !== 'number' || typeof iat !== 'number' || typeof exp !== 'number') return false
  if (authTime > iat) return false
  if (Date.now() / 1000 > authTime + ADMIN_SESSION_MAX_SECONDS) return false
  return exp - iat <= ADMIN_SESSION_TTL_SECONDS
}

/**
 * Each admin's second factor, as vertice-api's `admin_second_factors` holds it. The fixture admin
 * starts with a pending (unconfirmed) secret: the state reads NOT_ENROLLED, enrolment can restart,
 * and a right code confirms it. Codes in `FAKE_TOTP_CODES` are right, each accepted once (the API's
 * replay protection); five wrong ones in a row lock it. `resetFakeSecondFactors()` in `beforeEach`.
 */
export const FAKE_TOTP_CODES = ['123456', '234567', '345678', '456789'] as const
export const FAKE_LOCK_SECONDS = 900
type SecondFactor = { secret: 'none' | 'pending' | 'enrolled'; used: Set<string>; failures: number; locked: boolean }
const initialSecondFactors = (): Map<number, SecondFactor> =>
  new Map([[ids.admin, { secret: 'pending', used: new Set(), failures: 0, locked: false }]])
let secondFactors = initialSecondFactors()
export const resetFakeSecondFactors = () => {
  secondFactors = initialSecondFactors()
}
/** Puts an admin's second factor in a state (`locked` sets the 15-minute lock). */
export function setFakeSecondFactor(id: number, state: SecondFactor['secret'] | 'locked') {
  const factor = secondFactors.get(id) ?? { secret: 'none', used: new Set(), failures: 0, locked: false }
  if (state === 'locked') factor.locked = true
  else factor.secret = state
  secondFactors.set(id, factor)
}

/** Mirrors `AdminAuthService`'s guard: service:bff only, for a non-deleted ADMIN. */
function secondFactorOf(userId: unknown): SecondFactor {
  if (currentCaller !== 'service:bff') upstreamError(status.PERMISSION_DENIED, 'AdminAuthService is service:bff only')
  const user = users.find((u) => u.id === Number(userId))
  if (user?.role !== 'ADMIN') upstreamError(status.PERMISSION_DENIED, 'Not an admin')
  let factor = secondFactors.get(user.id)
  if (!factor) secondFactors.set(user.id, (factor = { secret: 'none', used: new Set(), failures: 0, locked: false }))
  return factor
}

/** Mirrors `AdminOpsService`'s guard: service:ops only; a missing or non-admin user is NOT_FOUND. */
function opsAdmin(userId: unknown) {
  if (currentCaller !== 'service:ops') upstreamError(status.PERMISSION_DENIED, 'AdminOpsService is service:ops only')
  const user = users.find((u) => u.id === Number(userId))
  if (user?.role !== 'ADMIN') upstreamError(status.NOT_FOUND, `User with id ${Number(userId)} not found`)
  return user
}

/** Mirrors vertice-api's `ExerciseService.getExercise` visibility rule. */
function getVisibleExercise(id: unknown) {
  const exercise = find(exercises, id, 'Exercise')
  const user = caller()
  const visible =
    user?.role === 'CLIENT'
      ? // Every fixture workout exercise uses the starter exercise.
        exercise.id === ids.exercise &&
        workouts.some((w) => find(plans, w.trainingPlanId, 'TrainingPlan').clientId === user.id)
      : exercise.ownerId === null || (user?.role === 'TRAINER' && exercise.ownerId === user.id)
  if (!visible) upstreamError(status.PERMISSION_DENIED, `You do not have access to exercise ${exercise.id}`)
  return exerciseRes(exercise)
}

/**
 * Mirrors vertice-api's `ExerciseService.findOwnedOrThrow` for update and delete: TRAINER only,
 * then existence (NOT_FOUND), then the read-only starter set, then ownership (both PERMISSION_DENIED).
 */
function getOwnedExercise(id: unknown, verb: 'changed' | 'deleted') {
  const user = caller()
  if (user?.role !== 'TRAINER') {
    upstreamError(status.PERMISSION_DENIED, `Role ${user?.role} is not allowed to change exercises`)
  }
  const exercise = find(exercises, id, 'Exercise')
  if (exercise.ownerId === null) {
    upstreamError(
      status.PERMISSION_DENIED,
      `Exercise ${exercise.id} belongs to the shared starter set and cannot be ${verb}`,
    )
  }
  if (exercise.ownerId !== user.id) {
    upstreamError(status.PERMISSION_DENIED, `You do not have access to exercise ${exercise.id}`)
  }
  return exercise
}

type Req = Record<string, unknown>

/** vertice-api's `GetUser` rule: detail for ADMIN or the target's active trainer (the user themself gets self). */
function canSeeDetail(userId: number): boolean {
  const user = caller()
  if (!user) return false
  return (
    user.id === userId ||
    user.role === 'ADMIN' ||
    trainerClients.some(([t, c]) => t === user.id && c === userId)
  )
}

/** Mirrors vertice-api's paginated `ListUsers`: keyset over id, page size 0 → 100, capped at 100. */
const LIST_USERS_MAX_PAGE = 100
export const listUsersPageCalls: { pageSize: number; pageToken: string }[] = []
function listUsers(r: Req) {
  const pageSize = Number(r.pageSize ?? 0)
  const pageToken = String(r.pageToken ?? '')
  listUsersPageCalls.push({ pageSize, pageToken })
  if (pageSize < 0) upstreamError(status.INVALID_ARGUMENT, 'page_size: must not be negative')
  const after = pageToken === '' ? 0 : Number(/^after-(\d+)$/.exec(pageToken)?.[1] ?? NaN)
  if (Number.isNaN(after)) upstreamError(status.INVALID_ARGUMENT, 'page_token: malformed')
  const limit = Math.min(pageSize || LIST_USERS_MAX_PAGE, LIST_USERS_MAX_PAGE)
  const matching = users
    .filter((u) => (!r.role || r.role === 'ROLE_UNSPECIFIED' || r.role === u.role) && u.id > after)
    .sort((a, b) => a.id - b.id)
  const page = matching.slice(0, limit)
  return {
    users: page.map((u) => userRes(u, 'contact')),
    nextPageToken: matching.length > limit ? `after-${page.at(-1)!.id}` : '',
  }
}
/**
 * Mirrors vertice-api's `AdminService` (admin-panel D18, D19, D26, D27): ADMIN callers only (the
 * D6 claims are checked in `authenticateCall`), admins invisible, page_size 0/10/25/50, an opaque
 * `next_page_token`. The fixture data is small and fixed; history entries live in `adminActions`.
 */
function requireAdminCaller() {
  if (caller()?.role !== 'ADMIN') upstreamError(status.PERMISSION_DENIED, 'AdminService is ADMIN only')
}
function adminPage<T>(rows: T[], r: Req): { page: T[]; nextPageToken: string } {
  const pageSize = Number(r.pageSize ?? 0)
  if (![0, 10, 25, 50].includes(pageSize)) upstreamError(status.INVALID_ARGUMENT, 'page_size: must be 10, 25 or 50')
  const token = String(r.pageToken ?? '')
  const offset = token === '' ? 0 : Number(/^offset-(\d+)$/.exec(token)?.[1] ?? NaN)
  if (Number.isNaN(offset)) upstreamError(status.INVALID_ARGUMENT, 'page_token: malformed')
  const size = pageSize || 25
  const page = rows.slice(offset, offset + size)
  return { page, nextPageToken: offset + size < rows.length ? `offset-${offset + size}` : '' }
}
const userRef = (u: (typeof users)[number]) => ({ id: str(u.id), name: u.name, role: u.role })
const FAKE_CREATED_AT = '2026-10-01T12:00:00Z'
/** A visible profile target: a trainer or client that exists. Missing or ADMIN is NOT_FOUND (D4). */
function profileTarget(userId: unknown) {
  const user = users.find((u) => u.id === Number(userId))
  if (!user || user.role === 'ADMIN') upstreamError(status.NOT_FOUND, `User with id ${Number(userId)} not found`)
  return user
}
const profileBasics = (u: (typeof users)[number]) => ({
  id: str(u.id),
  name: u.name,
  email: emailOf(u.id),
  cpfMasked: `***.***.***-${cpfOf(u.id).slice(-2)}`,
  suspended: fakeSuspended.has(u.id),
  suspendedAt: fakeSuspended.has(u.id) ? FAKE_CREATED_AT : '',
  createdAt: FAKE_CREATED_AT,
  lastActiveOn: today,
})
const relationshipRef = (other: (typeof users)[number]) => ({
  user: userRef(other),
  startedAt: FAKE_CREATED_AT,
  endedAt: '',
  suspended: fakeSuspended.has(other.id),
})
/** The fake history: `GetUserProfile` appends a VIEW_USER_PROFILE entry, as vertice-api does (D17). */
export const fakeAdminActions: { id: number; adminId: number; action: string; targetUserId: number }[] = []
export const resetFakeAdminActions = () => {
  fakeAdminActions.length = 0
}

function directoryRow(u: (typeof users)[number]) {
  const trainerId = trainerClients.find(([, c]) => c === u.id)?.[0]
  return {
    id: str(u.id),
    name: u.name,
    email: emailOf(u.id),
    role: u.role,
    suspended: fakeSuspended.has(u.id),
    createdAt: FAKE_CREATED_AT,
    lastActiveOn: u.id === ids.clientA2 ? '' : today,
    currentTrainer: u.role === 'CLIENT' && trainerId ? userRef(find(users, trainerId, 'User')) : null,
    currentClientCount: u.role === 'TRAINER' ? trainerClients.filter(([t]) => t === u.id).length : 0,
  }
}

const recordAdminAction = (action: string, targetUserId: number) =>
  fakeAdminActions.unshift({ id: fakeAdminActions.length + 1, adminId: caller()!.id, action: `ADMIN_ACTION_${action}`, targetUserId })

/** vertice-api's reason rule (D21): trimmed, 1-500 UTF-16 units. */
function requireReason(r: Req) {
  const reason = String(r.reason ?? '').trim()
  if (reason.length < 1 || reason.length > 500) upstreamError(status.INVALID_ARGUMENT, 'reason: must be 1-500 characters')
}

function requireUserId(r: Req) {
  if (!(Number(r.userId) >= 1)) upstreamError(status.INVALID_ARGUMENT, 'user_id: must be positive')
}

/** The e-mail sends' failure modes, with vertice-api's texts (spec §3). */
function emailSend(kind: string) {
  if (fakeEmailSends.mode === 'disabled') upstreamError(status.FAILED_PRECONDITION, `${kind} emails are not enabled`)
  if (fakeEmailSends.mode === 'limited') {
    upstreamError(status.RESOURCE_EXHAUSTED, `${kind} email limit reached; retry after ${FAKE_EMAIL_RETRY_SECONDS} seconds`)
  }
  if (fakeEmailSends.mode === 'failed') upstreamError(status.UNAVAILABLE, `${kind} email could not be sent`)
}

/** Mirrors VRT-27's `AdminService` writes (ADMIN only) and the admin path of `SendFirstAccessEmail`. */
function adminWriteHandlers(): Record<string, (req: Req) => unknown> {
  return {
    SuspendUser: (r) => {
      requireAdminCaller()
      requireUserId(r)
      requireReason(r)
      const user = profileTarget(r.userId)
      if (fakeSuspended.has(user.id)) upstreamError(status.FAILED_PRECONDITION, `User ${user.id} is already suspended`)
      fakeSuspended.add(user.id)
      recordAdminAction('SUSPEND_USER', user.id)
      return { user: directoryRow(user) }
    },
    ReactivateUser: (r) => {
      requireAdminCaller()
      requireUserId(r)
      requireReason(r)
      const user = profileTarget(r.userId)
      if (!fakeSuspended.has(user.id)) upstreamError(status.FAILED_PRECONDITION, `User ${user.id} is not suspended`)
      fakeSuspended.delete(user.id)
      recordAdminAction('REACTIVATE_USER', user.id)
      return { user: directoryRow(user) }
    },
    SendPasswordResetEmail: (r) => {
      requireAdminCaller()
      requireUserId(r)
      const user = profileTarget(r.userId)
      emailSend('Password-reset')
      recordAdminAction('SEND_PASSWORD_RESET_EMAIL', user.id)
      return {}
    },
    // UserService. ADMIN (or service:ops) for any client, NOT_FOUND for anyone else; a TRAINER for
    // their active client with no password yet, PERMISSION_DENIED otherwise.
    SendFirstAccessEmail: (r) => {
      requireUserId(r)
      const target = users.find((u) => u.id === Number(r.userId))
      const user = caller()
      if (user?.role === 'ADMIN' || currentCaller === 'service:ops') {
        if (target?.role !== 'CLIENT') upstreamError(status.NOT_FOUND, `Client with id ${Number(r.userId)} not found`)
      } else if (
        user?.role !== 'TRAINER' ||
        !target ||
        !withoutPassword.has(target.id) ||
        !trainerClients.some(([t, c]) => t === user.id && c === target.id)
      ) {
        upstreamError(status.PERMISSION_DENIED, 'Not allowed to send this first-access email')
      }
      emailSend('First-access')
      if (user?.role === 'ADMIN') recordAdminAction('SEND_FIRST_ACCESS_EMAIL', target!.id)
      return { status: { pending: true, lastSentAt: FAKE_CREATED_AT, lastSendFailed: false, sendResult: 'FIRST_ACCESS_SEND_RESULT_SENT', retryAfterSeconds: 0 } }
    },
  }
}

const adminHandlers: Record<string, (req: Req) => unknown> = {
  GetDashboard: () => {
    requireAdminCaller()
    const trainers = users.filter((u) => u.role === 'TRAINER').length
    const clients = users.filter((u) => u.role === 'CLIENT').length
    return {
      trainers: str(trainers),
      clients: str(clients),
      activeTrainers7d: '1',
      activeClients7d: '2',
      activeTrainers30d: str(trainers),
      activeClients30d: str(clients),
      completedWorkouts7d: '3',
      completedWorkouts30d: '9',
      weeklySignups: Array.from({ length: 12 }, (_, i) => ({
        weekStart: `2026-${String(8 + Math.floor(i / 4)).padStart(2, '0')}-${String(3 + (i % 4) * 7).padStart(2, '0')}`,
        trainers: '0',
        clients: str(i % 3),
      })),
    }
  },
  ListDirectoryUsers: (r) => {
    requireAdminCaller()
    const search = String(r.search ?? '').trim().toLowerCase()
    if (search.length > 100) upstreamError(status.INVALID_ARGUMENT, 'search: must be at most 100 characters')
    const role = r.role === 'DIRECTORY_ROLE_TRAINER' ? 'TRAINER' : r.role === 'DIRECTORY_ROLE_CLIENT' ? 'CLIENT' : null
    const wantSuspended = r.status === 'DIRECTORY_STATUS_SUSPENDED' ? true : r.status === 'DIRECTORY_STATUS_ACTIVE' ? false : null
    const rows = users
      .filter((u) => u.role !== 'ADMIN' && (!role || u.role === role))
      .filter((u) => wantSuspended === null || fakeSuspended.has(u.id) === wantSuspended)
      .filter((u) => !search || u.name.toLowerCase().includes(search) || emailOf(u.id).includes(search))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id - b.id)
    const { page, nextPageToken } = adminPage(rows, r)
    return {
      users: page.map((u) => directoryRow(u)),
      nextPageToken,
    }
  },
  ...adminWriteHandlers(),
  GetUserProfile: (r) => {
    requireAdminCaller()
    const user = profileTarget(r.userId)
    fakeAdminActions.unshift({ id: fakeAdminActions.length + 1, adminId: caller()!.id, action: 'ADMIN_ACTION_VIEW_USER_PROFILE', targetUserId: user.id })
    if (user.role === 'TRAINER') {
      const clientsOf = trainerClients.filter(([t]) => t === user.id).map(([, c]) => find(users, c, 'User'))
      return {
        trainer: {
          basics: profileBasics(user),
          cref: '123456-G/SP',
          whatsapp: '11987654321',
          instagram: '',
          showEmail: true,
          showWhatsapp: true,
          showInstagram: false,
          currentClients: clientsOf.map(relationshipRef),
          formerClients: [],
          planCount: plans.filter((p) => p.trainerId === user.id).length,
          workoutCount: 1,
          privateExerciseCount: 1,
        },
        profile: 'trainer',
      }
    }
    const trainerId = trainerClients.find(([, c]) => c === user.id)?.[0]
    return {
      client: {
        basics: { ...profileBasics(user), cpfMasked: user.id === ids.clientA2 ? '' : profileBasics(user).cpfMasked },
        currentTrainer: trainerId ? relationshipRef(find(users, trainerId, 'User')) : null,
        pastTrainers: [],
        planCount: plans.filter((p) => p.clientId === user.id).length,
        completedWorkoutCount: 2,
        firstAccess: { pending: withoutPassword.has(user.id), lastSentAt: '', lastSendFailed: false, sendResult: 'FIRST_ACCESS_SEND_RESULT_UNSPECIFIED', retryAfterSeconds: 0 },
      },
      profile: 'client',
    }
  },
  ListActions: (r) => {
    requireAdminCaller()
    if (Number(r.adminId ?? 0) < 0 || Number(r.targetUserId ?? 0) < 0) upstreamError(status.INVALID_ARGUMENT, 'id: must not be negative')
    const rows = fakeAdminActions.filter(
      (a) =>
        byNumber(r.adminId, a.adminId) &&
        byNumber(r.targetUserId, a.targetUserId) &&
        (!r.action || r.action === 'ADMIN_ACTION_UNSPECIFIED' || r.action === a.action),
    )
    const { page, nextPageToken } = adminPage(rows, r)
    return {
      entries: page.map((a) => ({
        id: str(a.id),
        admin: userRef(find(users, a.adminId, 'User')),
        action: a.action,
        targetUser: userRef(find(users, a.targetUserId, 'User')),
        relatedUser: null,
        targetExerciseId: '0',
        targetMuscleGroupId: '0',
        subjectLabel: '',
        reason: '',
        createdAt: FAKE_CREATED_AT,
      })),
      nextPageToken,
    }
  },
  ListActionAdmins: () => {
    requireAdminCaller()
    const authors = new Set(fakeAdminActions.map((a) => a.adminId))
    return { admins: users.filter((u) => u.role === 'ADMIN' && authors.has(u.id)).map(userRef) }
  },
}

const byNumber = (value: unknown, actual: number) => !Number(value) || Number(value) === actual

/**
 * Mirrors vertice-api's `AdminCatalogService` (admin-panel D20-D24, D28): ADMIN only, the trainer's
 * `ExerciseRequest` bounds, names unique ignoring case within the starter set and within the muscle
 * groups, a private exercise read-only. Stateless: writes answer as if they happened and change no
 * fixture, so tests stay independent.
 */
const FAKE_MUSCLE_GROUPS = [{ id: ids.muscleGroup, name: 'Peito' }]
const nameKey = (name: unknown) => String(name ?? '').normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()
function catalogRow(e: (typeof exercises)[number]) {
  return { exercise: exerciseRes(e), owner: e.ownerId === null ? null : userRef(find(users, e.ownerId, 'User')) }
}
function requireCatalogId(value: unknown, field = 'id') {
  if (!(Number(value) >= 1)) upstreamError(status.INVALID_ARGUMENT, `${field}: must be greater than or equal to 1`)
}
function requireExerciseRequest(r: Req, exceptId?: number) {
  const exercise = r.exercise as Req | null | undefined
  if (!exercise) upstreamError(status.INVALID_ARGUMENT, 'exercise: must be set')
  const name = String(exercise.name ?? '').normalize('NFC').trim()
  if (name.length < 1 || name.length > 255) upstreamError(status.INVALID_ARGUMENT, 'name: size must be between 1 and 255')
  const groupIds = (exercise.muscleGroupIds as number[] | undefined) ?? []
  if (groupIds.length === 0) upstreamError(status.INVALID_ARGUMENT, 'muscleGroupIds: must contain at least one muscle group')
  if (groupIds.some((g) => !FAKE_MUSCLE_GROUPS.some((m) => m.id === Number(g)))) {
    upstreamError(status.INVALID_ARGUMENT, 'muscleGroupIds: unknown muscle group')
  }
  const taken = exercises.some(
    (e) => e.ownerId === null && e.id !== exceptId && nameKey(exerciseRes(e).name) === nameKey(name),
  )
  if (taken) upstreamError(status.ALREADY_EXISTS, 'Exercise name already in use')
  return name
}
function starterTarget(id: unknown) {
  requireCatalogId(id)
  const exercise = find(exercises, id, `Exercise with id ${Number(id)} not found`)
  if (exercise.ownerId !== null) upstreamError(status.PERMISSION_DENIED, `Exercise ${exercise.id} is not a starter exercise`)
  return exercise
}
function requireMuscleGroupName(r: Req, exceptId?: number) {
  const name = String(r.name ?? '').normalize('NFC').trim()
  if (name.length < 1 || name.length > 50) upstreamError(status.INVALID_ARGUMENT, 'name: size must be between 1 and 50')
  if (FAKE_MUSCLE_GROUPS.some((m) => m.id !== exceptId && nameKey(m.name) === nameKey(name))) {
    upstreamError(status.ALREADY_EXISTS, 'Muscle group name already in use')
  }
  return name
}
const FAKE_NEW_EXERCISE_ID = 900
const FAKE_NEW_MUSCLE_GROUP_ID = 9
const createdStarter = (name: string) => ({
  exercise: { ...exerciseRes({ id: FAKE_NEW_EXERCISE_ID, ownerId: null }), name },
  owner: null,
})

const adminCatalogHandlers: Record<string, (req: Req) => unknown> = {
  ListCatalogExercises: (r) => {
    requireAdminCaller()
    const search = String(r.search ?? '').trim().toLowerCase()
    if (search.length > 100) upstreamError(status.INVALID_ARGUMENT, 'search: size must be between 0 and 100')
    if (!['CATALOG_SCOPE_UNSPECIFIED', 'CATALOG_SCOPE_STARTER', 'CATALOG_SCOPE_PRIVATE'].includes(String(r.scope))) {
      upstreamError(status.INVALID_ARGUMENT, 'scope: unknown catalog scope')
    }
    const rows = exercises
      .filter((e) => r.scope !== 'CATALOG_SCOPE_STARTER' || e.ownerId === null)
      .filter((e) => r.scope !== 'CATALOG_SCOPE_PRIVATE' || e.ownerId !== null)
      .filter((e) => byNumber(r.ownerId, e.ownerId ?? -1))
      // Every fixture exercise has the one fixture group: another group id is an empty page.
      .filter(() => byNumber(r.muscleGroupId, ids.muscleGroup))
      .filter((e) => !search || exerciseRes(e).name.toLowerCase().includes(search))
      .sort((a, b) => Number(b.ownerId === null) - Number(a.ownerId === null) || a.id - b.id)
    const { page, nextPageToken } = adminPage(rows, r)
    return { exercises: page.map(catalogRow), nextPageToken }
  },
  ListMostUsedExercises: (r) => {
    requireAdminCaller()
    const counts = new Map<number, number>([
      [ids.exercise, 3],
      [ids.inUseStarterExercise, 2],
      [ids.inUseExerciseA, 1],
    ])
    const rows = exercises
      .filter((e) => counts.has(e.id) && byNumber(r.muscleGroupId, ids.muscleGroup))
      .sort((a, b) => counts.get(b.id)! - counts.get(a.id)! || a.id - b.id)
    const { page, nextPageToken } = adminPage(rows, r)
    return { exercises: page.map((e) => ({ exercise: catalogRow(e), workoutCount: str(counts.get(e.id)!) })), nextPageToken }
  },
  CreateStarterExercise: (r) => {
    requireAdminCaller()
    return { exercise: createdStarter(requireExerciseRequest(r)) }
  },
  UpdateStarterExercise: (r) => {
    requireAdminCaller()
    const target = starterTarget(r.id)
    const name = requireExerciseRequest(r, target.id)
    return { exercise: { exercise: { ...exerciseRes(target), name }, owner: null } }
  },
  DeleteStarterExercise: (r) => {
    requireAdminCaller()
    const target = starterTarget(r.id)
    if (target.inUse) upstreamError(status.FAILED_PRECONDITION, `Exercise ${target.id} is used by a workout and cannot be deleted`)
    return {}
  },
  PromoteExercise: (r) => {
    requireAdminCaller()
    requireCatalogId(r.sourceExerciseId, 'sourceExerciseId')
    const source = find(exercises, r.sourceExerciseId, `Exercise with id ${Number(r.sourceExerciseId)} not found`)
    if (source.ownerId === null) upstreamError(status.FAILED_PRECONDITION, `Exercise ${source.id} is already a starter exercise`)
    return { exercise: createdStarter(requireExerciseRequest(r)) }
  },
  CreateMuscleGroup: (r) => {
    requireAdminCaller()
    return { muscleGroup: { id: str(FAKE_NEW_MUSCLE_GROUP_ID), name: requireMuscleGroupName(r) } }
  },
  RenameMuscleGroup: (r) => {
    requireAdminCaller()
    requireCatalogId(r.id)
    const group = find(FAKE_MUSCLE_GROUPS, r.id, `Muscle group with id ${Number(r.id)} not found`)
    return { muscleGroup: { id: str(group.id), name: requireMuscleGroupName(r, group.id) } }
  },
}


/**
 * Mirrors vertice-api's feature flags (feature-flags spec D7–D13), seeded as the API is:
 * `AI_ASSISTANT_ENABLED` on and `FIRST_ACCESS_EMAIL_ENABLED` off for everyone, no user settings.
 * `resetFakeFlags()` in `beforeEach`. `fakeFlagEvaluation` makes `EvaluateFeatureFlag` fail with a
 * status or answer late (with `fakeGrpcCall`'s `deadlineMs` handling).
 */
interface FakeFlag {
  description: string
  enabled: boolean
  users: Map<number, boolean>
}
const initialFlags = (): Map<string, FakeFlag> =>
  new Map([
    ['AI_ASSISTANT_ENABLED', { description: 'Assistente de IA no editor de treino.', enabled: true, users: new Map() }],
    ['FIRST_ACCESS_EMAIL_ENABLED', { description: 'E-mail de primeiro acesso.', enabled: false, users: new Map() }],
  ])
export const fakeFlags: Map<string, FakeFlag> = initialFlags()
export const fakeFlagEvaluation: { failWith?: status; delayMs: number } = { delayMs: 0 }
export const resetFakeFlags = () => {
  fakeFlags.clear()
  for (const [key, flag] of initialFlags()) fakeFlags.set(key, flag)
  fakeFlagEvaluation.failWith = undefined
  fakeFlagEvaluation.delayMs = 0
}

const FLAG_KEY = /^[A-Z][A-Z0-9_]*$/
function requireFlagKey(value: unknown): string {
  const key = String(value ?? '')
  if (key.length === 0 || key.length > 64 || !FLAG_KEY.test(key)) upstreamError(status.INVALID_ARGUMENT, 'key: malformed')
  return key
}
function flagOf(value: unknown): [string, FakeFlag] {
  const key = requireFlagKey(value)
  const flag = fakeFlags.get(key)
  if (!flag) upstreamError(status.NOT_FOUND, `Feature flag ${key} not found`)
  return [key, flag]
}
function requireFlagUserId(value: unknown): number {
  const userId = Number(value)
  if (!Number.isSafeInteger(userId) || userId <= 0) upstreamError(status.INVALID_ARGUMENT, 'user_id: must be positive')
  return userId
}
const flagRes = (key: string, flag: FakeFlag) => ({
  key,
  description: flag.description,
  enabled: flag.enabled,
  users: [...flag.users.entries()].sort(([a], [b]) => a - b).map(([userId, enabled]) => ({ userId: str(userId), enabled })),
})

const featureFlagHandlers: Record<string, (req: Req) => unknown> = {
  // FeatureFlagService: a user token only (a service subject is PERMISSION_DENIED in
  // authenticateCall); the caller's setting, else the everyone state, an unknown key false.
  EvaluateFeatureFlag: (r) => {
    const user = caller()
    if (!user) upstreamError(status.PERMISSION_DENIED, 'FeatureFlagService needs a user token')
    if (fakeFlagEvaluation.failWith !== undefined) upstreamError(fakeFlagEvaluation.failWith, 'evaluation failed')
    const flag = fakeFlags.get(requireFlagKey(r.key))
    if (!flag) return { enabled: false }
    return { enabled: flag.users.get(user.id) ?? flag.enabled }
  },
  // AdminFeatureFlagService: ADMIN only (D6 claims checked in authenticateCall).
  ListFeatureFlags: () => {
    requireAdminCaller()
    return { flags: [...fakeFlags.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, f]) => flagRes(k, f)) }
  },
  SetFeatureFlagEveryone: (r) => {
    requireAdminCaller()
    const [key, flag] = flagOf(r.key)
    flag.enabled = r.enabled === true
    return { flag: flagRes(key, flag) }
  },
  SetFeatureFlagUser: (r) => {
    requireAdminCaller()
    const [key, flag] = flagOf(r.key)
    flag.users.set(requireFlagUserId(r.userId), r.enabled === true)
    return { flag: flagRes(key, flag) }
  },
  RemoveFeatureFlagUser: (r) => {
    requireAdminCaller()
    const [key, flag] = flagOf(r.key)
    flag.users.delete(requireFlagUserId(r.userId))
    return { flag: flagRes(key, flag) }
  },
}

const handlers: Record<string, (req: Req) => unknown> = {
  // UserService
  ListUsers: (r) => listUsers(r),
  GetUser: (r) => {
    const user = find(users, r.id, 'User')
    if (caller()?.id === user.id) return userRes(user, 'self')
    return userRes(user, canSeeDetail(user.id) ? 'detail' : 'summary')
  },
  // Mirrors vertice-api's `RecordConsent`: a user token only, the user is the caller, and the
  // version is validated there too.
  RecordConsent: (r) => {
    const user = caller()
    if (!user) upstreamError(status.PERMISSION_DENIED, 'Only a user can record their own consent')
    const version = String(r.version ?? '')
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(version)) upstreamError(status.INVALID_ARGUMENT, 'version: invalid')
    const consent = consentOf(user.id)
    if (r.type === 'TERMS') Object.assign(consent, { acceptedTermsVersion: version, termsAcceptedAt: FAKE_CONSENT_AT })
    else if (r.type === 'HEALTH_DATA') {
      Object.assign(consent, { healthDataConsentVersion: version, healthDataConsentAt: FAKE_CONSENT_AT })
    } else upstreamError(status.INVALID_ARGUMENT, 'type: must be set')
    consents.set(user.id, consent)
    return consent
  },
  CreateUser: (r) => ({ ...userRes(users[3]!, 'contact'), id: '99', email: r.email, role: r.role }),
  // Echoes the new fields in the detail view. The user themself may not change their role
  // (vertice-api: PERMISSION_DENIED); the stored row is left alone so tests stay independent.
  UpdateUser: (r) => {
    const stored = find(users, r.id, 'User')
    const next = (r.user ?? {}) as Record<string, string>
    if (caller()?.id === stored.id && next.role !== stored.role) {
      upstreamError(status.PERMISSION_DENIED, 'You cannot change your own role')
    }
    return { ...userRes(stored, 'detail'), name: next.name, email: next.email, cpf: next.cpf, cref: next.cref }
  },
  // Mirrors vertice-api's `DeleteAccount`: self only (no id), refused for a TRAINER with active
  // clients. Stateless: the fixture user stays, so later tests can still use their token.
  DeleteAccount: () => {
    const user = caller()
    if (!user) upstreamError(status.PERMISSION_DENIED, 'Only a user can delete their own account')
    if (user.role === 'TRAINER' && trainerClients.some(([t]) => t === user.id)) {
      upstreamError(status.FAILED_PRECONDITION, `End your client relationships first: trainer ${user.id} has active clients`)
    }
    return {}
  },
  // Mirrors vertice-api's `ExportUserData`: self only, the caller's own document.
  ExportUserData: () => {
    const user = caller()
    if (!user) upstreamError(status.PERMISSION_DENIED, 'Only a user can export their own data')
    const u = find(users, user.id, 'User')
    return {
      json: JSON.stringify({
        formatVersion: 1,
        exportedAt: FAKE_CONSENT_AT,
        profile: { id: u.id, name: u.name, email: emailOf(u.id), cpf: cpfOf(u.id), role: u.role },
        consent: {},
        relationships: [],
        plans: [],
        workoutLogs: [],
        exercises: [],
      }),
    }
  },
  SetUserPassword: () => ({}),
  // Mirrors D10: a role other than `required_role` fails exactly like a wrong password.
  VerifyCredentials: (r) => {
    const user = users.find((u) => emailOf(u.id) === String(r.email).trim().toLowerCase())
    const requiredRole = r.requiredRole && r.requiredRole !== 'ROLE_UNSPECIFIED' ? r.requiredRole : undefined
    if (!user || withoutPassword.has(user.id) || r.password !== FAKE_PASSWORD || (requiredRole && requiredRole !== user.role)) {
      upstreamError(status.UNAUTHENTICATED, 'Invalid email or password')
    }
    // D10: only once the password and required_role matched.
    if (fakeSuspended.has(user.id)) upstreamError(status.FAILED_PRECONDITION, 'Account suspended')
    return userRes(user, 'contact')
  },

  // AdminAuthService (vertice-api D5, D8)
  GetSecondFactorState: (r) => ({
    state: secondFactorOf(r.userId).secret === 'enrolled' ? 'SECOND_FACTOR_STATE_ENROLLED' : 'SECOND_FACTOR_STATE_NOT_ENROLLED',
  }),
  StartSecondFactorEnrollment: (r) => {
    const factor = secondFactorOf(r.userId)
    if (factor.secret === 'enrolled') upstreamError(status.FAILED_PRECONDITION, 'Second factor already enrolled')
    factor.secret = 'pending'
    return {
      provisioningUri: `otpauth://totp/Vertice%20Admin:${encodeURIComponent(emailOf(Number(r.userId)))}?secret=FAKESECRET&issuer=Vertice%20Admin&algorithm=SHA1&digits=6&period=30`,
    }
  },
  VerifySecondFactor: (r) => {
    const factor = secondFactorOf(r.userId)
    const code = String(r.code)
    if (!/^[0-9]{6}$/.test(code)) upstreamError(status.INVALID_ARGUMENT, 'code: must be 6 digits')
    if (factor.locked) {
      upstreamError(status.RESOURCE_EXHAUSTED, `Too many second-factor attempts; retry after ${FAKE_LOCK_SECONDS} seconds`)
    }
    if (factor.secret === 'none') upstreamError(status.FAILED_PRECONDITION, 'Second factor not enrolled')
    if (!(FAKE_TOTP_CODES as readonly string[]).includes(code) || factor.used.has(code)) {
      factor.failures += 1
      if (factor.failures >= 5) Object.assign(factor, { failures: 0, locked: true })
      upstreamError(status.UNAUTHENTICATED, 'Invalid second-factor code')
    }
    factor.used.add(code)
    factor.failures = 0
    const enrolledNow = factor.secret === 'pending'
    factor.secret = 'enrolled'
    return { enrolledNow }
  },

  // AdminOpsService (vertice-api D9)
  CreateAdmin: (r) => {
    if (currentCaller !== 'service:ops') upstreamError(status.PERMISSION_DENIED, 'AdminOpsService is service:ops only')
    if (users.some((u) => emailOf(u.id) === String(r.email))) upstreamError(status.ALREADY_EXISTS, 'Email already in use')
    return { userId: '98', setupToken: setupTokenFor(98), expiresAt: '2099-01-01T00:00:00Z' }
  },
  IssueAdminSetupToken: (r) => ({ setupToken: setupTokenFor(opsAdmin(r.userId).id), expiresAt: '2099-01-01T00:00:00Z' }),
  ResetAdminSecondFactor: (r) => {
    secondFactors.delete(opsAdmin(r.userId).id)
    return {}
  },
  SuspendAdmin: (r) => {
    const admin = opsAdmin(r.userId)
    if (fakeSuspended.has(admin.id)) upstreamError(status.FAILED_PRECONDITION, `User ${admin.id} is already suspended`)
    fakeSuspended.add(admin.id)
    return {}
  },
  ReactivateAdmin: (r) => {
    const admin = opsAdmin(r.userId)
    if (!fakeSuspended.has(admin.id)) upstreamError(status.FAILED_PRECONDITION, `User ${admin.id} is not suspended`)
    fakeSuspended.delete(admin.id)
    return {}
  },
  // Any id: the user `CreateClientForTrainer` just created (id 99) isn't in the fixtures.
  CreatePasswordSetupToken: (r) => ({
    token: setupTokenFor(Number(r.userId)),
    expiresAt: '2099-01-01T00:00:00Z',
  }),
  RedeemPasswordSetupToken: (r) => {
    const userId = Number(/^issued-(\d+)$/.exec(String(r.token))?.[1])
    const user = users.find((u) => u.id === userId)
    if (!user) {
      upstreamError(status.UNAUTHENTICATED, 'Invalid or expired password setup token')
    }
    return userRes(user, 'contact')
  },
  ListUsersWithoutPassword: (r) => ({
    users: users
      .filter((u) => withoutPassword.has(u.id) && (!r.role || r.role === 'ROLE_UNSPECIFIED' || r.role === u.role))
      .map((u) => userRes(u, 'summary')),
  }),

  // ExerciseService
  ListMuscleGroups: () => ({ muscleGroups: FAKE_MUSCLE_GROUPS.map((m) => ({ id: str(m.id), name: m.name })) }),
  ListExercises: () => ({ exercises: [exerciseRes()], nextPageToken: '' }),
  GetExercise: (r) => getVisibleExercise(r.id),
  CreateExercise: () => exerciseRes(),
  UpdateExercise: (r) => exerciseRes(getOwnedExercise(r.id, 'changed')),
  DeleteExercise: (r) => {
    const exercise = getOwnedExercise(r.id, 'deleted')
    if (exercise.inUse) {
      upstreamError(status.FAILED_PRECONDITION, `Exercise ${exercise.id} is used by a workout and cannot be deleted`)
    }
    return {}
  },

  // TrainingPlanService
  ListTrainingPlans: (r) => ({
    trainingPlans: plans
      .filter((p) => byNumber(r.trainerId, p.trainerId) && byNumber(r.clientId, p.clientId))
      .map(planRes),
  }),
  GetTrainingPlan: (r) => planRes(find(plans, r.id, 'TrainingPlan')),
  CreateTrainingPlan: () => planRes(plans[0]!),
  UpdateTrainingPlan: (r) => planRes(find(plans, r.id, 'TrainingPlan')),
  DeleteTrainingPlan: () => ({}),

  // WorkoutService
  ListWorkouts: (r) => ({
    workouts: workouts.filter((w) => w.trainingPlanId === Number(r.trainingPlanId)).map(workoutRes),
  }),
  GetWorkout: (r) => workoutRes(find(workouts, r.id, 'Workout')),
  UpdateWorkout: (r) => workoutRes(find(workouts, r.id, 'Workout')),
  DeleteWorkout: () => ({}),
  CloneWorkout: () => workoutRes(workouts[0]!),
  CreateWorkoutWithExercises: () => workoutRes(workouts[0]!),
  ReplaceWorkoutExercises: (r) => workoutRes(find(workouts, r.workoutId, 'Workout')),

  // WorkoutExerciseService
  ListWorkoutExercises: (r) => ({
    workoutExercises: workoutExercises.filter((we) => we.workoutId === Number(r.workoutId)).map(workoutExerciseRes),
  }),
  GetWorkoutExercise: (r) => workoutExerciseRes(find(workoutExercises, r.id, 'WorkoutExercise')),
  CreateWorkoutExercise: () => workoutExerciseRes(workoutExercises[0]!),
  UpdateWorkoutExercise: (r) => workoutExerciseRes(find(workoutExercises, r.id, 'WorkoutExercise')),
  DeleteWorkoutExercise: () => ({}),

  // ExerciseSetService
  ListExerciseSets: (r) => ({
    exerciseSets: exerciseSets
      .filter((s) => s.workoutExerciseId === Number(r.workoutExerciseId))
      .map(exerciseSetRes),
  }),
  GetExerciseSet: (r) => exerciseSetRes(find(exerciseSets, r.id, 'ExerciseSet')),
  CreateExerciseSet: () => exerciseSetRes(exerciseSets[0]!),
  UpdateExerciseSet: (r) => exerciseSetRes(find(exerciseSets, r.id, 'ExerciseSet')),
  DeleteExerciseSet: () => ({}),

  // WorkoutSessionService
  GetOrStartWorkoutLog: (r) =>
    workoutLogRes(
      workoutLogs.find((l) => l.workoutId === Number(r.workoutId) && l.clientId === Number(r.clientId)) ??
        workoutLogs[0]!,
    ),
  GetWorkoutLog: (r) => workoutLogRes(find(workoutLogs, r.id, 'WorkoutLog')),
  RecordSetLog: (r) => ({
    id: '900',
    workoutLogId: str(Number(r.workoutLogId)),
    exerciseSetId: str(Number(r.exerciseSetId)),
    weight: r.weight,
    reps: r.reps,
    recordedAt: `${today}T08:05:00Z`,
  }),
  CompleteWorkoutLog: (r) => ({
    ...workoutLogRes(find(workoutLogs, r.id, 'WorkoutLog')),
    completedAt: `${today}T09:00:00Z`,
    status: 'WORKOUT_LOG_STATUS_COMPLETED',
    completionKind: 'COMPLETION_KIND_CLIENT',
  }),
  RestartWorkoutLog: (r) => ({
    ...workoutLogRes(
      workoutLogs.find((l) => l.workoutId === Number(r.workoutId) && l.clientId === Number(r.clientId)) ??
        workoutLogs[0]!,
    ),
    id: '901',
  }),
  DiscardWorkoutLog: () => ({}),
  DeleteSetLog: () => ({}),
  ListSetLogs: () => ({ setLogs: [] }),
  ListWorkoutLogs: (r) => ({
    workoutLogs: workoutLogs
      .filter((l) => l.clientId === Number(r.clientId))
      .filter((l) => find(workouts, l.workoutId, 'Workout').trainingPlanId === Number(r.trainingPlanId))
      .map(workoutLogRes),
  }),
  GetLastSetLogs: () => ({ setLogs: [] }),
  GetExerciseProgress: () => ({ points: [{ weekStartDate: today, weight: '20' }] }),
  ListProgressExercises: () => ({ exercises: [{ id: String(exercises[0]!.id), name: 'Supino' }] }),

  // WorkoutFeedbackService
  SubmitWorkoutFeedback: (r) => {
    const log = find(workoutLogs, r.workoutLogId, 'WorkoutLog')
    const workout = find(workouts, log.workoutId, 'Workout')
    return {
      id: '800',
      workoutLogId: str(log.id),
      workoutId: str(workout.id),
      trainingPlanId: str(workout.trainingPlanId),
      clientId: str(log.clientId),
      text: r.text,
      rating: r.rating,
      replaced: false,
      createdAt: `${today}T09:00:00Z`,
    }
  },
  ListWorkoutFeedback: () => ({ workoutFeedback: [] }),

  // AdminService
  ...adminHandlers,
  ...adminCatalogHandlers,
  ...featureFlagHandlers,

  // TrainerClientService
  CreateClientForTrainer: (r) => ({ ...userRes(users[3]!, 'detail'), id: '99', email: r.email, cpf: r.cpf }),
  ListClientsForTrainer: (r) => ({
    clients: trainerClients
      .filter(([t]) => t === Number(r.trainerId))
      .map(([, c]) => ({ ...userRes(find(users, c, 'User'), 'summary'), suspended: fakeSuspended.has(c) })),
  }),
  // Mirrors vertice-api: the trainer for their own trainer_id and an active client (anything else,
  // a missing client included, is PERMISSION_DENIED), or ADMIN. Stateless, like DeleteAccount.
  EndTrainerClientRelationship: (r) => {
    const user = caller()
    const active = trainerClients.some(([t, c]) => t === Number(r.trainerId) && c === Number(r.clientId))
    if (user?.role === 'ADMIN') {
      if (!active) upstreamError(status.NOT_FOUND, 'No active relationship')
      recordAdminAction('END_RELATIONSHIP', Number(r.clientId))
      return {}
    }
    if (user?.role !== 'TRAINER' || user.id !== Number(r.trainerId) || !active) {
      upstreamError(status.PERMISSION_DENIED, 'This client is not one of your clients')
    }
    return {}
  },
  GetClientTrainer: (r) => {
    const link = trainerClients.find(([, c]) => c === Number(r.clientId))
    if (!link) throw Object.assign(new Error('not found'), { code: 5 })
    const trainer = find(users, link[0], 'User')
    return { trainerId: str(trainer.id), name: trainer.name, email: '', whatsapp: '11987654321', instagram: '' }
  },
  IsTrainersClient: (r) => ({
    isClient: trainerClients.some(([t, c]) => t === Number(r.trainerId) && c === Number(r.clientId)),
  }),
}

/** RPCs that change upstream state. A refused request must never reach one. */
export const isWriteRpc = (method: string) =>
  /^(Create|Update|Delete|Remove|Set|Clone|Replace|Record|Complete|Submit|GetOrStart|End|Restart|Discard|Start|Verify|Issue|Reset|Suspend|Reactivate|Send|Promote|Rename)/.test(method) &&
  method !== 'VerifyCredentials'

/** How late the fake answers `method`; only `EvaluateFeatureFlag` can be delayed. */
const delayOf = (method: string) => (method === 'EvaluateFeatureFlag' ? fakeFlagEvaluation.delayMs : 0)

/**
 * Drop-in implementation for the mocked `grpcCall`; unknown methods, and calls without a valid
 * caller token, fail loudly. Honours `options.deadlineMs` like grpc-js: an answer delayed by at
 * least the deadline rejects with what `grpcCall` maps `DEADLINE_EXCEEDED` to, when the deadline
 * passes; a shorter delay resolves with the handler's answer.
 */
export async function fakeGrpcCall(
  _client: unknown,
  method: string,
  request: unknown,
  options: GrpcCallOptions = {},
): Promise<never> {
  const handler = handlers[method]
  if (!handler) throw new Error(`fakeUpstream: no handler for ${method}`)
  const callerOfCall = authenticateCall(method, options)
  upstreamCallers.push({
    method,
    caller: callerOfCall,
    ...(options.deadlineMs !== undefined && { deadlineMs: options.deadlineMs }),
  })
  const delayMs = delayOf(method)
  if (delayMs > 0) {
    const { deadlineMs } = options
    if (deadlineMs !== undefined && delayMs >= deadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, deadlineMs))
      throw mapGrpcError({ code: status.DEADLINE_EXCEEDED, details: 'Deadline exceeded' })
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  currentCaller = callerOfCall
  try {
    return handler((request ?? {}) as Req) as never
  } finally {
    currentCaller = undefined
  }
}
