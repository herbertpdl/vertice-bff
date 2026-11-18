import { adminCatalogClient, adminClient, trainerClientClient, userClient } from '../../grpc/clients.js'
import { grpcCall, UPSTREAM_MESSAGES } from '../../grpc/call.js'
import {
  ConflictError,
  HttpError,
  PreconditionFailedError,
  TooManyRequestsError,
  UpstreamExhaustedError,
} from '../../lib/errors.js'
import { requestContext } from '../../lib/request-context.js'
import {
  toExercise,
  toExerciseRequest,
  toMuscleGroup,
  type Exercise,
  type ExerciseInput,
  type ExerciseRequest,
  type ExerciseResponse,
  type MuscleGroup,
  type MuscleGroupResponse,
} from '../exercises/service.js'
import type { Role } from '../users/service.js'
import type {
  AdminAction,
  AdminActionsQuery,
  AdminCatalogQuery,
  AdminDirectoryQuery,
  AdminMostUsedQuery,
} from './schemas.js'

/**
 * The admin panel's reads (admin-panel spec §2.2, B12, B13, B16): one `AdminService` RPC per route,
 * with the caller's admin token, reshaped field by field. vertice-api decides who is visible (no
 * admins, no deleted accounts), what a profile holds (D18: no logs, weights, feedback or plan
 * contents exist upstream to leak) and the order of every list; the BFF only renames, turns empty
 * strings and unset messages into `null`, and strips the enum prefixes.
 */

// ---- wire shapes (proto-loader: int64 as string, unset message as null, enums as names) --------

interface UserRefResponse {
  id: string
  name: string
  role: string
}

interface GetDashboardResponse {
  trainers: string
  clients: string
  activeTrainers7d: string
  activeClients7d: string
  activeTrainers30d: string
  activeClients30d: string
  completedWorkouts7d: string
  completedWorkouts30d: string
  weeklySignups: { weekStart: string; trainers: string; clients: string }[]
}

interface DirectoryUserResponse {
  id: string
  name: string
  email: string
  role: string
  suspended: boolean
  createdAt: string
  lastActiveOn: string
  currentTrainer: UserRefResponse | null
  currentClientCount: number
}

interface ProfileBasicsResponse {
  id: string
  name: string
  email: string
  cpfMasked: string
  suspended: boolean
  suspendedAt: string
  createdAt: string
  lastActiveOn: string
}

interface RelationshipRefResponse {
  user: UserRefResponse | null
  startedAt: string
  endedAt: string
  suspended: boolean
}

interface TrainerProfileResponse {
  basics: ProfileBasicsResponse | null
  cref: string
  whatsapp: string
  instagram: string
  currentClients: RelationshipRefResponse[]
  formerClients: RelationshipRefResponse[]
  planCount: number
  workoutCount: number
  privateExerciseCount: number
}

interface ClientProfileResponse {
  basics: ProfileBasicsResponse | null
  currentTrainer: RelationshipRefResponse | null
  pastTrainers: RelationshipRefResponse[]
  planCount: number
  completedWorkoutCount: number
  firstAccess: { pending: boolean; lastSentAt: string; lastSendFailed: boolean } | null
}

interface GetUserProfileResponse {
  trainer?: TrainerProfileResponse | null
  client?: ClientProfileResponse | null
  profile?: 'trainer' | 'client'
}

interface ActionEntryResponse {
  id: string
  admin: UserRefResponse | null
  action: string
  targetUser: UserRefResponse | null
  relatedUser: UserRefResponse | null
  targetExerciseId: string
  targetMuscleGroupId: string
  subjectLabel: string
  reason: string
  createdAt: string
}

// ---- REST shapes ---------------------------------------------------------------------------------

/** A user as the panel names them. A deleted account reads "Usuário removido" (R72). */
export interface AdminUserRef {
  id: number
  name: string
  role: Role
}

export interface AdminDashboard {
  totals: { trainers: number; clients: number }
  active: { trainers7d: number; clients7d: number; trainers30d: number; clients30d: number }
  completedWorkouts: { last7d: number; last30d: number }
  /** 12 weeks, oldest first; the last one is the current (partial) week. */
  weeklySignups: { weekStart: string; trainers: number; clients: number }[]
}

export interface AdminDirectoryUser {
  id: number
  name: string
  email: string
  role: 'TRAINER' | 'CLIENT'
  suspended: boolean
  createdAt: string
  lastActiveOn: string | null
  /** Clients only (R31); null for a client with no current trainer, and for every trainer. */
  currentTrainer: { id: number; name: string } | null
  /** Trainers only (R32); null for every client. */
  currentClientCount: number | null
}

/** `POST /admin/users/:id/suspend` and `/reactivate`: the row as it is now, for list and profile. */
export interface AdminUserResult {
  user: AdminDirectoryUser
}

export interface AdminDirectoryPage {
  users: AdminDirectoryUser[]
  nextCursor: string | null
}

export interface AdminRelationship {
  user: AdminUserRef
  startedAt: string
  endedAt: string | null
  suspended: boolean
}

interface AdminProfileBasics {
  id: number
  name: string
  email: string
  cpf: string | null
  suspended: boolean
  suspendedAt: string | null
  createdAt: string
  lastActiveOn: string | null
}

export interface AdminTrainerProfile extends AdminProfileBasics {
  role: 'TRAINER'
  cref: string | null
  whatsapp: string | null
  instagram: string | null
  currentClients: AdminRelationship[]
  formerClients: AdminRelationship[]
  planCount: number
  workoutCount: number
  privateExerciseCount: number
}

export interface AdminClientProfile extends AdminProfileBasics {
  role: 'CLIENT'
  currentTrainer: AdminRelationship | null
  pastTrainers: AdminRelationship[]
  planCount: number
  completedWorkoutCount: number
  firstAccess: { pending: boolean; lastSentAt: string | null; lastSendFailed: boolean }
}

export type AdminUserProfile = AdminTrainerProfile | AdminClientProfile

export interface AdminActionEntry {
  id: number
  admin: AdminUserRef
  action: AdminAction
  targetUser: AdminUserRef | null
  relatedUser: AdminUserRef | null
  targetExerciseId: number | null
  targetMuscleGroupId: number | null
  subjectLabel: string | null
  reason: string | null
  createdAt: string
}

export interface AdminActionPage {
  entries: AdminActionEntry[]
  nextCursor: string | null
}

export interface AdminActionAdmins {
  admins: AdminUserRef[]
}

// ---- mapping -------------------------------------------------------------------------------------

const orNull = (value: string): string | null => (value === '' ? null : value)
const idOrNull = (value: string): number | null => (Number(value) > 0 ? Number(value) : null)

function toUserRef(r: UserRefResponse): AdminUserRef {
  return { id: Number(r.id), name: r.name, role: r.role as Role }
}

function toRelationship(r: RelationshipRefResponse): AdminRelationship {
  return {
    user: toUserRef(r.user ?? { id: '0', name: '', role: 'ROLE_UNSPECIFIED' }),
    startedAt: r.startedAt,
    endedAt: orNull(r.endedAt),
    suspended: r.suspended,
  }
}

/**
 * vertice-api sends `***.***.***-NN` (D18) or an empty string. Anything else is not trusted: it
 * becomes `null` with a WARN line (never the value), so a regression upstream can't put a full CPF
 * on the admin's screen (B13, fail closed).
 */
const MASKED_CPF = /^\*\*\*\.\*\*\*\.\*\*\*-\d{2}$/
export function checkedMaskedCpf(cpfMasked: string, userId: number): string | null {
  if (cpfMasked === '') return null
  if (MASKED_CPF.test(cpfMasked)) return cpfMasked
  requestContext.getStore()?.log?.warn({ userId }, 'GetUserProfile returned a CPF that is not masked; dropped')
  return null
}

function toBasics(b: ProfileBasicsResponse): AdminProfileBasics {
  const id = Number(b.id)
  return {
    id,
    name: b.name,
    email: b.email,
    cpf: checkedMaskedCpf(b.cpfMasked, id),
    suspended: b.suspended,
    suspendedAt: orNull(b.suspendedAt),
    createdAt: b.createdAt,
    lastActiveOn: orNull(b.lastActiveOn),
  }
}

/** `DIRECTORY_ROLE_TRAINER` → `TRAINER` on the way in, the other way (spec §1). */
const withPrefix = (prefix: string, value: string | undefined) => (value ? `${prefix}${value}` : `${prefix}UNSPECIFIED`)
const ACTION_PREFIX = 'ADMIN_ACTION_'

export function toDirectoryUser(u: DirectoryUserResponse): AdminDirectoryUser {
  const role = u.role as AdminDirectoryUser['role']
  return {
    id: Number(u.id),
    name: u.name,
    email: u.email,
    role,
    suspended: u.suspended,
    createdAt: u.createdAt,
    lastActiveOn: orNull(u.lastActiveOn),
    currentTrainer:
      role === 'CLIENT' && u.currentTrainer ? { id: Number(u.currentTrainer.id), name: u.currentTrainer.name } : null,
    currentClientCount: role === 'TRAINER' ? u.currentClientCount : null,
  }
}

export function toUserProfile(res: GetUserProfileResponse): AdminUserProfile {
  if (res.trainer?.basics) {
    const t = res.trainer
    return {
      ...toBasics(t.basics!),
      role: 'TRAINER',
      cref: orNull(t.cref),
      whatsapp: orNull(t.whatsapp),
      instagram: orNull(t.instagram),
      currentClients: t.currentClients.map(toRelationship),
      formerClients: t.formerClients.map(toRelationship),
      planCount: t.planCount,
      workoutCount: t.workoutCount,
      privateExerciseCount: t.privateExerciseCount,
    }
  }
  if (res.client?.basics) {
    const c = res.client
    return {
      ...toBasics(c.basics!),
      role: 'CLIENT',
      currentTrainer: c.currentTrainer ? toRelationship(c.currentTrainer) : null,
      pastTrainers: c.pastTrainers.map(toRelationship),
      planCount: c.planCount,
      completedWorkoutCount: c.completedWorkoutCount,
      firstAccess: {
        pending: c.firstAccess?.pending ?? false,
        lastSentAt: orNull(c.firstAccess?.lastSentAt ?? ''),
        lastSendFailed: c.firstAccess?.lastSendFailed ?? false,
      },
    }
  }
  // Neither arm set: not a shape vertice-api answers. A 502 (a bad upstream answer, as `grpcCall`
  // maps one) rather than an empty profile or a 500 that would point at the BFF.
  requestContext.getStore()?.log?.warn({ rpc: 'GetUserProfile' }, 'GetUserProfile answered no profile')
  throw new HttpError(502, UPSTREAM_MESSAGES.upstreamError, 'UPSTREAM_ERROR')
}

export function toActionEntry(e: ActionEntryResponse): AdminActionEntry {
  return {
    id: Number(e.id),
    admin: toUserRef(e.admin ?? { id: '0', name: '', role: 'ADMIN' }),
    action: e.action.replace(ACTION_PREFIX, '') as AdminAction,
    targetUser: e.targetUser ? toUserRef(e.targetUser) : null,
    relatedUser: e.relatedUser ? toUserRef(e.relatedUser) : null,
    targetExerciseId: idOrNull(e.targetExerciseId),
    targetMuscleGroupId: idOrNull(e.targetMuscleGroupId),
    subjectLabel: orNull(e.subjectLabel),
    reason: orNull(e.reason),
    createdAt: e.createdAt,
  }
}

// ---- calls ---------------------------------------------------------------------------------------

export async function getDashboard(): Promise<AdminDashboard> {
  const r = await grpcCall<Record<string, never>, GetDashboardResponse>(adminClient, 'GetDashboard', {})
  return {
    totals: { trainers: Number(r.trainers), clients: Number(r.clients) },
    active: {
      trainers7d: Number(r.activeTrainers7d),
      clients7d: Number(r.activeClients7d),
      trainers30d: Number(r.activeTrainers30d),
      clients30d: Number(r.activeClients30d),
    },
    completedWorkouts: { last7d: Number(r.completedWorkouts7d), last30d: Number(r.completedWorkouts30d) },
    weeklySignups: r.weeklySignups.map((w) => ({
      weekStart: w.weekStart,
      trainers: Number(w.trainers),
      clients: Number(w.clients),
    })),
  }
}

export async function listDirectoryUsers(query: AdminDirectoryQuery): Promise<AdminDirectoryPage> {
  const res = await grpcCall<
    { role: string; status: string; search: string; pageSize: number; pageToken: string },
    { users: DirectoryUserResponse[]; nextPageToken: string }
  >(adminClient, 'ListDirectoryUsers', {
    role: withPrefix('DIRECTORY_ROLE_', query.role),
    status: withPrefix('DIRECTORY_STATUS_', query.status),
    search: query.q ?? '',
    pageSize: query.limit,
    pageToken: query.cursor ?? '',
  })
  return { users: res.users.map(toDirectoryUser), nextCursor: res.nextPageToken || null }
}

/**
 * Writes a `VIEW_USER_PROFILE` history entry upstream on every call (D17): not a side-effect-free
 * read, so clients must not refetch or poll it. A missing, deleted or admin id (the caller
 * included) is vertice-api's NOT_FOUND, the global 404.
 */
export async function getUserProfile(userId: number): Promise<AdminUserProfile> {
  const res = await grpcCall<{ userId: number }, GetUserProfileResponse>(adminClient, 'GetUserProfile', { userId })
  return toUserProfile(res)
}

export async function listActions(query: AdminActionsQuery): Promise<AdminActionPage> {
  const res = await grpcCall<
    { adminId: number; action: string; targetUserId: number; pageSize: number; pageToken: string },
    { entries: ActionEntryResponse[]; nextPageToken: string }
  >(adminClient, 'ListActions', {
    adminId: query.adminId ?? 0,
    action: withPrefix(ACTION_PREFIX, query.action),
    targetUserId: query.targetUserId ?? 0,
    pageSize: query.limit,
    pageToken: query.cursor ?? '',
  })
  return { entries: res.entries.map(toActionEntry), nextCursor: res.nextPageToken || null }
}

export async function listActionAdmins(): Promise<AdminActionAdmins> {
  const res = await grpcCall<Record<string, never>, { admins: UserRefResponse[] }>(adminClient, 'ListActionAdmins', {})
  return { admins: res.admins.map(toUserRef) }
}

// ---- writes (VRT-28, spec §2.3) --------------------------------------------------------------------

/**
 * Suspends or reactivates a trainer or client (R39, R44). vertice-api re-validates the reason,
 * refuses a missing, deleted or admin target (NOT_FOUND, the 404) and a repeat (FAILED_PRECONDITION
 * "already suspended" / "not suspended", the generic 409 `PRECONDITION_FAILED`: refetch the
 * profile), and writes the history entry with the reason in the same transaction.
 */
export async function setSuspended(userId: number, suspend: boolean, reason: string): Promise<AdminUserResult> {
  const res = await grpcCall<{ userId: number; reason: string }, { user: DirectoryUserResponse | null }>(
    adminClient,
    suspend ? 'SuspendUser' : 'ReactivateUser',
    { userId, reason },
  )
  if (!res.user) {
    requestContext.getStore()?.log?.warn({ rpc: suspend ? 'SuspendUser' : 'ReactivateUser' }, 'Answered no user')
    throw new HttpError(502, UPSTREAM_MESSAGES.upstreamError, 'UPSTREAM_ERROR')
  }
  return { user: toDirectoryUser(res.user) }
}

/** `Retry-After` for a send limit whose upstream text has no seconds (spec B11). */
const DEFAULT_EMAIL_RETRY_SECONDS = 60
export const EMAIL_LIMIT_MESSAGE = 'Too many e-mails to this user, try again later'

/**
 * The account e-mails' one route-specific mapping (B11): a send limit (RESOURCE_EXHAUSTED, 1 per
 * minute and 5 per 24h per user) is 429 `RATE_LIMITED` with `Retry-After` = vertice-api's N, not
 * the global 413. Everything else keeps the global mapping: FAILED_PRECONDITION (e-mails switched
 * off, the only one these RPCs send) is 409 `PRECONDITION_FAILED`, UNAVAILABLE (every try failed)
 * 503 `UPSTREAM_UNAVAILABLE`, NOT_FOUND 404.
 */
async function sendAccountEmail(call: () => Promise<unknown>): Promise<void> {
  try {
    await call()
  } catch (err) {
    if (err instanceof UpstreamExhaustedError) {
      throw new TooManyRequestsError(EMAIL_LIMIT_MESSAGE, err.retryAfterSeconds ?? DEFAULT_EMAIL_RETRY_SECONDS)
    }
    throw err
  }
}

/**
 * E-mails a client a new first-access link (`SendFirstAccessEmail`, R47). The answer upstream
 * carries the client's first-access status; none of it is returned (R49: status only, the 204).
 * A trainer target, or a missing or deleted one, is vertice-api's NOT_FOUND.
 */
export async function sendFirstAccessEmail(userId: number): Promise<void> {
  await sendAccountEmail(() => grpcCall(userClient, 'SendFirstAccessEmail', { userId }))
}

/** E-mails a trainer or client a password-reset link (`SendPasswordResetEmail`, R48); 204, never the link. */
export async function sendPasswordResetEmail(userId: number): Promise<void> {
  await sendAccountEmail(() => grpcCall(adminClient, 'SendPasswordResetEmail', { userId }))
}

/**
 * Ends a trainer-client relationship (`EndTrainerClientRelationship` with the admin token, R50, B17):
 * both ids, since an admin has no side-effect-free read of the trainer. Nothing but `ended_at`
 * changes upstream; no active relationship for the pair is vertice-api's NOT_FOUND.
 */
export async function endRelationship(trainerId: number, clientId: number): Promise<void> {
  await grpcCall(trainerClientClient, 'EndTrainerClientRelationship', { trainerId, clientId })
}

// ---- exercise curation (VRT-31, spec §2.4, B11, B18) -----------------------------------------------

interface CatalogExerciseResponse {
  exercise: ExerciseResponse | null
  owner: UserRefResponse | null
}

/**
 * A catalog row as the panel shows it: the trainer's `Exercise` shape plus the owner of a private
 * exercise (R23, R56). `owner` is null for a starter exercise; a deleted trainer reads
 * "Usuário removido" (R72).
 */
export interface AdminCatalogExercise extends Exercise {
  owner: { id: number; name: string } | null
}

export interface AdminCatalogPage {
  exercises: AdminCatalogExercise[]
  nextCursor: string | null
}

export interface AdminMostUsedExercise {
  exercise: AdminCatalogExercise
  /** Distinct workouts that currently contain the exercise; at least 1. */
  workoutCount: number
}

export interface AdminMostUsedPage {
  exercises: AdminMostUsedExercise[]
  nextCursor: string | null
}

export const NAME_TAKEN_MESSAGE = 'Name already in use'
export const EXERCISE_IN_USE_MESSAGE = 'The exercise is used by a workout and cannot be deleted'

/** An unset `exercise` in a catalog answer is not a shape vertice-api sends: a 502, as `GetUserProfile`'s. */
function missingExercise(rpc: string): never {
  requestContext.getStore()?.log?.warn({ rpc }, 'Answered no exercise')
  throw new HttpError(502, UPSTREAM_MESSAGES.upstreamError, 'UPSTREAM_ERROR')
}

export function toCatalogExercise(r: CatalogExerciseResponse | null, rpc: string): AdminCatalogExercise {
  if (!r?.exercise) missingExercise(rpc)
  const exercise = toExercise(r.exercise)
  return {
    ...exercise,
    owner: !exercise.isStarter && r.owner ? { id: Number(r.owner.id), name: r.owner.name } : null,
  }
}

/**
 * The catalog writes' one per-route mapping (B11): ALREADY_EXISTS is a duplicate name ignoring case
 * and accents (the only unique key these RPCs touch; also its constraint-race fallback), 409
 * `NAME_TAKEN` instead of the global `CONFLICT` "Email or CPF already in use".
 */
async function catalogWrite<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof ConflictError) throw new HttpError(409, NAME_TAKEN_MESSAGE, 'NAME_TAKEN')
    throw err
  }
}

/** `ListCatalogExercises`: starter first, then by name, then id, in upstream order. */
export async function listCatalogExercises(query: AdminCatalogQuery): Promise<AdminCatalogPage> {
  const res = await grpcCall<
    { scope: string; muscleGroupId: number; ownerId: number; search: string; pageSize: number; pageToken: string },
    { exercises: CatalogExerciseResponse[]; nextPageToken: string }
  >(adminCatalogClient, 'ListCatalogExercises', {
    scope: `CATALOG_SCOPE_${query.scope ?? 'UNSPECIFIED'}`,
    muscleGroupId: query.muscleGroupId ?? 0,
    ownerId: query.ownerId ?? 0,
    search: query.q ?? '',
    pageSize: query.limit,
    pageToken: query.cursor ?? '',
  })
  return {
    exercises: res.exercises.map((e) => toCatalogExercise(e, 'ListCatalogExercises')),
    nextCursor: res.nextPageToken || null,
  }
}

/** `ListMostUsedExercises`: workout count descending, then id (R22-R25). */
export async function listMostUsedExercises(query: AdminMostUsedQuery): Promise<AdminMostUsedPage> {
  const res = await grpcCall<
    { muscleGroupId: number; pageSize: number; pageToken: string },
    { exercises: { exercise: CatalogExerciseResponse | null; workoutCount: string }[]; nextPageToken: string }
  >(adminCatalogClient, 'ListMostUsedExercises', {
    muscleGroupId: query.muscleGroupId ?? 0,
    pageSize: query.limit,
    pageToken: query.cursor ?? '',
  })
  return {
    exercises: res.exercises.map((e) => ({
      exercise: toCatalogExercise(e.exercise, 'ListMostUsedExercises'),
      workoutCount: Number(e.workoutCount),
    })),
    nextCursor: res.nextPageToken || null,
  }
}

/** `CreateStarterExercise` (R52). Duplicate starter name: 409 `NAME_TAKEN`. */
export async function createStarterExercise(input: ExerciseInput): Promise<AdminCatalogExercise> {
  const res = await catalogWrite(() =>
    grpcCall<{ exercise: ExerciseRequest }, { exercise: CatalogExerciseResponse | null }>(
      adminCatalogClient,
      'CreateStarterExercise',
      { exercise: toExerciseRequest(input) },
    ),
  )
  return toCatalogExercise(res.exercise, 'CreateStarterExercise')
}

/**
 * `UpdateStarterExercise`, a full replace (B18, R53): the edit shows everywhere the exercise is
 * used. A private exercise is PERMISSION_DENIED upstream, the global 403 (R57); missing, 404.
 */
export async function updateStarterExercise(id: number, input: ExerciseInput): Promise<AdminCatalogExercise> {
  const res = await catalogWrite(() =>
    grpcCall<{ id: number; exercise: ExerciseRequest }, { exercise: CatalogExerciseResponse | null }>(
      adminCatalogClient,
      'UpdateStarterExercise',
      { id, exercise: toExerciseRequest(input) },
    ),
  )
  return toCatalogExercise(res.exercise, 'UpdateStarterExercise')
}

/**
 * `DeleteStarterExercise` (R55). Every FAILED_PRECONDITION this RPC sends means "a workout uses
 * it": vertice-api's check ("Exercise <id> is used by a workout…") and, when a workout added it
 * between that check and the delete, the foreign-key fallback ("…the record is still in use…").
 * Both are 409 `EXERCISE_IN_USE`, so the web says the same thing for the same situation. A private
 * exercise is the global 403, a missing one 404.
 */
export async function deleteStarterExercise(id: number): Promise<void> {
  try {
    await grpcCall(adminCatalogClient, 'DeleteStarterExercise', { id })
  } catch (err) {
    if (err instanceof PreconditionFailedError) throw new HttpError(409, EXERCISE_IN_USE_MESSAGE, 'EXERCISE_IN_USE')
    throw err
  }
}

/**
 * `PromoteExercise` (R58-R60): a starter copy of a trainer's private exercise, with the admin's
 * edits; the trainer's row is untouched. A source that is already a starter exercise is
 * FAILED_PRECONDITION, kept as the generic 409 `PRECONDITION_FAILED`; a duplicate name `NAME_TAKEN`.
 */
export async function promoteExercise(sourceExerciseId: number, input: ExerciseInput): Promise<AdminCatalogExercise> {
  const res = await catalogWrite(() =>
    grpcCall<{ sourceExerciseId: number; exercise: ExerciseRequest }, { exercise: CatalogExerciseResponse | null }>(
      adminCatalogClient,
      'PromoteExercise',
      { sourceExerciseId, exercise: toExerciseRequest(input) },
    ),
  )
  return toCatalogExercise(res.exercise, 'PromoteExercise')
}

function toMuscleGroupResult(res: { muscleGroup: MuscleGroupResponse | null }, rpc: string): MuscleGroup {
  if (!res.muscleGroup) {
    requestContext.getStore()?.log?.warn({ rpc }, 'Answered no muscle group')
    throw new HttpError(502, UPSTREAM_MESSAGES.upstreamError, 'UPSTREAM_ERROR')
  }
  return toMuscleGroup(res.muscleGroup)
}

/** `CreateMuscleGroup` (R61): listed last by `GET /muscle-groups`. Duplicate name: `NAME_TAKEN` (R65). */
export async function createMuscleGroup(name: string): Promise<MuscleGroup> {
  const res = await catalogWrite(() =>
    grpcCall<{ name: string }, { muscleGroup: MuscleGroupResponse | null }>(adminCatalogClient, 'CreateMuscleGroup', { name }),
  )
  return toMuscleGroupResult(res, 'CreateMuscleGroup')
}

/** `RenameMuscleGroup` (R62): shown everywhere at once. Missing: 404; duplicate name: `NAME_TAKEN`. */
export async function renameMuscleGroup(id: number, name: string): Promise<MuscleGroup> {
  const res = await catalogWrite(() =>
    grpcCall<{ id: number; name: string }, { muscleGroup: MuscleGroupResponse | null }>(
      adminCatalogClient,
      'RenameMuscleGroup',
      { id, name },
    ),
  )
  return toMuscleGroupResult(res, 'RenameMuscleGroup')
}
