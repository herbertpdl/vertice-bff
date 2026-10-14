import { Metadata, status } from '@grpc/grpc-js'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { mapGrpcError, withCallerIdentity } from '../grpc/call.js'
import {
  SERVICE_ROLE,
  SERVICE_SUBJECT,
  signToken,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  verifyToken,
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
 * valid user token, or the BFF's service token on an RPC in `SERVICE_TOKEN_RPCS`. Anything else
 * fails loudly, and each call's caller is recorded in `upstreamCallers`.
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
const exercises = [
  { id: ids.exercise, ownerId: null as number | null },
  { id: ids.privateExerciseB, ownerId: ids.trainerB as number | null },
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
 * RPCs vertice-api has to accept from the BFF's service token, i.e. the ones the BFF makes with no
 * user behind them: login (`VerifyCredentials`; `ListUsers` under `VERIFY_PASSWORDS=false`),
 * register (`CreateUser`), password setup (`SetPasswordWithToken`) and the setup-token ops script
 * (`ListUsers`, `CreatePasswordSetupToken`).
 */
export const SERVICE_TOKEN_RPCS: ReadonlySet<string> = new Set([
  'VerifyCredentials',
  'CreateUser',
  'SetPasswordWithToken',
  'ListUsers',
  'CreatePasswordSetupToken',
])

export type UpstreamCaller = AuthUser | 'service'

/** The caller of every call the fake served, in order. Cleared with `resetUpstreamCallers()`. */
export const upstreamCallers: { method: string; caller: UpstreamCaller }[] = []
export const resetUpstreamCallers = () => {
  upstreamCallers.length = 0
}

/** The verified caller of the current call, read from the token `grpcCall` forwards upstream. */
let currentCaller: UpstreamCaller | undefined

function caller(): AuthUser | undefined {
  return currentCaller === 'service' ? undefined : currentCaller
}

/** What vertice-api will check: a scoped token, and the service token only where it is allowed. */
function authenticateCall(method: string, metadata: Metadata): UpstreamCaller {
  const [header] = withCallerIdentity(metadata).get('authorization')
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (!token) throw new Error(`fakeUpstream: ${method} was called without a bearer token`)
  const claims = jwt.verify(token, env.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
  }) as jwt.JwtPayload
  if (claims.sub !== SERVICE_SUBJECT) return verifyToken(token)
  if (claims.role !== SERVICE_ROLE || typeof claims.exp !== 'number') {
    throw new Error(`fakeUpstream: ${method} got a malformed service token`)
  }
  if (!SERVICE_TOKEN_RPCS.has(method)) {
    throw new Error(`fakeUpstream: ${method} was called with the service token instead of a user's`)
  }
  return 'service'
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
  UpdateExercise: () => exerciseRes(),
  DeleteExercise: () => ({}),

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
  metadata: Metadata = new Metadata(),
): Promise<never> {
  const handler = handlers[method]
  if (!handler) throw new Error(`fakeUpstream: no handler for ${method}`)
  const callerOfCall = authenticateCall(method, metadata)
  upstreamCallers.push({ method, caller: callerOfCall })
  currentCaller = callerOfCall
  try {
    return handler((request ?? {}) as Req) as never
  } finally {
    currentCaller = undefined
  }
}
