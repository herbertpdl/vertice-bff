import { z } from 'zod'
import { FEEDBACK_RATINGS } from '../modules/feedback/schemas.js'
import { dayOfWeekSchema } from '../modules/workouts/schemas.js'
import { setStrategySchema } from '../modules/exercise-sets/schemas.js'
import { planLevelSchema } from '../modules/training-plans/schemas.js'
import type * as adminAuthService from '../modules/admin-auth/service.js'
import type * as adminService from '../modules/admin/service.js'
import { ADMIN_ACTIONS } from '../modules/admin/schemas.js'
import type * as authService from '../modules/auth/service.js'
import type * as clientService from '../modules/clients/service.js'
import type * as dashboardService from '../modules/dashboard/service.js'
import type * as exerciseService from '../modules/exercises/service.js'
import type * as exerciseSetService from '../modules/exercise-sets/service.js'
import type * as feedbackService from '../modules/feedback/service.js'
import type { LegalVersions } from '../modules/legal/routes.js'
import type * as planService from '../modules/training-plans/service.js'
import type * as userService from '../modules/users/service.js'
import type * as workoutExerciseService from '../modules/workout-exercises/service.js'
import type * as sessionService from '../modules/workout-sessions/service.js'
import type * as workoutService from '../modules/workouts/service.js'

/**
 * The shapes the routes answer with, as Zod schemas: the response half of the OpenAPI document
 * (`docs/openapi.json`). They describe; they do not validate or serialize (see `./index.ts`).
 * Drift from the services is caught at compile time: `ResponseSchemasMatchServices` at the bottom
 * fails to typecheck when a schema and the type a service returns stop being the same shape.
 *
 * `named(id, schema)` registers a schema as a reusable component (`#/components/schemas/<id>`),
 * which is what makes the generated TypeScript types for web and mobile readable.
 */
const named = <T extends z.ZodType>(id: string, schema: T): T => schema.meta({ id })

const id = z.number().int().positive()
/**
 * An instant: an absolute point in time, e.g. `2026-08-26T16:52:17.169082Z`. One of the two date
 * kinds in this contract (`docs/api-contract.md`, "Dates and times"); `date` below is the other.
 */
const instant = z
  .string()
  .describe(
    'ISO-8601 instant, UTC (`Z`). An absolute point in time. Format it for display in a time zone ' +
      '(the business zone is America/Sao_Paulo) — never read the clock or the calendar day off the ' +
      'string, and never assume a fixed -03:00 (instants from before 2019 are -02:00).',
  )
/** A business date: a calendar day in `America/Sao_Paulo`, `YYYY-MM-DD`. */
const date = z
  .string()
  .describe(
    'Business date, `YYYY-MM-DD`: a calendar day in America/Sao_Paulo, with no time and no zone. ' +
      'Never put it through a UTC conversion — `new Date("2026-10-31")` is UTC midnight, which ' +
      'renders as 30/10/2026 in Brazil.',
  )

export const roleSchema = named('Role', z.enum(['ADMIN', 'TRAINER', 'CLIENT']))

// ---- errors -------------------------------------------------------------------------------------

/** Every `code` the BFF emits (see `src/lib/errors.ts`, `src/grpc/call.ts`, `src/plugins/*`). */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'TOO_LARGE',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
  'INVALID_CURRENT_PASSWORD',
  'INVALID_SETUP_TOKEN',
  'ACTIVE_CLIENTS',
  'SESSION_NOT_RENEWABLE',
  'CHALLENGE_INVALID',
  'INVALID_SECOND_FACTOR_CODE',
] as const

export const errorCodeSchema = named('ErrorCode', z.enum(ERROR_CODES))

export const errorResponseSchema = named(
  'ErrorResponse',
  z.object({
    error: z.object({
      code: errorCodeSchema.describe('Machine-readable. Key on this, never on `message`.'),
      message: z.string().describe('English, for logs and debugging; not meant to be shown to users.'),
      details: z
        .unknown()
        .optional()
        .describe(
          'Only on the BFF’s own validation errors (`VALIDATION_ERROR`): Zod’s flattened field errors, ' +
            '`{ formErrors: string[], fieldErrors: { [field]: string[] } }`. Never set from upstream.',
        ),
    }),
  }),
)

// ---- auth and users -----------------------------------------------------------------------------

const sessionUserSchema = named(
  'SessionUser',
  z.object({ id, name: z.string(), email: z.string(), role: roleSchema }),
)

export const sessionSchema = named(
  'AuthSession',
  z.object({
    token: z.string(),
    expiresAt: z
      .string()
      .describe(
        'When `token` expires, an ISO-8601 instant: 8 hours out for a web session, 90 days for a mobile one ' +
          '(`X-Vertice-Client: mobile`). A mobile app renews before this with `POST /api/auth/session/renew`.',
      ),
    user: sessionUserSchema,
  }),
)

// ---- admin sign-in ------------------------------------------------------------------------------

export const adminChallengeSchema = named(
  'AdminChallenge',
  z.object({
    challenge: z
      .string()
      .describe(
        'Opaque. Send it in the body of `POST /api/admin/auth/enroll` and `/verify` only, never as a bearer ' +
          '(it is a 401 there). Reusable until it expires.',
      ),
    challengeExpiresAt: instant.describe('When `challenge` expires: 5 minutes after the password step.'),
    secondFactor: z
      .enum(['ENROLLED', 'NOT_ENROLLED'])
      .describe('`NOT_ENROLLED`: enroll, then verify. `ENROLLED`: go straight to the code step.'),
  }),
)

export const adminEnrollmentSchema = named(
  'AdminEnrollment',
  z.object({
    provisioningUri: z
      .string()
      .describe(
        'The `otpauth://totp/...` URI with the new secret. Render it as a QR code in-process (never through a ' +
          'third-party service), never log or store it. Each enroll call replaces it with a new secret.',
      ),
  }),
)

export const adminSessionSchema = named(
  'AdminSession',
  z.object({
    token: z.string().describe('The admin bearer token. Send it only from the admin host.'),
    expiresAt: instant.describe(
      'When `token` expires: 30 minutes after it was issued, never after `sessionEndsAt`. Renew before this ' +
        'with `POST /api/admin/auth/renew`.',
    ),
    sessionEndsAt: instant.describe('The sign-in’s hard cap, 12 hours after the code step. Renewal never moves it.'),
    user: sessionUserSchema,
  }),
)

// ---- admin panel reads (admin-panel spec §2.2) ---------------------------------------------------

const count = z.number().int().min(0)
const nextCursor = z
  .string()
  .nullable()
  .describe('Send back as `cursor` (same filters) for the next page; `null` on the last page.')

export const adminUserRefSchema = named(
  'AdminUserRef',
  z.object({
    id,
    name: z.string().describe('“Usuário removido” for a deleted account.'),
    role: roleSchema,
  }),
)

export const adminDashboardSchema = named(
  'AdminDashboard',
  z.object({
    totals: z
      .object({ trainers: count, clients: count })
      .describe('Non-deleted trainers and clients, suspended ones included; admins never.'),
    active: z
      .object({ trainers7d: count, clients7d: count, trainers30d: count, clients30d: count })
      .describe('Trainers and clients whose last activity falls in the window (business days, today included).'),
    completedWorkouts: z.object({ last7d: count, last30d: count }).describe('Workout logs completed in the window.'),
    weeklySignups: z
      .array(
        z.object({
          weekStart: date.describe('The week’s Monday, a business date.'),
          trainers: count,
          clients: count,
        }),
      )
      .describe('Exactly 12 weeks, oldest first; the last is the current (partial) week. Deleted accounts included.'),
  }),
)

export const adminDirectoryUserSchema = named(
  'AdminDirectoryUser',
  z.object({
    id,
    name: z.string(),
    email: z.string(),
    role: z.enum(['TRAINER', 'CLIENT']),
    suspended: z.boolean(),
    createdAt: instant.describe('Sign-up; for a client, the day their trainer added them.'),
    lastActiveOn: date.nullable().describe('Business date of the last activity; null if never active.'),
    currentTrainer: z
      .object({ id, name: z.string() })
      .nullable()
      .describe('Clients only: the current trainer, null when none. Always null for a trainer.'),
    currentClientCount: count.nullable().describe('Trainers only: clients with an active relationship. Null for a client.'),
  }),
)

export const adminDirectoryPageSchema = named(
  'AdminDirectoryPage',
  z.object({ users: z.array(adminDirectoryUserSchema), nextCursor }),
)

export const adminRelationshipSchema = named(
  'AdminRelationship',
  z.object({
    user: adminUserRefSchema.describe('The other party of the relationship.'),
    startedAt: instant,
    endedAt: instant.nullable().describe('Null for a current relationship.'),
    suspended: z.boolean().describe('Whether the other party is suspended.'),
  }),
)

const adminProfileBasics = {
  id,
  name: z.string(),
  email: z.string(),
  cpf: z
    .string()
    .nullable()
    .describe('Masked, `***.***.***-NN` (the last two digits), or null when none. Never the full CPF.'),
  suspended: z.boolean(),
  suspendedAt: instant.nullable().describe('Null while active.'),
  createdAt: instant.describe('Sign-up; for a client, the day their trainer added them.'),
  lastActiveOn: date.nullable().describe('Business date of the last activity; null if never active.'),
}

export const adminTrainerProfileSchema = named(
  'AdminTrainerProfile',
  z.object({
    ...adminProfileBasics,
    role: z.literal('TRAINER'),
    cref: z.string().nullable(),
    whatsapp: z.string().nullable().describe('Digits; null unless the trainer shares it.'),
    instagram: z.string().nullable().describe('Handle without “@”; null unless the trainer shares it.'),
    currentClients: z.array(adminRelationshipSchema).describe('Oldest relationship first.'),
    formerClients: z.array(adminRelationshipSchema).describe('Most recently ended first.'),
    planCount: count,
    workoutCount: count,
    privateExerciseCount: count,
  }),
)

export const adminClientProfileSchema = named(
  'AdminClientProfile',
  z.object({
    ...adminProfileBasics,
    role: z.literal('CLIENT'),
    currentTrainer: adminRelationshipSchema.nullable().describe('Null when the client has no current trainer.'),
    pastTrainers: z.array(adminRelationshipSchema).describe('Most recently ended first.'),
    planCount: count,
    completedWorkoutCount: count,
    firstAccess: z.object({
      pending: z.boolean().describe('The client has not set a password yet.'),
      lastSentAt: instant.nullable().describe('When the latest first-access e-mail was accepted for delivery; null if none.'),
      lastSendFailed: z.boolean().describe('The latest first-access send failed on every try.'),
    }),
  }),
)

export const adminUserProfileSchema = named(
  'AdminUserProfile',
  z.discriminatedUnion('role', [adminTrainerProfileSchema, adminClientProfileSchema]),
)

export const adminActionSchema = named('AdminAction', z.enum(ADMIN_ACTIONS))

export const adminActionEntrySchema = named(
  'AdminActionEntry',
  z.object({
    id,
    admin: adminUserRefSchema.describe('Who did it.'),
    action: adminActionSchema,
    targetUser: adminUserRefSchema.nullable().describe('The affected trainer or client; null for own-password and catalog actions.'),
    relatedUser: adminUserRefSchema
      .nullable()
      .describe('The trainer of an ended relationship, or a promoted exercise’s owner; null otherwise.'),
    targetExerciseId: id.nullable().describe('Catalog actions only.'),
    targetMuscleGroupId: id.nullable().describe('Muscle-group actions only.'),
    subjectLabel: z.string().nullable().describe('Exercise or muscle-group name at the time of the action; null otherwise.'),
    reason: z.string().nullable().describe('Suspend / reactivate only; null when the target account was deleted.'),
    createdAt: instant,
  }),
)

export const adminActionPageSchema = named(
  'AdminActionPage',
  z.object({ entries: z.array(adminActionEntrySchema).describe('Newest first.'), nextCursor }),
)

export const adminActionAdminsSchema = named(
  'AdminActionAdmins',
  z.object({ admins: z.array(adminUserRefSchema).describe('By name.') }),
)

export const passwordSetupResultSchema = named(
  'PasswordSetupResult',
  z.object({
    role: roleSchema.describe('Whose first access it was: the web shows a CLIENT the “use the app” screen.'),
    email: z.string().describe('The account’s email, so the client can be sent to the app with it filled in.'),
  }),
)

export const consentSchema = named(
  'Consent',
  z.object({
    termsVersion: z.string().nullable().describe('Terms of Use / Privacy Policy version accepted, null if never.'),
    termsAcceptedAt: instant.nullable(),
    healthDataVersion: z.string().nullable().describe('Health-data notice version consented to, null if never.'),
    healthDataConsentAt: instant.nullable(),
  }),
)

export const meSchema = named(
  'Me',
  z.object({
    id,
    name: z.string(),
    email: z.string(),
    cpf: z.string().describe('Masked (`***.***.***-25`), `""` when none. Never revealed here.'),
    cref: z.string().describe('`""` for anyone but a trainer who set one.'),
    role: roleSchema,
    whatsapp: z.string().describe("A trainer's WhatsApp, digits only; `\"\"` when none."),
    instagram: z.string().describe("A trainer's Instagram handle without `@`; `\"\"` when none."),
    showEmail: z.boolean().describe('Whether the trainer shows their e-mail to their clients.'),
    showWhatsapp: z.boolean(),
    showInstagram: z.boolean(),
    consent: consentSchema,
  }),
)

export const clientTrainerSchema = named(
  'ClientTrainer',
  z.object({
    name: z.string(),
    email: z.string().describe('`""` unless the trainer shows it.'),
    whatsapp: z.string().describe('Digits with area code; `""` unless the trainer shows it.'),
    instagram: z.string().describe('Handle without `@`; `""` unless the trainer shows it.'),
  }),
)

export const legalVersionsSchema = named(
  'LegalVersions',
  z.object({
    terms: z.string().describe('Sent as `acceptedTermsVersion` on register and as the `TERMS` consent version.'),
    healthData: z.string().describe('Sent as the `HEALTH_DATA` consent version.'),
  }),
)

/** vertice-api's `ExportUserData` document, passed through as is; only the top level is described. */
export const dataExportSchema = named(
  'DataExport',
  z.looseObject({
    formatVersion: z.unknown(),
    exportedAt: z.unknown(),
    profile: z.unknown().describe('CPF and CREF in full: it is the user’s own copy.'),
    consent: z.unknown(),
    relationships: z.unknown(),
    plans: z.unknown(),
    workoutLogs: z.unknown(),
    exercises: z.unknown(),
  }),
)

export const healthSchema = named('Health', z.object({ status: z.literal('ok') }))

// ---- clients ------------------------------------------------------------------------------------

export const clientDetailSchema = named(
  'ClientDetail',
  z.object({
    id,
    name: z.string(),
    email: z.string(),
    cpf: z.string().describe('Masked (`***.***.***-25`, `""` when none) unless `?reveal=cpf`.'),
    role: roleSchema,
  }),
)

export const passwordSetupTokenSchema = named(
  'PasswordSetupToken',
  z.object({
    token: z.string().describe('Single-use, URL-safe. Shown once: upstream only stores its hash.'),
    expiresAt: instant,
  }),
)

export const createdClientSchema = named(
  'CreatedClient',
  clientDetailSchema.extend({
    setup: passwordSetupTokenSchema
      .nullable()
      .describe('Null only when the client was created but issuing the token failed: re-issue it.'),
  }),
)

const weekdaySchema = named('Weekday', z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']))

export const clientSummarySchema = named(
  'ClientSummary',
  z.object({
    id,
    name: z.string(),
    activePlanCount: z.number().int(),
    currentPlan: z
      .object({ id, name: z.string(), endDate: date })
      .nullable()
      .describe('The date-active plan (startDate <= today <= endDate), null if none.'),
    lastWorkoutAt: instant
      .nullable()
      .describe(
        'Most recent completed log in the current week only. An ISO-8601 instant in UTC (`Z`): ' +
          'format it in America/Sao_Paulo.',
      ),
    weekActivity: z
      .array(z.object({ date, dayOfWeek: weekdaySchema, completed: z.boolean() }))
      .describe('Monday to Friday of the current week.'),
  }),
)

export const clientOverviewSchema = named(
  'ClientOverview',
  z.object({
    student: clientDetailSchema,
    activePlan: z
      .object({ id, name: z.string(), level: planLevelSchema, startDate: date, endDate: date })
      .nullable(),
    thisWeek: z.object({ completed: z.number().int(), total: z.number().int() }),
    lastWorkoutAt: instant.nullable(),
    adherence4Weeks: z.number().nullable().describe('Approximate percentage, capped at 100.'),
  }),
)

// ---- catalog ------------------------------------------------------------------------------------

export const muscleGroupSchema = named('MuscleGroup', z.object({ id, name: z.string() }))

export const exerciseSchema = named(
  'Exercise',
  z.object({
    id,
    name: z.string(),
    description: z.string(),
    videoUrl: z.string(),
    muscleGroups: z.array(muscleGroupSchema).describe('Upstream order: primary group first, then the others by id.'),
    isStarter: z.boolean().describe('Part of the shared, read-only starter set.'),
  }),
)

export const exercisePageSchema = named(
  'ExercisePage',
  z.object({
    exercises: z.array(exerciseSchema).describe('In upstream order: do not re-sort client-side.'),
    nextCursor: z.string().nullable().describe('Send back as `cursor` (same filter) for the next page; `null` on the last page.'),
  }),
)

export const progressExerciseSchema = named(
  'ProgressExercise',
  z.object({ id, name: z.string() }),
)

// ---- plans, workouts, sets ----------------------------------------------------------------------

export const trainingPlanSchema = named(
  'TrainingPlan',
  z.object({
    id,
    name: z.string(),
    description: z.string(),
    trainerId: id,
    clientId: id,
    startDate: date,
    endDate: date,
    level: planLevelSchema,
  }),
)

export const workoutSchema = named(
  'Workout',
  z.object({ id, name: z.string(), trainingPlanId: id, dayOfWeek: dayOfWeekSchema }),
)

export const trainingPlanDetailSchema = named(
  'TrainingPlanDetail',
  trainingPlanSchema.extend({ workouts: z.array(workoutSchema) }),
)

export const exerciseSetSchema = named(
  'ExerciseSet',
  z.object({
    id,
    workoutExerciseId: id,
    setNumber: z.number().int(),
    reps: z.number().int(),
    durationSeconds: z.number().int(),
    weight: z.string().describe('Decimal string; `""` is unset. Do not round-trip through a float.'),
    loadPercentage: z.string().describe('Decimal string; `""` is unset.'),
    strategy: setStrategySchema,
    restSeconds: z.number().int(),
    notes: z.string(),
  }),
)

export const workoutExerciseSchema = named(
  'WorkoutExercise',
  z.object({
    id,
    workoutId: id,
    exerciseId: id,
    order: z.number().int(),
    restSecondsBetweenSets: z.number().int(),
    notes: z.string(),
  }),
)

export const fullWorkoutSchema = named(
  'FullWorkout',
  workoutSchema.extend({
    exercises: z.array(
      workoutExerciseSchema.extend({ exercise: exerciseSchema, sets: z.array(exerciseSetSchema) }),
    ),
  }),
)

export const recentWorkoutSummarySchema = named(
  'RecentWorkoutSummary',
  workoutSchema.extend({ studentName: z.string(), planName: z.string(), exerciseCount: z.number().int() }),
)

// ---- sessions, logs, feedback -------------------------------------------------------------------

export const workoutLogStatusSchema = named(
  'WorkoutLogStatus',
  z
    .enum(['IN_PROGRESS', 'COMPLETED', 'SUPERSEDED'])
    .describe('`SUPERSEDED`: replaced by a redo finished in the same week (never in the week list).'),
)

export const completionKindSchema = named(
  'CompletionKind',
  z.enum(['CLIENT', 'AUTO', '']).describe('Who finished it: the client, or the weekly rollover (`AUTO`); `""` in progress.'),
)

export const feedbackRatingSchema = named(
  'FeedbackRating',
  z.enum(FEEDBACK_RATINGS).describe('How hard the workout felt, hardest first.'),
)

export const workoutLogSchema = named(
  'WorkoutLog',
  z.object({
    id,
    workoutId: id,
    clientId: id,
    weekStartDate: date,
    startedAt: instant,
    completedAt: z.string().describe('ISO-8601 instant, `""` until the workout is completed.'),
    status: workoutLogStatusSchema,
    completionKind: completionKindSchema,
  }),
)

export const setLogSchema = named(
  'SetLog',
  z.object({
    id,
    workoutLogId: id,
    exerciseSetId: id,
    weight: z.string().describe('Decimal string; `""` when the set was ticked without a weight.'),
    reps: z.number().int(),
    recordedAt: instant,
  }),
)

export const workoutSessionSchema = named(
  'WorkoutSession',
  workoutSchema.extend({
    exercises: z.array(
      workoutExerciseSchema.extend({
        exercise: exerciseSchema,
        sets: z.array(
          exerciseSetSchema.extend({
            lastPerformed: setLogSchema.nullable().describe('What the client recorded last time, null if never.'),
            current: setLogSchema
              .nullable()
              .describe("What this session recorded for the set (it's ticked), null if not: resumes a session on another device."),
          }),
        ),
      }),
    ),
    workoutLog: workoutLogSchema,
  }),
)

export const progressPointSchema = named(
  'ProgressPoint',
  z.object({ weekStartDate: date, weight: z.number() }),
)

export const workoutFeedbackSchema = named(
  'WorkoutFeedback',
  z.object({
    id,
    workoutLogId: id,
    workoutId: id,
    trainingPlanId: id,
    clientId: id,
    text: z.string().describe('`""` when the client only rated the workout.'),
    rating: feedbackRatingSchema.nullable().describe('Null on feedback given before ratings existed.'),
    replaced: z.boolean().describe("The session was replaced by a redo finished in the same week."),
    createdAt: instant,
  }),
)

export const enrichedFeedbackSchema = named(
  'EnrichedFeedback',
  workoutFeedbackSchema.extend({ clientName: z.string(), workoutName: z.string(), trainingPlanName: z.string() }),
)

export const dashboardSchema = named(
  'Dashboard',
  z.object({
    stats: z.object({
      activeClients: z.number().int(),
      activePlans: z.number().int(),
      recentFeedbackCount: z.number().int(),
      expiringPlansCount: z.number().int(),
    }),
    recentFeedback: z.array(enrichedFeedbackSchema),
    expiringPlans: z.array(
      z.object({ name: z.string(), student: z.string(), end: date, daysLeft: z.number().int() }),
    ),
    completedToday: z.array(
      z.object({
        student: z.string(),
        workout: z.string(),
        time: z
          .string()
          .describe(
            'DEPRECATED, use `completedAt`. The `HH:MM` wall clock of the completion in ' +
              'America/Sao_Paulo — a pre-formatted local time, with the zone implicit, which is why ' +
              'it is going away. It is kept only so clients can migrate: it used to be the UTC ' +
              'clock (`completedAt.slice(11, 16)`), which displayed an evening workout about 3 ' +
              'hours early, and it now reads correctly. It will be removed once vertice-web-react ' +
              'reads `completedAt`.',
          )
          .meta({ deprecated: true }),
        completedAt: instant.describe(
          'When the workout was completed, as an ISO-8601 instant in UTC (`Z`). Prefer this over ' +
            'the deprecated `time`: format the clock in America/Sao_Paulo (`Intl.DateTimeFormat` ' +
            'with `timeZone`), e.g. 20:30. "Today" is still the server\'s: the entries are the ' +
            'completions whose business day in America/Sao_Paulo is today.',
        ),
      }),
    ),
  }),
)

// ---- compile-time drift check -------------------------------------------------------------------

/** True when `A` and `B` accept each other (same shape, whatever the declaration style). */
type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
type Out<S extends z.ZodType> = z.output<S>
type Resolved<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>

export type ResponseSchemasMatchServices = [
  Assert<SameShape<Out<typeof roleSchema>, userService.Role>>,
  Assert<SameShape<Out<typeof sessionSchema>, authService.Session>>,
  Assert<SameShape<Out<typeof adminChallengeSchema>, adminAuthService.AdminChallenge>>,
  Assert<SameShape<Out<typeof adminEnrollmentSchema>, adminAuthService.AdminEnrollment>>,
  Assert<SameShape<Out<typeof adminSessionSchema>, adminAuthService.AdminSession>>,
  Assert<SameShape<Out<typeof adminUserRefSchema>, adminService.AdminUserRef>>,
  Assert<SameShape<Out<typeof adminDashboardSchema>, adminService.AdminDashboard>>,
  Assert<SameShape<Out<typeof adminDirectoryPageSchema>, adminService.AdminDirectoryPage>>,
  Assert<SameShape<Out<typeof adminUserProfileSchema>, adminService.AdminUserProfile>>,
  Assert<SameShape<Out<typeof adminActionPageSchema>, adminService.AdminActionPage>>,
  Assert<SameShape<Out<typeof adminActionAdminsSchema>, adminService.AdminActionAdmins>>,
  Assert<SameShape<Out<typeof passwordSetupResultSchema>, userService.RedeemedSetup>>,
  Assert<SameShape<Out<typeof consentSchema>, userService.Consent>>,
  Assert<SameShape<Out<typeof meSchema>, userService.Me>>,
  Assert<SameShape<Out<typeof legalVersionsSchema>, LegalVersions>>,
  Assert<SameShape<Out<typeof clientDetailSchema>, clientService.ClientDetail>>,
  Assert<SameShape<Out<typeof passwordSetupTokenSchema>, userService.PasswordSetupToken>>,
  Assert<SameShape<Out<typeof createdClientSchema>, clientService.CreatedClient>>,
  Assert<SameShape<Out<typeof clientSummarySchema>, clientService.ClientSummary>>,
  Assert<SameShape<Out<typeof clientOverviewSchema>, clientService.ClientOverview>>,
  Assert<SameShape<Out<typeof muscleGroupSchema>, exerciseService.MuscleGroup>>,
  Assert<SameShape<Out<typeof exerciseSchema>, exerciseService.Exercise>>,
  Assert<SameShape<Out<typeof exercisePageSchema>, exerciseService.ExercisePage>>,
  Assert<SameShape<Out<typeof progressExerciseSchema>, sessionService.ProgressExercise>>,
  Assert<SameShape<Out<typeof trainingPlanSchema>, planService.TrainingPlan>>,
  Assert<SameShape<Out<typeof workoutSchema>, workoutService.Workout>>,
  Assert<SameShape<Out<typeof exerciseSetSchema>, exerciseSetService.ExerciseSet>>,
  Assert<SameShape<Out<typeof workoutExerciseSchema>, workoutExerciseService.WorkoutExercise>>,
  Assert<SameShape<Out<typeof fullWorkoutSchema>, Resolved<typeof workoutService.getFullWorkout>>>,
  Assert<SameShape<Out<typeof recentWorkoutSummarySchema>, workoutService.RecentWorkoutSummary>>,
  Assert<SameShape<Out<typeof workoutLogSchema>, sessionService.WorkoutLog>>,
  Assert<SameShape<Out<typeof setLogSchema>, sessionService.SetLog>>,
  Assert<SameShape<Out<typeof workoutSessionSchema>, Resolved<typeof sessionService.getWorkoutSession>>>,
  Assert<SameShape<Out<typeof progressPointSchema>, sessionService.ProgressPoint>>,
  Assert<SameShape<Out<typeof workoutFeedbackSchema>, feedbackService.WorkoutFeedback>>,
  Assert<SameShape<Out<typeof enrichedFeedbackSchema>, feedbackService.EnrichedFeedback>>,
  Assert<SameShape<Out<typeof dashboardSchema>, Resolved<typeof dashboardService.getTrainerDashboard>>>,
]
