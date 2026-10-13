import { NotFoundError } from '../lib/errors.js'
import { signToken, type Role } from '../lib/jwt.js'

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
 */

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
  workoutA: 200,
  workoutB: 201,
  workoutExerciseA: 300,
  workoutExerciseB: 301,
  exerciseSetA: 400,
  exerciseSetB: 401,
  workoutLogA: 500,
  workoutLogB: 501,
  exercise: 1,
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

const trainerClients: [trainerId: number, clientId: number][] = [
  [ids.trainerA, ids.clientA],
  [ids.trainerA, ids.clientA2],
  [ids.trainerB, ids.clientB],
]

const plans = [
  { id: ids.planA, trainerId: ids.trainerA, clientId: ids.clientA },
  { id: ids.planB, trainerId: ids.trainerB, clientId: ids.clientB },
  { id: ids.planA2, trainerId: ids.trainerA, clientId: ids.clientA2 },
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
  return { authorization: `Bearer ${signToken({ id: u.id, name: u.name, email: emailOf(u.id), role: u.role })}` }
}

const emailOf = (id: number) => `user${id}@vertice.test`
const str = (n: number) => String(n)
const today = new Date().toISOString().slice(0, 10)

function find<T extends { id: number }>(rows: T[], id: unknown, what: string): T {
  const row = rows.find((r) => r.id === Number(id))
  if (!row) throw new NotFoundError(what)
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
const exerciseRes = {
  id: str(ids.exercise),
  name: 'Supino',
  description: '',
  videoUrl: '',
  muscleGroups: [{ id: '1', name: 'Peito' }],
  isStarter: true,
}

type Req = Record<string, unknown>
const byNumber = (value: unknown, actual: number) => !Number(value) || Number(value) === actual

const handlers: Record<string, (req: Req) => unknown> = {
  // UserService
  ListUsers: () => ({ users: users.map(userRes) }),
  GetUser: (r) => userRes(find(users, r.id, 'User')),
  CreateUser: (r) => ({ ...userRes(users[3]!), id: '99', email: r.email, role: r.role }),
  UpdateUser: (r) => userRes(find(users, r.id, 'User')),
  DeleteUser: () => ({}),
  SetUserPassword: () => ({}),

  // ExerciseService
  ListMuscleGroups: () => ({ muscleGroups: [{ id: '1', name: 'Peito' }] }),
  ListExercises: () => ({ exercises: [exerciseRes] }),
  GetExercise: () => exerciseRes,
  CreateExercise: () => exerciseRes,
  UpdateExercise: () => exerciseRes,
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

/** Drop-in implementation for the mocked `grpcCall`; unknown methods fail loudly. */
export async function fakeGrpcCall(_client: unknown, method: string, request: unknown): Promise<never> {
  const handler = handlers[method]
  if (!handler) throw new Error(`fakeUpstream: no handler for ${method}`)
  return handler((request ?? {}) as Req) as never
}
