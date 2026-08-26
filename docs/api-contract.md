# vertice-bff API contract

Base URL (dev): `http://localhost:3000/api`

All endpoints except `/auth/login` and `/auth/register` require:
`Authorization: Bearer <token>`

All error responses have the shape:
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} } }
```
Common codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED`/`UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `UPSTREAM_UNAVAILABLE` (503).

Roles: `TRAINER`, `CLIENT`, `ADMIN`. Most write endpoints require `TRAINER`. All list/detail endpoints auto-scope to the caller (a `CLIENT` only ever sees their own data; a `TRAINER` only sees their own students/plans).

## Known MVP limitation
`POST /auth/login` only checks that the email exists — vertice-api's gRPC surface has no password-verification RPC yet, so **any password is accepted for an existing account**. Fine for local testing; do not treat this as real auth.

---

## Auth — `/auth`
- `POST /login` `{email, password}` → `{token, user: {id,name,email,role}}`
- `POST /register` `{name, email, password, role: "TRAINER"|"CLIENT", cpf, cref?}` → same shape as login. **`cpf` is required** (vertice-api rejects empty/invalid CPF). `cref` is optional (trainer license number).
- `GET /me` (auth) → full `User` `{id,name,email,cpf,cref,role}`

## Students — `/students` (TRAINER only)
A trainer's roster = distinct clients across their training plans (User has no direct trainer link).
- `GET /` → `StudentSummary[]` = `User & {activePlanCount}`
- `GET /:id` → `User` (403 if not one of your students)
- **`GET /:id/overview`** → aggregation for the student-detail header (active plan, this-week progress, last workout, adherence). One call instead of orchestrating training-plans + workouts + workout-logs from the frontend:
  ```json
  {
    "student": { "...User" },
    "activePlan": { "id": 0, "name": "", "level": "BEGINNER", "startDate": "", "endDate": "" } | null,
    "thisWeek": { "completed": 0, "total": 0 },
    "lastWorkoutAt": "2026-08-26T16:52:17.169082Z" | null,
    "adherence4Weeks": 0 | null
  }
  ```
  `activePlan` is the plan whose `[startDate, endDate]` contains today (most recently started one wins if more than one overlaps); everything else is zeroed/null when the student has no active plan. `thisWeek` counts completed vs. total workouts in the active plan for the current ISO week. `adherence4Weeks` is an **approximation**: vertice-api's `ListWorkoutLogs` RPC is scoped to one plan + one week (no general history query), so this re-fetches logs for the last 4 Mondays (clamped to weeks on/after the plan's start date), treats the plan's workout list as the recurring weekly schedule, and computes `completed / (workoutsPerWeek × weeksElapsed) × 100`, capped at 100. `lastWorkoutAt` is the latest `completedAt` found in that same 4-week lookback window (not a true all-time last-workout value — there's no cheaper way to get that from the current API surface).
- `POST /` `{name, email, password, cpf}` → creates a CLIENT user
- `PATCH /:id` `{name, email, cpf?}`
- `DELETE /:id`

## Exercises (catalog) — `/exercises`
Shared across all trainers.
- `GET /` → `Exercise[]` = `{id, name, description, videoUrl}`
- `GET /:id` → `Exercise`
- `GET /:id/progress?clientId=` → `{weekStartDate, weight}[]` (weight-over-time for a graph). CLIENT role ignores `clientId` and uses their own id; TRAINER must pass it.
- `POST /` `{name, description, videoUrl?}` (TRAINER)
- `PATCH /:id` (TRAINER)
- `DELETE /:id` (TRAINER)

## Training plans — `/training-plans`
- `GET /?clientId=` → `TrainingPlan[]`. CLIENT: own plans only. TRAINER: own plans, optionally filtered by `clientId`.
- `GET /:id` → `TrainingPlan & { workouts: Workout[] }` (nested workouts included for the plan-detail screen)
- `POST /` `{name, description, clientId, startDate: "YYYY-MM-DD", endDate, level: "BEGINNER"|"INTERMEDIATE"|"ADVANCED"}` (TRAINER)
- `PATCH /:id` same body minus clientId (TRAINER)
- `DELETE /:id` (TRAINER)

`TrainingPlan` = `{id, name, description, trainerId, clientId, startDate, endDate, level}`

## Workouts
- `GET /training-plans/:planId/workouts` → `Workout[]`
- `POST /training-plans/:planId/workouts` `{name, dayOfWeek}` (TRAINER)
- `GET /workouts/:id` → `Workout` = `{id, name, trainingPlanId, dayOfWeek}`
- **`GET /workouts/:id/full`** → `Workout & { exercises: FullWorkoutExercise[] }` — **the key aggregate for a workout-builder or read-only workout view.** Each `FullWorkoutExercise` = `WorkoutExercise & { exercise: Exercise, sets: ExerciseSet[] }`, sorted by `order`/`setNumber`. One call gets everything needed to render a workout.
- `PATCH /workouts/:id` `{name, dayOfWeek}` (TRAINER)
- `DELETE /workouts/:id` (TRAINER)
- `POST /workouts/:id/clone` `{targetTrainingPlanId, name, dayOfWeek}` (TRAINER) → clones exercises+sets into a new workout, for "reuse a previous workout as a base"

`dayOfWeek`: `MONDAY..SUNDAY`

## Workout exercises
- `GET /workouts/:workoutId/exercises` → `WorkoutExercise[]`
- `POST /workouts/:workoutId/exercises` `{exerciseId, order, restSecondsBetweenSets, notes?}` (TRAINER)
- `PATCH /workout-exercises/:id` `{order, restSecondsBetweenSets, notes?}` (TRAINER)
- `DELETE /workout-exercises/:id` (TRAINER)

`WorkoutExercise` = `{id, workoutId, exerciseId, order, restSecondsBetweenSets, notes}`

## Exercise sets
- `GET /workout-exercises/:workoutExerciseId/sets` → `ExerciseSet[]`
- `POST /workout-exercises/:workoutExerciseId/sets` (TRAINER)
- `PATCH /exercise-sets/:id` (TRAINER)
- `DELETE /exercise-sets/:id` (TRAINER)

`ExerciseSet` = `{id, workoutExerciseId, setNumber, reps, durationSeconds, weight, loadPercentage, strategy, restSeconds, notes}`.
`weight`/`loadPercentage` are decimal **strings** (preserve precision — don't round-trip through float).
`strategy`: `STRAIGHT | WARM_UP | BACKOFF | DROPSET | REST_PAUSE | CLUSTER | AMRAP | ISOMETRIC_HOLD | FAILURE`

## Workout sessions (the client "do a workout" flow)
- **`GET /workouts/:workoutId/session?weekStartDate=YYYY-MM-DD`** (defaults to the current week's Monday) — CLIENT uses own id; TRAINER must pass `?clientId=` and that client must be assigned to the workout's plan.
  → `Workout & { exercises: [...FullWorkoutExercise, sets: [...ExerciseSet, lastPerformed: SetLog|null]] , workoutLog: WorkoutLog }`.
  This auto-starts (or resumes) this week's log and merges in last time's recorded weight/reps per set (`lastPerformed`), so the UI can show "last time: 60kg × 12" inline. **This is the single call the workout-execution screen needs.**
- `POST /workout-sessions/:workoutLogId/sets` `{exerciseSetId, weight, reps}` (CLIENT) → records one set's actual performance
- `POST /workout-sessions/:workoutLogId/complete` (CLIENT) → marks the log done
- `GET /workout-logs?trainingPlanId=&weekStartDate=&clientId=` — **`trainingPlanId` is required** by vertice-api (this RPC is scoped to one plan + one week, not a general history query). CLIENT uses own id; TRAINER must pass `clientId` (must be their student). Use this to render "which workouts are done this week."

`WorkoutLog` = `{id, workoutId, clientId, weekStartDate, startedAt, completedAt}` (`completedAt` is `""` until completed).

## Feedback
- `POST /workout-logs/:workoutLogId/feedback` `{text}` (CLIENT)
- `GET /feedback` (TRAINER) → `EnrichedFeedback[]` = `WorkoutFeedback & {clientName, workoutName, trainingPlanName}`, newest first. **Not** scoped to one client — returns the whole trainer's feedback. Screens that need one student's feedback (e.g. the student-detail page) filter this client-side by `clientId`; the trainer's total feedback volume is small enough that this is fine for now. No `?clientId=` param was added — revisit if that assumption stops holding.

## Dashboard (TRAINER)
- `GET /dashboard` → everything the trainer landing page needs in one call:
```json
{
  "stats": { "activeClients": 0, "activePlans": 0, "recentFeedbackCount": 0, "expiringPlansCount": 0 },
  "recentFeedback": [ { "...EnrichedFeedback" } ],
  "expiringPlans": [ { "name": "", "student": "", "end": "YYYY-MM-DD", "daysLeft": 0 } ],
  "completedToday": [ { "student": "", "workout": "", "time": "HH:MM" } ]
}
```
This maps directly onto the existing `DashboardView.vue` mockup's data shape (stats tiles, recent feedback list, expiring plans, completed-today list) — swap the hardcoded arrays for a `fetch('/api/dashboard')` call.

---

## Running locally
1. `cd vertice-api && docker compose up -d` (postgres on 5432)
2. `cd vertice-api && ./gradlew bootRun --args='--spring.profiles.active=local'` — gRPC on `:9090`, auth disabled for local dev (see `application-local.properties`)
3. `cd vertice-bff && cp .env.example .env && npm install && npm run dev` — REST API on `:3000`
4. `cd vertice-web && npm run dev` — Vite dev server, default `:5173`
