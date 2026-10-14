import { status } from '@grpc/grpc-js'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { mapGrpcError, withCallerIdentity, type GrpcCallOptions } from '../grpc/call.js'
import {
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

/** Every fixture user's password, except client A2's: a trainer-created client who hasn't set one yet. */
export const FAKE_PASSWORD = 'correct-horse-battery'
const withoutPassword = new Set<number>([ids.clientA2])

/** What the fake `CreatePasswordSetupToken` issues; `SetPasswordWithToken` accepts only these. */
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

export function bearer(actor: Actor) {
  const u = userOf(actor)
  return { authorization: `Bearer ${signToken({ id: u.id, role: u.role })}` }
}

export const emailOf = (id: number) => `user${id}@vertice.test`
const str = (n: number) => String(n)
const today = new Date().toISOString().slice(0, 10)

function find<T extends { id: number }>(rows: T[], id: unknown, what: string): T {
  const row = rows.find((r) => r.id === Number(id))
  if (!row) upstreamError(status.NOT_FOUND, what)
  return row
}

const userRes = (u: (typeof users)[number]) => ({
  id: str(u.id),
  name: u.name,
  email: emailOf(u.id),
  cpf: '',
  cref: '',
  role: u.role,
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
})
const exercises: { id: number; ownerId: number | null; inUse?: true }[] = [
  { id: ids.exercise, ownerId: null },
  { id: ids.privateExerciseB, ownerId: ids.trainerB },
  { id: ids.privateExerciseA, ownerId: ids.trainerA },
  { id: ids.inUseExerciseA, ownerId: ids.trainerA, inUse: true },
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
  'service:bff': ['VerifyCredentials', 'CreateUser', 'SetPasswordWithToken'],
  'service:ops': ['ListUsers', 'CreatePasswordSetupToken'],
}

/**
 * Mimics vertice-api's `local` profile, which lets a call without a token through (the
 * `VERIFY_PASSWORDS=false` dev login relies on it). Off by default: every call needs a token.
 */
export const fakeUpstreamProfile = { local: false }

export type UpstreamCaller = AuthUser | 'service:bff' | 'service:ops' | 'anonymous'

/** The caller of every call the fake served, in order. Cleared with `resetUpstreamCallers()`. */
export const upstreamCallers: { method: string; caller: UpstreamCaller }[] = []
export const resetUpstreamCallers = () => {
  upstreamCallers.length = 0
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
  return { id, role }
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
const byNumber = (value: unknown, actual: number) => !Number(value) || Number(value) === actual

const handlers: Record<string, (req: Req) => unknown> = {
  // UserService
  ListUsers: (r) => ({
    users: users.filter((u) => !r.role || r.role === 'ROLE_UNSPECIFIED' || r.role === u.role).map(userRes),
  }),
  GetUser: (r) => userRes(find(users, r.id, 'User')),
  CreateUser: (r) => ({ ...userRes(users[3]!), id: '99', email: r.email, role: r.role }),
  UpdateUser: (r) => userRes(find(users, r.id, 'User')),
  DeleteUser: () => ({}),
  SetUserPassword: () => ({}),
  VerifyCredentials: (r) => {
    const user = users.find((u) => emailOf(u.id) === String(r.email).trim().toLowerCase())
    if (!user || withoutPassword.has(user.id) || r.password !== FAKE_PASSWORD) {
      upstreamError(status.UNAUTHENTICATED, 'Invalid email or password')
    }
    return userRes(user)
  },
  // Any id: the user `CreateClientForTrainer` just created (id 99) isn't in the fixtures.
  CreatePasswordSetupToken: (r) => ({
    token: setupTokenFor(Number(r.userId)),
    expiresAt: '2099-01-01T00:00:00Z',
  }),
  SetPasswordWithToken: (r) => {
    const userId = Number(/^issued-(\d+)$/.exec(String(r.token))?.[1])
    if (!users.some((u) => u.id === userId)) {
      upstreamError(status.UNAUTHENTICATED, 'Invalid or expired password setup token')
    }
    return {}
  },
  ListUsersWithoutPassword: (r) => ({
    users: users
      .filter((u) => withoutPassword.has(u.id) && (!r.role || r.role === 'ROLE_UNSPECIFIED' || r.role === u.role))
      .map(userRes),
  }),

  // ExerciseService
  ListMuscleGroups: () => ({ muscleGroups: [{ id: '1', name: 'Peito' }] }),
  ListExercises: () => ({ exercises: [exerciseRes()] }),
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
  CompleteWorkoutLog: (r) => ({ ...workoutLogRes(find(workoutLogs, r.id, 'WorkoutLog')), completedAt: `${today}T09:00:00Z` }),
  ListWorkoutLogs: (r) => ({
    workoutLogs: workoutLogs
      .filter((l) => l.clientId === Number(r.clientId))
      .filter((l) => find(workouts, l.workoutId, 'Workout').trainingPlanId === Number(r.trainingPlanId))
      .map(workoutLogRes),
  }),
  GetLastSetLogs: () => ({ setLogs: [] }),
  GetExerciseProgress: () => ({ points: [{ weekStartDate: today, weight: '20' }] }),

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
      createdAt: `${today}T09:00:00Z`,
    }
  },
  ListWorkoutFeedback: () => ({ workoutFeedback: [] }),

  // TrainerClientService
  CreateClientForTrainer: (r) => ({ ...userRes(users[3]!), id: '99', email: r.email }),
  ListClientsForTrainer: (r) => ({
    clients: trainerClients
      .filter(([t]) => t === Number(r.trainerId))
      .map(([, c]) => userRes(find(users, c, 'User'))),
  }),
  IsTrainersClient: (r) => ({
    isClient: trainerClients.some(([t, c]) => t === Number(r.trainerId) && c === Number(r.clientId)),
  }),
}

/** RPCs that change upstream state. A refused request must never reach one. */
export const isWriteRpc = (method: string) =>
  /^(Create|Update|Delete|Set|Clone|Replace|Record|Complete|Submit|GetOrStart)/.test(method)

/**
 * Drop-in implementation for the mocked `grpcCall`; unknown methods, and calls without a valid
 * caller token, fail loudly.
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
  upstreamCallers.push({ method, caller: callerOfCall })
  currentCaller = callerOfCall
  try {
    return handler((request ?? {}) as Req) as never
  } finally {
    currentCaller = undefined
  }
}
