import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance, RouteOptions } from 'fastify'
import { buildApp } from '../app.js'
import { grpcCall, MissingCallerIdentityError, SERVICE_TOKEN_RPCS } from '../grpc/call.js'
import { Metadata } from '@grpc/grpc-js'
import { serviceToken, type Role } from '../lib/jwt.js'
import {
  API_SERVICE_SUBJECT_RPCS,
  bearer,
  emailOf,
  FAKE_PASSWORD,
  fakeGrpcCall,
  ids,
  isWriteRpc,
  resetUpstreamCallers,
  setupTokenFor,
  upstreamCallers,
  userOf,
  type Actor,
} from './fakeUpstream.js'

// Keep the real mapGrpcError: the fake upstream raises its errors through it.
vi.mock('../grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../grpc/call.js')>()),
  grpcCall: vi.fn(),
}))
const grpcCallMock = vi.mocked(grpcCall)

/**
 * Route-authorization table: one entry per registered route (a test fails when a
 * route has none). For each entry the suite asserts:
 * - 401 without a token (and no upstream call), unless `public`;
 * - 403 for every role outside `roles` (and no upstream call), when `roles` is set;
 * - `ok`: the owning caller gets a 2xx, so the denials below are not a broken fake, and
 *   every upstream call carries that caller's token (the BFF's service token on a public
 *   route; the fake upstream refuses calls with neither);
 * - `denied`: another tenant's id in path, query or body is refused (403 unless
 *   `status` says otherwise) and no write RPC reaches upstream. Body ids that only
 *   have to fit the request (a set of the log's workout, an exercise visible to the
 *   trainer) are 400 whether foreign or missing, so they are no existence oracle;
 * - `scoped`: an id the route ignores by design (e.g. a CLIENT's `clientId`) is
 *   replaced with the caller's own before it goes upstream.
 *
 * Tenants come from `fakeUpstream.ts`: trainer A owns client A (and client A2),
 * trainer B owns client B. "B" ids below always belong to the other tenant.
 */

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

interface Call {
  as: Actor
  url: string
  body?: unknown
}

interface Denied extends Call {
  why: string
  status?: 400 | 403
}

interface Scoped extends Call {
  why: string
  rpc: string
  sends: Record<string, unknown>
}

interface RouteCase {
  route: `${Method} ${string}`
  public?: true
  /** Roles the route admits; omitted means any authenticated user. */
  roles?: Role[]
  ok: Call | Omit<Call, 'as'>
  denied?: Denied[]
  scoped?: Scoped[]
}

const workoutBody = { name: 'Treino', dayOfWeek: 'MONDAY' }
const withExercises = (...exerciseIds: number[]) => ({ exercises: exerciseIds.map((exerciseId) => ({ exerciseId })) })
const setBody = { setNumber: 1, strategy: 'STRAIGHT' }
const planBody = { name: 'Plano', startDate: '2026-11-01', endDate: '2027-01-31', level: 'BEGINNER' }
const setLogBody = { exerciseSetId: ids.exerciseSetA, weight: '20', reps: 10 }

const routes: RouteCase[] = [
  { route: 'GET /health', public: true, ok: { url: '/health' } },

  // auth
  {
    route: 'POST /api/auth/login',
    public: true,
    ok: { url: '/api/auth/login', body: { email: emailOf(ids.clientA), password: FAKE_PASSWORD } },
  },
  {
    route: 'POST /api/auth/register',
    public: true,
    ok: {
      url: '/api/auth/register',
      body: { name: 'Novo', email: 'novo@vertice.test', password: 'secret-123', role: 'TRAINER' },
    },
  },
  { route: 'GET /api/auth/me', ok: { as: 'clientA', url: '/api/auth/me' } },
  {
    // Self only: the user id comes from the token, never from the request.
    route: 'POST /api/auth/password',
    ok: { as: 'clientA', url: '/api/auth/password', body: { currentPassword: FAKE_PASSWORD, newPassword: 'nova-senha-1' } },
    scoped: [
      {
        as: 'clientA',
        url: '/api/auth/password',
        body: { currentPassword: FAKE_PASSWORD, newPassword: 'nova-senha-1', id: ids.clientB, userId: ids.clientB },
        why: 'body: a userId is ignored',
        rpc: 'SetUserPassword',
        sends: { id: ids.clientA },
      },
    ],
  },
  {
    route: 'POST /api/auth/password/setup',
    public: true,
    ok: { url: '/api/auth/password/setup', body: { token: setupTokenFor(ids.clientA2), newPassword: 'nova-senha-1' } },
  },

  // clients
  { route: 'GET /api/clients', roles: ['TRAINER', 'ADMIN'], ok: { as: 'trainerA', url: '/api/clients' } },
  {
    route: 'GET /api/clients/:id',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/clients/${ids.clientA}` },
    denied: [{ as: 'trainerA', url: `/api/clients/${ids.clientB}`, why: "path: another trainer's client" }],
  },
  {
    route: 'GET /api/clients/:id/overview',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/clients/${ids.clientA}/overview` },
    denied: [
      { as: 'trainerA', url: `/api/clients/${ids.clientB}/overview`, why: "path: another trainer's client" },
    ],
  },
  {
    route: 'POST /api/clients',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: '/api/clients', body: { name: 'Novo', email: 'novo@vertice.test' } },
  },
  {
    route: 'POST /api/clients/:id/setup-token',
    roles: ['TRAINER'],
    ok: { as: 'trainerA', url: `/api/clients/${ids.clientA2}/setup-token` },
    denied: [
      { as: 'trainerA', url: `/api/clients/${ids.clientB}/setup-token`, why: "path: another trainer's client" },
    ],
  },
  {
    route: 'PATCH /api/clients/:id',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/clients/${ids.clientA}`, body: { name: 'A', email: 'a@vertice.test' } },
    denied: [
      {
        as: 'trainerA',
        url: `/api/clients/${ids.clientB}`,
        body: { name: 'B', email: 'b@vertice.test' },
        why: "path: another trainer's client",
      },
    ],
  },
  {
    route: 'DELETE /api/clients/:id',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/clients/${ids.clientA}` },
    denied: [{ as: 'trainerA', url: `/api/clients/${ids.clientB}`, why: "path: another trainer's client" }],
  },

  // exercises (global catalog; per-exercise visibility is enforced upstream, spec D10)
  { route: 'GET /api/exercises', roles: ['TRAINER', 'ADMIN'], ok: { as: 'trainerA', url: '/api/exercises' } },
  { route: 'GET /api/exercises/:id', ok: { as: 'clientA', url: `/api/exercises/${ids.exercise}` } },
  {
    route: 'GET /api/exercises/:id/progress',
    ok: { as: 'trainerA', url: `/api/exercises/${ids.exercise}/progress?clientId=${ids.clientA}` },
    denied: [
      {
        as: 'trainerA',
        url: `/api/exercises/${ids.exercise}/progress?clientId=${ids.clientB}`,
        why: "query: another trainer's client",
      },
      {
        as: 'trainerA',
        url: `/api/exercises/${ids.exercise}/progress`,
        why: 'query: clientId missing',
        status: 400,
      },
      {
        as: 'trainerA',
        url: `/api/exercises/${ids.exercise}/progress?clientId=abc`,
        why: 'query: clientId not a number',
        status: 400,
      },
      { as: 'admin', url: `/api/exercises/${ids.exercise}/progress`, why: 'query: clientId missing', status: 400 },
    ],
    scoped: [
      {
        as: 'clientA',
        url: `/api/exercises/${ids.exercise}/progress?clientId=${ids.clientB}`,
        why: 'query: a CLIENT always reads their own history',
        rpc: 'GetExerciseProgress',
        sends: { clientId: ids.clientA },
      },
    ],
  },
  {
    route: 'POST /api/exercises',
    roles: ['TRAINER'],
    ok: { as: 'trainerA', url: '/api/exercises', body: { name: 'Remada', muscleGroupIds: [1] } },
  },
  {
    route: 'PATCH /api/exercises/:id',
    roles: ['TRAINER'],
    ok: { as: 'trainerA', url: `/api/exercises/${ids.exercise}`, body: { name: 'Remada', muscleGroupIds: [1] } },
  },
  { route: 'DELETE /api/exercises/:id', roles: ['TRAINER'], ok: { as: 'trainerA', url: `/api/exercises/${ids.exercise}` } },
  { route: 'GET /api/muscle-groups', ok: { as: 'clientA', url: '/api/muscle-groups' } },

  // training plans
  {
    route: 'GET /api/training-plans',
    ok: { as: 'clientA', url: '/api/training-plans' },
    scoped: [
      {
        as: 'trainerA',
        url: `/api/training-plans?clientId=${ids.clientB}`,
        why: "query: a trainer's filter stays inside their own plans",
        rpc: 'ListTrainingPlans',
        sends: { trainerId: ids.trainerA, clientId: ids.clientB },
      },
    ],
  },
  {
    route: 'GET /api/training-plans/:id',
    ok: { as: 'clientA', url: `/api/training-plans/${ids.planA}` },
    denied: [
      { as: 'clientA', url: `/api/training-plans/${ids.planB}`, why: "path: another client's plan" },
      { as: 'trainerA', url: `/api/training-plans/${ids.planB}`, why: "path: another trainer's plan" },
    ],
  },
  {
    route: 'POST /api/training-plans',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: '/api/training-plans', body: { ...planBody, clientId: ids.clientA } },
    denied: [
      {
        as: 'trainerA',
        url: '/api/training-plans',
        body: { ...planBody, clientId: ids.clientB },
        why: "body: another trainer's client",
      },
    ],
  },
  {
    route: 'PATCH /api/training-plans/:id',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/training-plans/${ids.planA}`, body: planBody },
    denied: [
      { as: 'trainerA', url: `/api/training-plans/${ids.planB}`, body: planBody, why: "path: another trainer's plan" },
    ],
    scoped: [
      {
        as: 'trainerA',
        url: `/api/training-plans/${ids.planA}`,
        body: { ...planBody, clientId: ids.clientB },
        why: 'body: clientId is immutable, the stored one is sent',
        rpc: 'UpdateTrainingPlan',
        sends: { id: ids.planA, trainingPlan: { ...planBody, description: '', clientId: ids.clientA } },
      },
    ],
  },
  {
    route: 'DELETE /api/training-plans/:id',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/training-plans/${ids.planA}` },
    denied: [{ as: 'trainerA', url: `/api/training-plans/${ids.planB}`, why: "path: another trainer's plan" }],
  },
  {
    route: 'GET /api/training-plans/:planId/workouts',
    ok: { as: 'clientA', url: `/api/training-plans/${ids.planA}/workouts` },
    denied: [
      { as: 'clientA', url: `/api/training-plans/${ids.planB}/workouts`, why: "path: another client's plan" },
      { as: 'trainerA', url: `/api/training-plans/${ids.planB}/workouts`, why: "path: another trainer's plan" },
    ],
  },
  {
    route: 'POST /api/training-plans/:planId/workouts',
    roles: ['TRAINER', 'ADMIN'],
    ok: {
      as: 'trainerA',
      url: `/api/training-plans/${ids.planA}/workouts`,
      body: { ...workoutBody, ...withExercises(ids.exercise) },
    },
    denied: [
      {
        as: 'trainerA',
        url: `/api/training-plans/${ids.planB}/workouts`,
        body: workoutBody,
        why: "path: another trainer's plan",
      },
      {
        as: 'trainerA',
        url: `/api/training-plans/${ids.planA}/workouts`,
        body: { ...workoutBody, ...withExercises(ids.exercise, ids.privateExerciseB) },
        why: "body: another trainer's private exercise in the nested tree",
        status: 400,
      },
      {
        as: 'trainerA',
        url: `/api/training-plans/${ids.planA}/workouts`,
        body: { ...workoutBody, ...withExercises(9999) },
        why: 'body: an exercise that does not exist (same answer as a private one)',
        status: 400,
      },
    ],
  },

  // workouts
  {
    route: 'GET /api/workouts',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: '/api/workouts?recent=true' },
    scoped: [
      {
        as: 'trainerA',
        url: '/api/workouts?recent=true',
        why: "no id input: only the caller's own plans are listed",
        rpc: 'ListTrainingPlans',
        sends: { trainerId: ids.trainerA },
      },
    ],
  },
  {
    route: 'GET /api/workouts/:id',
    ok: { as: 'clientA', url: `/api/workouts/${ids.workoutA}` },
    denied: [
      { as: 'clientA', url: `/api/workouts/${ids.workoutB}`, why: "path: another client's workout" },
      { as: 'trainerA', url: `/api/workouts/${ids.workoutB}`, why: "path: another trainer's workout" },
    ],
  },
  {
    route: 'GET /api/workouts/:id/full',
    ok: { as: 'clientA', url: `/api/workouts/${ids.workoutA}/full` },
    denied: [
      { as: 'clientA', url: `/api/workouts/${ids.workoutB}/full`, why: "path: another client's workout" },
      { as: 'trainerA', url: `/api/workouts/${ids.workoutB}/full`, why: "path: another trainer's workout" },
    ],
  },
  {
    route: 'PATCH /api/workouts/:id',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/workouts/${ids.workoutA}`, body: workoutBody },
    denied: [
      { as: 'trainerA', url: `/api/workouts/${ids.workoutB}`, body: workoutBody, why: "path: another trainer's workout" },
    ],
  },
  {
    route: 'DELETE /api/workouts/:id',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/workouts/${ids.workoutA}` },
    denied: [{ as: 'trainerA', url: `/api/workouts/${ids.workoutB}`, why: "path: another trainer's workout" }],
  },
  {
    route: 'POST /api/workouts/:id/clone',
    roles: ['TRAINER', 'ADMIN'],
    ok: {
      as: 'trainerA',
      url: `/api/workouts/${ids.workoutA}/clone`,
      body: { ...workoutBody, targetTrainingPlanId: ids.planA },
    },
    denied: [
      {
        as: 'trainerA',
        url: `/api/workouts/${ids.workoutB}/clone`,
        body: { ...workoutBody, targetTrainingPlanId: ids.planA },
        why: "path: another trainer's workout",
      },
      {
        as: 'trainerA',
        url: `/api/workouts/${ids.workoutA}/clone`,
        body: { ...workoutBody, targetTrainingPlanId: ids.planB },
        why: "body: another trainer's target plan",
      },
    ],
  },

  // workout exercises. Body exerciseIds are resolved through GetExercise with the caller's
  // token (assertCanUseExercises): vertice-api's workout-exercise writes don't check visibility.
  {
    route: 'GET /api/workouts/:workoutId/exercises',
    ok: { as: 'clientA', url: `/api/workouts/${ids.workoutA}/exercises` },
    denied: [
      { as: 'clientA', url: `/api/workouts/${ids.workoutB}/exercises`, why: "path: another client's workout" },
      { as: 'trainerA', url: `/api/workouts/${ids.workoutB}/exercises`, why: "path: another trainer's workout" },
    ],
  },
  {
    route: 'POST /api/workouts/:workoutId/exercises',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/workouts/${ids.workoutA}/exercises`, body: { exerciseId: ids.exercise, order: 0 } },
    denied: [
      {
        as: 'trainerA',
        url: `/api/workouts/${ids.workoutB}/exercises`,
        body: { exerciseId: ids.exercise, order: 0 },
        why: "path: another trainer's workout",
      },
      {
        as: 'trainerA',
        url: `/api/workouts/${ids.workoutA}/exercises`,
        body: { exerciseId: ids.privateExerciseB, order: 0 },
        why: "body: another trainer's private exercise",
        status: 400,
      },
      {
        as: 'trainerA',
        url: `/api/workouts/${ids.workoutA}/exercises`,
        body: { exerciseId: 9999, order: 0 },
        why: 'body: an exercise that does not exist (same answer as a private one)',
        status: 400,
      },
    ],
  },
  {
    route: 'PUT /api/workouts/:workoutId/exercises',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/workouts/${ids.workoutA}/exercises`, body: withExercises(ids.exercise) },
    denied: [
      {
        as: 'trainerA',
        url: `/api/workouts/${ids.workoutB}/exercises`,
        body: { exercises: [] },
        why: "path: another trainer's workout",
      },
      {
        as: 'trainerA',
        url: `/api/workouts/${ids.workoutA}/exercises`,
        body: withExercises(ids.exercise, ids.privateExerciseB),
        why: "body: another trainer's private exercise",
        status: 400,
      },
      {
        as: 'trainerA',
        url: `/api/workouts/${ids.workoutA}/exercises`,
        body: withExercises(9999),
        why: 'body: an exercise that does not exist (same answer as a private one)',
        status: 400,
      },
    ],
  },
  // The PATCH body has no exerciseId (the schema drops one), so there is no body id to check.
  {
    route: 'PATCH /api/workout-exercises/:id',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/workout-exercises/${ids.workoutExerciseA}`, body: { order: 0 } },
    denied: [
      {
        as: 'trainerA',
        url: `/api/workout-exercises/${ids.workoutExerciseB}`,
        body: { order: 0 },
        why: "path: another trainer's workout exercise",
      },
    ],
  },
  {
    route: 'DELETE /api/workout-exercises/:id',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/workout-exercises/${ids.workoutExerciseA}` },
    denied: [
      {
        as: 'trainerA',
        url: `/api/workout-exercises/${ids.workoutExerciseB}`,
        why: "path: another trainer's workout exercise",
      },
    ],
  },

  // exercise sets
  {
    route: 'GET /api/workout-exercises/:workoutExerciseId/sets',
    ok: { as: 'clientA', url: `/api/workout-exercises/${ids.workoutExerciseA}/sets` },
    denied: [
      {
        as: 'clientA',
        url: `/api/workout-exercises/${ids.workoutExerciseB}/sets`,
        why: "path: another client's workout exercise",
      },
    ],
  },
  {
    route: 'POST /api/workout-exercises/:workoutExerciseId/sets',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/workout-exercises/${ids.workoutExerciseA}/sets`, body: setBody },
    denied: [
      {
        as: 'trainerA',
        url: `/api/workout-exercises/${ids.workoutExerciseB}/sets`,
        body: setBody,
        why: "path: another trainer's workout exercise",
      },
    ],
  },
  {
    route: 'PATCH /api/exercise-sets/:id',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/exercise-sets/${ids.exerciseSetA}`, body: setBody },
    denied: [
      { as: 'trainerA', url: `/api/exercise-sets/${ids.exerciseSetB}`, body: setBody, why: "path: another trainer's set" },
    ],
  },
  {
    route: 'DELETE /api/exercise-sets/:id',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: `/api/exercise-sets/${ids.exerciseSetA}` },
    denied: [{ as: 'trainerA', url: `/api/exercise-sets/${ids.exerciseSetB}`, why: "path: another trainer's set" }],
  },

  // sessions, logs and feedback
  {
    route: 'GET /api/workouts/:workoutId/session',
    ok: { as: 'clientA', url: `/api/workouts/${ids.workoutA}/session` },
    denied: [
      { as: 'clientA', url: `/api/workouts/${ids.workoutB}/session`, why: "path: another client's workout" },
      {
        as: 'trainerA',
        url: `/api/workouts/${ids.workoutB}/session?clientId=${ids.clientB}`,
        why: "path: another trainer's workout",
      },
      {
        as: 'trainerA',
        url: `/api/workouts/${ids.workoutA}/session?clientId=${ids.clientB}`,
        why: 'query: a client the workout is not assigned to',
      },
      { as: 'trainerA', url: `/api/workouts/${ids.workoutA}/session`, why: 'query: clientId missing', status: 400 },
    ],
    scoped: [
      {
        as: 'clientA',
        url: `/api/workouts/${ids.workoutA}/session?clientId=${ids.clientB}`,
        why: 'query: a CLIENT always gets their own session',
        rpc: 'GetOrStartWorkoutLog',
        sends: { workoutId: ids.workoutA, clientId: ids.clientA },
      },
    ],
  },
  {
    route: 'GET /api/workout-logs',
    ok: { as: 'trainerA', url: `/api/workout-logs?clientId=${ids.clientA}&trainingPlanId=${ids.planA}` },
    denied: [
      {
        as: 'trainerA',
        url: `/api/workout-logs?clientId=${ids.clientB}&trainingPlanId=${ids.planB}`,
        why: "query: another trainer's client",
      },
      {
        as: 'trainerA',
        url: `/api/workout-logs?clientId=${ids.clientA}&trainingPlanId=${ids.planB}`,
        why: "query: another trainer's plan",
      },
      {
        as: 'trainerA',
        url: `/api/workout-logs?clientId=${ids.clientB}&trainingPlanId=${ids.planAForFormerClientB}`,
        why: "query: the trainer's own plan, but for a client no longer on their roster",
      },
      {
        as: 'trainerA',
        url: `/api/workout-logs?clientId=${ids.clientA}&trainingPlanId=${ids.planBForClientA}`,
        why: "query: the client's own plan, but written by another (previous) trainer",
      },
      {
        as: 'trainerA',
        url: `/api/workout-logs?clientId=${ids.clientA}&trainingPlanId=${ids.planA2}`,
        why: "query: the trainer's own plan, but for a different client",
      },
      {
        as: 'clientA',
        url: `/api/workout-logs?trainingPlanId=${ids.planB}`,
        why: "query: another client's plan",
      },
      {
        as: 'trainerA',
        url: `/api/workout-logs?trainingPlanId=${ids.planA}`,
        why: 'query: clientId missing',
        status: 400,
      },
      { as: 'clientA', url: '/api/workout-logs', why: 'query: trainingPlanId missing', status: 400 },
    ],
    scoped: [
      {
        as: 'clientA',
        url: `/api/workout-logs?clientId=${ids.clientB}&trainingPlanId=${ids.planA}`,
        why: 'query: a CLIENT always reads their own logs',
        rpc: 'ListWorkoutLogs',
        sends: { clientId: ids.clientA, trainingPlanId: ids.planA },
      },
    ],
  },
  {
    route: 'POST /api/workout-logs/:workoutLogId/feedback',
    roles: ['CLIENT'],
    ok: { as: 'clientA', url: `/api/workout-logs/${ids.workoutLogA}/feedback`, body: { text: 'Pesado' } },
    denied: [
      {
        as: 'clientA',
        url: `/api/workout-logs/${ids.workoutLogB}/feedback`,
        body: { text: 'Pesado' },
        why: "path: another client's workout log",
      },
    ],
  },
  {
    route: 'POST /api/workout-sessions/:workoutLogId/sets',
    roles: ['CLIENT'],
    ok: { as: 'clientA', url: `/api/workout-sessions/${ids.workoutLogA}/sets`, body: setLogBody },
    denied: [
      {
        as: 'clientA',
        url: `/api/workout-sessions/${ids.workoutLogB}/sets`,
        body: { ...setLogBody, exerciseSetId: ids.exerciseSetB },
        why: "path: another client's workout log",
      },
      {
        as: 'clientA',
        url: `/api/workout-sessions/${ids.workoutLogA}/sets`,
        body: { ...setLogBody, exerciseSetId: ids.exerciseSetB },
        why: "body: a set from another workout (another client's)",
        status: 400,
      },
      {
        as: 'clientA',
        url: `/api/workout-sessions/${ids.workoutLogA}/sets`,
        body: { ...setLogBody, exerciseSetId: 9999 },
        why: 'body: a set that does not exist (same answer as a foreign one)',
        status: 400,
      },
    ],
  },
  {
    route: 'POST /api/workout-sessions/:workoutLogId/complete',
    roles: ['CLIENT'],
    ok: { as: 'clientA', url: `/api/workout-sessions/${ids.workoutLogA}/complete` },
    denied: [
      {
        as: 'clientA',
        url: `/api/workout-sessions/${ids.workoutLogB}/complete`,
        why: "path: another client's workout log",
      },
    ],
  },
  {
    route: 'GET /api/feedback',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: '/api/feedback' },
    scoped: [
      {
        as: 'trainerA',
        url: '/api/feedback',
        why: "no id input: the caller's own feedback only",
        rpc: 'ListWorkoutFeedback',
        sends: { trainerId: ids.trainerA },
      },
    ],
  },
  {
    route: 'GET /api/dashboard',
    roles: ['TRAINER', 'ADMIN'],
    ok: { as: 'trainerA', url: '/api/dashboard' },
  },
]

const actorForRole: Record<Role, Actor> = { ADMIN: 'admin', TRAINER: 'trainerA', CLIENT: 'clientA' }
const ALL_ROLES: Role[] = ['ADMIN', 'TRAINER', 'CLIENT']

// Fastify registers a prefixed `/` both with and without the trailing slash; count it once.
const routeKey = (method: string, url: string) => `${method} ${url.length > 1 ? url.replace(/\/$/, '') : url}`

describe('route authorization', () => {
  let app: FastifyInstance
  const registered = new Set<string>()

  beforeAll(async () => {
    app = await buildApp({
      // Hundreds of requests from one IP: keep the rate limits out of the authorization checks.
      rateLimits: { globalMax: 1_000_000, authMax: 1_000_000 },
      onRoute: (route: RouteOptions) => {
        for (const method of [route.method].flat()) {
          if (method !== 'HEAD' && method !== 'OPTIONS') registered.add(routeKey(method, route.url))
        }
      },
    })
    await app.ready()
  })

  afterAll(() => app.close())

  beforeEach(() => {
    grpcCallMock.mockReset()
    grpcCallMock.mockImplementation(fakeGrpcCall)
    resetUpstreamCallers()
  })

  const send = (method: string, call: Partial<Call> & { url: string }) =>
    app.inject({
      method: method as Method,
      url: call.url,
      headers: call.as ? bearer(call.as) : {},
      ...(call.body === undefined ? {} : { payload: call.body as object }),
    })

  const upstreamMethods = () => grpcCallMock.mock.calls.map(([, method]) => method)

  it('every registered route has an entry in the table, and every entry is a registered route', () => {
    const tabled = routes.map((r) => r.route)
    expect([...registered].filter((r) => !tabled.includes(r as RouteCase['route']))).toEqual([])
    expect(tabled.filter((r) => !registered.has(r))).toEqual([])
    expect(new Set(tabled).size).toBe(tabled.length)
  })

  it('the fake upstream refuses a call without a valid token, and a service subject outside its RPCs', async () => {
    const withAuthorization = (value: string) => {
      const metadata = new Metadata()
      metadata.set('authorization', value)
      return { metadata }
    }
    const user = { id: ids.clientA }
    await expect(fakeGrpcCall(null, 'GetUser', user, withAuthorization('Bearer forged'))).rejects.toThrow()
    await expect(fakeGrpcCall(null, 'GetUser', user)).rejects.toThrow(MissingCallerIdentityError)
    await expect(fakeGrpcCall(null, 'GetUser', user, { anonymous: true })).rejects.toThrow(/without a bearer token/)
    await expect(
      fakeGrpcCall(null, 'ListUsers', {}, withAuthorization(`Bearer ${serviceToken()}`)),
    ).rejects.toThrow(/service:bff is not allowed to call ListUsers/)
    await expect(
      fakeGrpcCall(null, 'VerifyCredentials', { email: emailOf(ids.clientA), password: FAKE_PASSWORD }, { asService: true }),
    ).resolves.toBeDefined()
  })

  it("pins the BFF's service-token RPCs to the API contract: exactly the three public auth RPCs", () => {
    expect([...SERVICE_TOKEN_RPCS].sort()).toEqual(['CreateUser', 'SetPasswordWithToken', 'VerifyCredentials'])
    expect([...SERVICE_TOKEN_RPCS].sort()).toEqual([...API_SERVICE_SUBJECT_RPCS['service:bff']!].sort())
  })

  describe.each(routes)('$route', (rc) => {
    const method = rc.route.split(' ')[0]!

    if (rc.public) {
      it('is reachable without a token, and calls upstream with the service token', async () => {
        const res = await send(method, { ...rc.ok, as: undefined })
        expect(res.statusCode, res.body).toBeLessThan(300)
        expect(upstreamCallers.map((c) => c.caller).filter((c) => c !== 'service:bff')).toEqual([])
      })
    } else {
      it('is 401 without a token and never calls upstream', async () => {
        const res = await send(method, { ...rc.ok, as: undefined })
        expect(res.statusCode).toBe(401)
        expect(res.json().error.code).toBe('UNAUTHORIZED')
        expect(grpcCallMock).not.toHaveBeenCalled()
      })

      it("lets the owning caller through, and calls upstream with the caller's token", async () => {
        const res = await send(method, rc.ok)
        expect(res.statusCode, res.body).toBeGreaterThanOrEqual(200)
        expect(res.statusCode, res.body).toBeLessThan(300)
        const { id, role } = userOf((rc.ok as Call).as)
        expect(upstreamCallers.length).toBe(grpcCallMock.mock.calls.length)
        for (const { method: rpc, caller } of upstreamCallers) {
          expect(caller, rpc).toEqual({ id, role })
        }
      })
    }

    const wrongRoles = rc.roles ? ALL_ROLES.filter((r) => !rc.roles!.includes(r)) : []
    it.each(wrongRoles)('is 403 for role %s and never calls upstream', async (role) => {
      const res = await send(method, { ...rc.ok, as: actorForRole[role] })
      expect(res.statusCode).toBe(403)
      expect(res.json().error).toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/^Requires role/) })
      expect(grpcCallMock).not.toHaveBeenCalled()
    })

    it.each(rc.denied ?? [])('refuses $as, $why', async (d) => {
      const status = d.status ?? 403
      const res = await send(method, d)
      expect(res.statusCode, res.body).toBe(status)
      expect(res.json().error.code).toBe(status === 403 ? 'FORBIDDEN' : 'VALIDATION_ERROR')
      expect(upstreamMethods().filter(isWriteRpc)).toEqual([])
    })

    it.each(rc.scoped ?? [])('scopes $as to their own data, $why', async (s) => {
      const res = await send(method, s)
      expect(res.statusCode, res.body).toBeLessThan(300)
      const call = grpcCallMock.mock.calls.find(([, m]) => m === s.rpc)
      expect(call, `${s.rpc} was not called`).toBeDefined()
      expect(call![2]).toMatchObject(s.sends)
    })
  })
})
