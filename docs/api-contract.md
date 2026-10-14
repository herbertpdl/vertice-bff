# vertice-bff API contract

Base URL (dev): `http://localhost:3000/api`

All endpoints except `/auth/login`, `/auth/register` and `/auth/password/setup` require:
`Authorization: Bearer <token>`

All error responses have the shape:
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} } }
```
Common codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED`/`UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `PRECONDITION_FAILED` (409), `RATE_LIMITED` (429, with a `Retry-After` header in seconds), `UPSTREAM_UNAVAILABLE` (503).

`PRECONDITION_FAILED` (409) means the request was well-formed but the resource's current state forbids it — emitted by `PUT /workouts/:workoutId/exercises`, when a client has already recorded data under the workout (the `message` names the blocking exercise and set number), and by `DELETE /exercises/:id`, while any workout uses the exercise. The `message` is vertice-api's verbatim. Distinct from `VALIDATION_ERROR` ("fix the payload").

Roles: `TRAINER`, `CLIENT`, `ADMIN`. Most write endpoints require `TRAINER`. Every id a route accepts (path, query or body) is checked against the caller: a `CLIENT` only reaches their own plans, workouts and workout logs; a `TRAINER` only their own plans and their own clients (`TrainerClientService.IsTrainersClient`). Another user's id is **403 `FORBIDDEN`**. A `CLIENT`'s `clientId` query parameter is ignored and replaced with their own id. `ADMIN` bypasses the plan/workout/log ownership checks but still has to name a client where a route needs one. `src/test/route-authorization.test.ts` pins this per route.

## Rate limits
- **Global:** every route shares a loose per-IP bucket (default 300 requests per minute; `RATE_LIMIT_GLOBAL_MAX`/`RATE_LIMIT_GLOBAL_WINDOW_MS`).
- **Auth (strict):** separate buckets per route, per IP and (where the body has one) per email, default 5 per 15 minutes (`AUTH_RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_WINDOW_MS`). Once a bucket is full the next request is `429 RATE_LIMITED`, whatever its credentials, until the window ends.
  - `POST /auth/login` (IP + email) and `POST /auth/password/setup` (IP) count **failed** attempts only: a response below 400 gives the attempt back, so the 6th failure in 15 minutes is a 429 and a gym full of clients on one IP can still log in.
  - `POST /auth/register` (IP + email) counts **every** attempt: a successful sign-up is what a spammer repeats.
  - `POST /auth/password` (IP + user) counts failed attempts.
  - A 5xx (upstream down) never counts.
- Counters live in the BFF process (one instance today); behind a proxy, set `TRUST_PROXY` (see the README) or every client shares the proxy's bucket.

---

## Auth — `/auth`
Passwords follow vertice-api's policy everywhere one is set: **at least 8 characters, at most 72 UTF-8 bytes, not blank**. A violation is `400 VALIDATION_ERROR`, checked in the BFF before any upstream call. Emails are trimmed and lower-cased.

- `POST /login` `{email, password}` → `{token, user: {id,name,email,role}}`. The password is checked by vertice-api (`VerifyCredentials`). A wrong password, an unknown email and an account with no password yet all get the **same** `401 {"error":{"code":"UNAUTHORIZED","message":"Invalid email or password"}}`.
  - Rollout flag: with `VERIFY_PASSWORDS=false` (development/test only; the BFF refuses to start with it anywhere else) login only checks that the email exists, the old MVP behaviour. Default is `true`.
- `POST /register` `{name, email, password, role: "TRAINER", cpf, cref?}` → `201`, same shape as login. **Only `TRAINER`**: `role: "CLIENT"` is `400 VALIDATION_ERROR` (clients are created by their trainer, `POST /clients`). **`cpf` is required** (vertice-api rejects empty/invalid CPF). `cref` is optional (trainer license number). A taken email is `409 CONFLICT` from vertice-api.
- `GET /me` (auth) → full `User` `{id,name,email,cpf,cref,role}`
- `POST /password` (auth, any role) `{currentPassword, newPassword}` → `204`. Changes the caller's own password after re-checking the current one. A wrong `currentPassword` is **`400 INVALID_CURRENT_PASSWORD`**, not a 401: the session is still valid, so clients must not log out on it.
- `POST /password/setup` (public) `{token, newPassword}` → `204`. First access: the client chooses a password with the setup token from `POST /clients` (or `POST /clients/:id/setup-token`), then logs in normally. An unknown, expired (72h) or already used token is **`400 INVALID_SETUP_TOKEN`** (vertice-api's `UNAUTHENTICATED`, mapped so clients don't read it as a logout). The token is single-use, and issuing a new one invalidates the previous one.

## Students — `/students` (TRAINER only)
A trainer's roster = distinct clients across their training plans (User has no direct trainer link). **This means a newly created student with no training plan yet does not appear in `GET /` until a plan is created for them** — this is pre-existing behavior of the roster derivation, not something the endpoints below change.
- **`GET /`** → `StudentOverview[]` = `User & {activePlanCount, currentPlan, lastWorkoutAt, weekActivity}`, for the roster/list screen:
  - `currentPlan`: `{id, name, endDate} | null` — the student's date-active training plan (`startDate <= today <= endDate`) among the trainer's plans for them; `null` if none is currently active (shown as a "Sem plano" tag in the UI). If more than one plan is active at once, the most recently started one is returned.
  - `lastWorkoutAt`: ISO timestamp of the student's most recent *completed* workout log, or `null`. **Scoped to the current week only** — see limitation note below.
  - `weekActivity`: `{date, dayOfWeek, completed}[]`, always 5 entries for Monday–Friday of the current week, `completed` true if a workout log finished on that calendar date. Powers the 5-dot weekly-activity indicator.

  Limitation: vertice-api's `ListWorkoutLogs` RPC is scoped to one `trainingPlanId` + one `weekStartDate` at a time (no general "this client's workout history" query), so — mirroring the dashboard module's `completedToday` logic — `lastWorkoutAt`/`weekActivity` only reflect the *current* week's logs across all of the trainer's plans for that client. A student whose last completed workout falls in an earlier week shows `lastWorkoutAt: null` and an all-empty week strip here, rather than a stale older date.
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
- `POST /` `{name, email, cpf?}` → `201` `User & {setup}` — creates a CLIENT user **without a password** and issues a first-access token. A `password` in the body is ignored (never sent upstream): the client chooses their own.
  ```json
  {
    "id": 42, "name": "Ana", "email": "ana@example.com", "cpf": "", "cref": "", "role": "CLIENT",
    "setup": { "token": "<43-char base64url>", "expiresAt": "2026-10-16T18:00:00Z" } | null
  }
  ```
  The web builds the link the trainer shares from the token: `/definir-senha?token=<token>` (the page posts it to `POST /auth/password/setup`). The token is shown once (vertice-api only stores its hash) and expires after 72h. There is no email delivery yet. `setup` is `null` only when the client was created but issuing the token failed; re-issue it with the route below rather than re-creating the client (that would be a 409 on the email).
- `POST /:id/setup-token` (**TRAINER only**, one of your clients) → `201` `{token, expiresAt}`. Re-issues the first-access link; the previous one stops working. Only while the client has no password yet: once they set one it is **`409 PRECONDITION_FAILED`**, since a trainer-issued link would let the trainer reset the client's password. (Clients created before setup tokens existed have a random password, so they get their link from ops: `npm run ops:issue-setup-tokens`, see the README.) Errors: 403 `Requires role: TRAINER` (ADMIN, CLIENT); 403 `This client is not one of your clients`.
- `PATCH /:id` `{name, email, cpf?}`
- `DELETE /:id`

## Exercises (catalog) — `/exercises`, `/muscle-groups`
The catalog is the shared **starter set** (`isStarter: true`, read-only for everyone) plus each trainer's own exercises. **Trainer-created exercises are private; the starter set is shared.** A trainer sees the starter set and their own exercises only; an ADMIN sees the starter set only. Visibility, ordering and search are decided by vertice-api from the caller's identity — the BFF has no exercise-ownership check of its own and returns lists in upstream order.

```ts
MuscleGroup = { id: number, name: string }
Exercise    = { id: number, name: string, description: string, videoUrl: string,
                muscleGroups: MuscleGroup[],   // upstream order: primary group first, then the others by id (starter rows only have a primary; a trainer's own exercise is plain id order)
                isStarter: boolean }
```
There is no `muscleGroup` field any more (the old `CHEST | BACK | …` enum is gone) — anywhere an `Exercise` is embedded, too.

- `GET /muscle-groups` (any role) → `MuscleGroup[]` in id order — 14 rows (Peito … Cardio). Use it to populate filters/pickers; ids are database-generated, don't hardcode them.
- `GET /exercises?muscleGroupId=&q=` (TRAINER/ADMIN) → `Exercise[]` **in upstream order**: own exercises first (name asc), then starter exercises (with a group filter: primary-group matches in catalog order, then secondary matches by name; without: name asc). Don't re-sort client-side.
  - `muscleGroupId` — optional positive integer; exercises with that group as primary or secondary. Empty (`?muscleGroupId=`) = no filter.
  - `q` — optional name search (case-insensitive substring), trimmed, ≤100 chars. Empty = no filter.
  - Errors: 403 `FORBIDDEN` `Requires role: TRAINER or ADMIN` (CLIENT); 400 `VALIDATION_ERROR` for a non-numeric/0/negative/repeated `muscleGroupId` or `q` >100 chars (field `details`); 404 `NOT_FOUND` for an unknown `muscleGroupId`.
- `GET /exercises/:id` (any role, upstream decides) → `Exercise`. TRAINER: starter or own; ADMIN: starter only; CLIENT: only an exercise used by a workout in one of their own plans.
  - Errors: 403 `FORBIDDEN` `You do not have access to exercise <id>`; 404 `NOT_FOUND` for a non-existent id (existence is not hidden).
- `GET /exercises/:id/progress?clientId=` → `{weekStartDate, weight}[]` (weight-over-time for a graph). CLIENT role ignores `clientId` and uses their own id; TRAINER and ADMIN must pass it.
  - Errors: 400 `VALIDATION_ERROR` `clientId is required` / `Invalid clientId: <value>` (TRAINER, ADMIN); 403 `FORBIDDEN` `This client is not one of your clients` (TRAINER).
- `POST /exercises` `{name, description?, videoUrl?, muscleGroupIds}` (TRAINER only) → `201` `Exercise` (`isStarter: false`, private to the caller).
  - `name` 1..255 chars (must not be blank); `description` ≤255, default `""`; `videoUrl` `""` or an http(s) URL ≤500, default `""`; `muscleGroupIds` at least one positive integer id — duplicates are dropped. A trainer-created exercise has no primary group, so its `muscleGroups` come back in id order whatever order was sent. Duplicate names are allowed.
  - Errors: 403 `FORBIDDEN` `Requires role: TRAINER` (CLIENT, ADMIN); 400 `VALIDATION_ERROR` with field `details` for Zod failures (`name` missing/empty/too long, `description`/`videoUrl` too long, `videoUrl` not a URL, `muscleGroupIds` missing/empty/non-positive — a body with only the old `muscleGroup` fails here); 400 `VALIDATION_ERROR` with a flat upstream message for `name: must not be blank`, `videoUrl: must be a valid http(s) URL`, `muscleGroupIds: unknown muscle group <id>`.
- `PATCH /exercises/:id` (TRAINER only), same body as `POST` — **full replacement** of name, description, video URL and the whole group list → `200` `Exercise`.
  - Errors: as `POST`, plus 403 `FORBIDDEN` `Exercise <id> belongs to the shared starter set and cannot be changed` (starter row); 403 `You do not have access to exercise <id>` (another trainer's); 404 `NOT_FOUND`.
- `DELETE /exercises/:id` (TRAINER only) → `204`, no body.
  - Errors: 403 `FORBIDDEN` `Requires role: TRAINER`; 403 `Exercise <id> belongs to the shared starter set and cannot be deleted` (starter row); 403 `You do not have access to exercise <id>` (another trainer's); 404 `NOT_FOUND`; **409 `PRECONDITION_FAILED` `Exercise <id> is used by a workout and cannot be deleted`** while any workout references it — remove it from those workouts first.

403 means "never allowed for you" (fix nothing, hide the action); 409 means "not right now" (the state can change).

## Training plans — `/training-plans`
- `GET /?clientId=` → `TrainingPlan[]`. CLIENT: own plans only. TRAINER: own plans, optionally filtered by `clientId`.
- `GET /:id` → `TrainingPlan & { workouts: Workout[] }` (nested workouts included for the plan-detail screen)
- `POST /` `{name, description, clientId, startDate: "YYYY-MM-DD", endDate, level: "BEGINNER"|"INTERMEDIATE"|"ADVANCED"}` (TRAINER)
  - Errors: 403 `FORBIDDEN` `This client is not one of your clients` when `clientId` is not the trainer's client. vertice-api also requires an active trainer–client link and answers 409 `PRECONDITION_FAILED` without one.
- `PATCH /:id` same body minus clientId (TRAINER). A plan's client is fixed at creation: a `clientId` in the body is ignored and the stored one is sent upstream.
- `DELETE /:id` (TRAINER)

`TrainingPlan` = `{id, name, description, trainerId, clientId, startDate, endDate, level}`

## Workouts
- **`GET /workouts?recent=true`** (TRAINER/ADMIN) → `RecentWorkoutSummary[]` = `Workout & {studentName, planName, exerciseCount}` — the trainer's workouts **across every plan/student**, for the workout-builder's "usar treino existente como base" clone picker. `?recent=true` is currently the only supported mode (no unfiltered "list all" query). Sorted by workout id descending (proxy for recency — `Workout` has no timestamp field). `exerciseCount` costs one `listWorkoutExercises` call per workout, not a full `/full` fetch.
- `GET /training-plans/:planId/workouts` → `Workout[]`
- **`POST /training-plans/:planId/workouts`** `{name, dayOfWeek, exercises?: WorkoutExerciseEntry[]}` (TRAINER) → `201` **`FullWorkout`** (same shape as `GET /workouts/:id/full`, so the web gets every new `WorkoutExercise`/`ExerciseSet` id right away). `exercises` is optional — omitted or `[]` creates an empty workout, exactly as before. Max 20 entries. Creation is all-or-nothing: on any 4xx nothing was created. Upstream RPC: `CreateWorkoutWithExercises`. Each `FullWorkoutExercise.exercise` in the response is the `Exercise` shape from the Exercises section (`muscleGroups`, `isStarter`; no `muscleGroup`).
  ```jsonc
  // WorkoutExerciseEntry — no `order`: list position is the order
  { "exerciseId": 12,                 // catalog exercise, must exist; the same id may repeat
    "restSecondsBetweenSets": 90,     // optional, default 0
    "notes": "",                      // optional, default ""
    "sets": [                         // optional, default []; max 10 — no `setNumber`: list position is the set number
      { "reps": 10, "durationSeconds": 0, "weight": "60.0", "loadPercentage": "",   // all optional; numbers default 0, decimals are strings ("" = unset)
        "strategy": "STRAIGHT",       // optional; omitted → vertice-api defaults to STRAIGHT
        "restSeconds": 90, "notes": "" } ] }
  ```
  Errors: Zod failures (missing `name`, >20 exercises, >10 sets, bad enum, negative number) → 400 `VALIDATION_ERROR` with field `details`; upstream rejections (cap, malformed decimal) → 400 `VALIDATION_ERROR` with a flat message that does not say which entry. For a TRAINER, every `exerciseId` must be visible to them (the shared starter set or their own exercise). The BFF looks each distinct id up through `GetExercise` before writing; another trainer's private exercise and a nonexistent id both get **400 `VALIDATION_ERROR`** `exerciseId <id> is not available to you`, so the answer does not reveal which. ADMIN skips this check.
- `GET /workouts/:id` → `Workout` = `{id, name, trainingPlanId, dayOfWeek}`
- **`GET /workouts/:id/full`** → `Workout & { exercises: FullWorkoutExercise[] }` — **the key aggregate for a workout-builder or read-only workout view.** Each `FullWorkoutExercise` = `WorkoutExercise & { exercise: Exercise, sets: ExerciseSet[] }`, sorted by `order`/`setNumber`. One call gets everything needed to render a workout. `FullWorkoutExercise.exercise` is the `Exercise` shape from the Exercises section (`muscleGroups`, `isStarter`; no `muscleGroup`). An ADMIN opening a workout that contains a trainer's private exercise gets **403 `FORBIDDEN`** `You do not have access to exercise <id>` for the whole aggregate (the embedded exercise lookup is refused upstream).
- `PATCH /workouts/:id` `{name, dayOfWeek}` (TRAINER)
- `DELETE /workouts/:id` (TRAINER)
- `POST /workouts/:id/clone` `{targetTrainingPlanId, name, dayOfWeek}` (TRAINER) → clones exercises+sets into a new workout, for "reuse a previous workout as a base"

`dayOfWeek`: `MONDAY..SUNDAY`

## Workout exercises
- `GET /workouts/:workoutId/exercises` → `WorkoutExercise[]`
- `POST /workouts/:workoutId/exercises` `{exerciseId, order, restSecondsBetweenSets, notes?}` (TRAINER). For a TRAINER, `exerciseId` must be visible to them (the shared starter set or their own exercise). The BFF looks it up through `GetExercise` before writing; another trainer's private exercise and a nonexistent id both get **400 `VALIDATION_ERROR`** `exerciseId <id> is not available to you`, so the answer does not reveal which. ADMIN skips this check.
- **`PUT /workouts/:workoutId/exercises`** `{exercises: WorkoutExerciseEntry[]}` (TRAINER) → `200` **`FullWorkout`** — replaces the workout's **entire** exercise/set tree with the given list (full replace, not merge; same entry shape as `POST /training-plans/:planId/workouts`, max 20). `exercises` is required — `[]` empties the workout, omitting it is a 400. Upstream deletes and recreates the tree, so **every `WorkoutExercise`/`ExerciseSet` id in the response is new**; any id held from before the call is invalid. Refused with **409 `PRECONDITION_FAILED`** once *any* set under the workout has recorded client data (not just sets the replace would drop) — from then on the workout can only be edited through the one-at-a-time endpoints on this page. All-or-nothing: on any 4xx nothing changed. Body `exerciseId`s are checked as for `POST /training-plans/:planId/workouts` (400 when not visible to the trainer). Upstream RPC: `ReplaceWorkoutExercises`. `FullWorkoutExercise.exercise` in the response is the `Exercise` shape from the Exercises section.
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
- **`GET /workouts/:workoutId/session?weekStartDate=YYYY-MM-DD`** (defaults to the current week's Monday) — CLIENT uses own id (any `clientId` is ignored); TRAINER and ADMIN must pass `?clientId=`, and for a TRAINER it must be the client of the workout's plan.
  - Errors: 400 `VALIDATION_ERROR` `clientId is required` / `Invalid clientId: <value>` (TRAINER, ADMIN); 403 `FORBIDDEN` `You do not have access to this training plan` (another trainer's or client's workout) or `That training plan does not belong to this client` (TRAINER, `clientId` is not the plan's client); 404 `NOT_FOUND` for an unknown workout.
  → `Workout & { exercises: [...FullWorkoutExercise, sets: [...ExerciseSet, lastPerformed: SetLog|null]] , workoutLog: WorkoutLog }`.
  Each `exercise` under `exercises[]` is the `Exercise` shape from the Exercises section (`muscleGroups`, `isStarter`; no `muscleGroup`).
  This auto-starts (or resumes) this week's log and merges in last time's recorded weight/reps per set (`lastPerformed`), so the UI can show "last time: 60kg × 12" inline. **This is the single call the workout-execution screen needs.**
- `POST /workout-sessions/:workoutLogId/sets` `{exerciseSetId, weight, reps}` (CLIENT) → records one set's actual performance
  - Errors: 403 `FORBIDDEN` `You do not have access to this workout log` (another client's log); 400 `VALIDATION_ERROR` `exerciseSetId does not belong to this workout log` when the set is not one of the log's workout's sets. A missing set gets the same 400, so the answer never tells "someone else's set" from "no such set". vertice-api enforces the same rule (409 `PRECONDITION_FAILED`); the BFF check answers first. 404 `NOT_FOUND` for an unknown log.
- `POST /workout-sessions/:workoutLogId/complete` (CLIENT) → marks the log done
  - Errors: 403 `FORBIDDEN` `You do not have access to this workout log`; 404 `NOT_FOUND` for an unknown log.
- `GET /workout-logs?trainingPlanId=&weekStartDate=&clientId=` — **`trainingPlanId` is required** by vertice-api (this RPC is scoped to one plan + one week, not a general history query). CLIENT uses own id; TRAINER and ADMIN must pass `clientId` (for a TRAINER, one of their clients). The plan must belong to that client and to the caller. Use this to render "which workouts are done this week."
  - Errors: 400 `VALIDATION_ERROR` `clientId is required` / `trainingPlanId is required` / `Invalid <param>: <value>`; 403 `FORBIDDEN` `This client is not one of your clients`, `You do not have access to this training plan` (another trainer's or client's plan) or `That training plan does not belong to this client`; 404 `NOT_FOUND` for an unknown plan.

`WorkoutLog` = `{id, workoutId, clientId, weekStartDate, startedAt, completedAt}` (`completedAt` is `""` until completed).

## Feedback
- `POST /workout-logs/:workoutLogId/feedback` `{text}` (CLIENT)
  - Errors: 403 `FORBIDDEN` `You do not have access to this workout log` (another client's log); 404 `NOT_FOUND` for an unknown log.
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
