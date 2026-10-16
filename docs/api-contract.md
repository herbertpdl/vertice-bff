# vertice-bff API contract

Base URL (dev): `http://localhost:3000/api`

**Machine-readable contract:** [`openapi.json`](./openapi.json) (OpenAPI 3.1), generated from the route schemas by `npm run openapi` and checked in CI. It has every route with its `operationId`, parameters, request and response schemas, error responses and security scheme (bearer), and is what vertice-web-react and vertice-mobile generate their TypeScript types from (`openapi-typescript`). This document is the prose around it; where the two disagree about a field, the spec is right. The route reference below is generated from it.

All endpoints except `/auth/login`, `/auth/register`, `/auth/password/setup` and `/legal/versions` require:
`Authorization: Bearer <token>`

The token is the one `/auth/login` or `/auth/register` returned. Treat it as opaque: it carries
only the user id and role (scoped `iss: vertice-bff`, `aud: vertice-api`, with an expiry), not the
name or email. Read those from the login/register response or `GET /auth/me`. A token issued
before the scoping change, or by anything other than this BFF, gets a `401` (log in again).

All error responses have the shape:
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": {} } }
```
Common codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED`/`UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `PRECONDITION_FAILED` (409), `TOO_LARGE` (413), `RATE_LIMITED` (429, with a `Retry-After` header in seconds), `UPSTREAM_ERROR` (502), `UPSTREAM_UNAVAILABLE` (503).

**Key on `code`, not on `message`.** Messages are English and meant for logs and debugging. When vertice-api refuses a call, the BFF relays vertice-api's own text only for `INVALID_ARGUMENT`, as a 400 `VALIDATION_ERROR` whose `message` is the field error (`name: must not be blank`). Every other upstream refusal gets a fixed message, and the upstream text goes to the BFF's log only, with emails and CPFs redacted:

| Upstream gRPC status | HTTP | `code` | `message` |
|---|---|---|---|
| `INVALID_ARGUMENT` | 400 | `VALIDATION_ERROR` | vertice-api's field error, as is |
| `NOT_FOUND` | 404 | `NOT_FOUND` | `Resource not found` |
| `PERMISSION_DENIED` | 403 | `FORBIDDEN` | `You do not have access to this resource` |
| `FAILED_PRECONDITION` | 409 | `PRECONDITION_FAILED` | `The resource's current state does not allow this request` |
| `ALREADY_EXISTS` | 409 | `CONFLICT` | `Email or CPF already in use` (the same for both, so it never says which one is taken) |
| `UNAUTHENTICATED` | 401 | `UNAUTHENTICATED` | `Session no longer valid` |
| `UNAVAILABLE` | 503 | `UPSTREAM_UNAVAILABLE` | `vertice-api is unavailable` |
| `RESOURCE_EXHAUSTED` | 413 | `TOO_LARGE` | `The requested data is too large to return` (today only `GET /auth/me/export` over vertice-api's export bounds) |
| anything else (`UNKNOWN`, `INTERNAL`, ...) | 502 | `UPSTREAM_ERROR` | `Upstream error` |

`details` is only set on the BFF's own validation errors (Zod field errors and the like), never from upstream. For a Zod failure it is Zod's flattened form, `{ "formErrors": string[], "fieldErrors": { "<field>": string[] } }`; the field names are the contract, the English text of each message is not (Zod 4 words them differently from Zod 3, e.g. `Invalid input: expected string, received undefined` instead of `Required`). The BFF's own refusals (`Requires role: TRAINER`, `This client is not one of your clients`, ...) keep their specific messages.

`PRECONDITION_FAILED` (409) means the request was well-formed but the resource's current state forbids it — emitted by `PUT /workouts/:workoutId/exercises`, when a client has already recorded data under the workout; by `DELETE /exercises/:id`, while any workout uses the exercise; and by the deletes that would remove a client's history (vertice-api's `HasRecordedDataException`, P1-05): `DELETE /training-plans/:id` once any of its workouts has a workout log, `DELETE /workouts/:id` once it has a workout log, `DELETE /workout-exercises/:id` and `DELETE /exercise-sets/:id` once a set has a set log. A started session counts even with nothing recorded. The message is the fixed one above; the web shows its own copy on that code (e.g. "já tem treinos registrados e não pode ser excluído"). Distinct from `VALIDATION_ERROR` ("fix the payload").

**Headers.** Every response carries API security headers (`@fastify/helmet`): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none';frame-ancestors 'none'` (the BFF serves no HTML), `Strict-Transport-Security`, `Referrer-Policy: no-referrer` and helmet's other defaults. Every `/api/*` response, errors included, is `Cache-Control: no-store`, except a successful `GET /legal/versions` (public, no personal data: `Cache-Control: public, max-age=300`).

Roles: `TRAINER`, `CLIENT`, `ADMIN`. Most write endpoints require `TRAINER`. Every id a route accepts (path, query or body) is checked against the caller: a `CLIENT` only reaches their own plans, workouts and workout logs; a `TRAINER` only their own plans and their own clients (`TrainerClientService.IsTrainersClient`). Another user's id is **403 `FORBIDDEN`**. A `CLIENT`'s `clientId` query parameter is ignored and replaced with their own id. `src/test/route-authorization.test.ts` pins this per route.

**`ADMIN` has no defined product yet** (no PRD; audit QUAL-BFF-001, plan item P1-02). Until one exists, an ADMIN keeps only what is generic: their own account and the exercise catalog reads. Every trainer- or client-scoped route answers an ADMIN with **403 `FORBIDDEN` `Requires role: …`** before any upstream call; there is no ADMIN bypass in the BFF's ownership checks. (vertice-api still lets ADMIN through on most RPCs; the BFF is just narrower.) Giving ADMIN a feature needs a short PRD first, then explicit routes.

Which roles each route admits is the `Access` column of the route reference below. It is generated from the route declarations, and `src/test/route-authorization.test.ts` pins it to what the routes actually enforce. Notes: `GET /exercises` also admits ADMIN, who sees the starter set; `GET /exercises/:id` is open to any role and vertice-api decides visibility; everything scoped to a trainer or a client is checked against the caller's own data on top of the role.

<!-- BEGIN GENERATED ROUTE REFERENCE (npm run openapi) -->
<!-- Generated from the routes by `npm run openapi`; CI fails when it is stale. Do not edit by hand. -->

Paths are absolute, `/api` included (the dev server is `http://localhost:3000`). The full request and response schemas,
with the error responses of each operation, are in [`openapi.json`](./openapi.json) (OpenAPI 3.1).

### Auth

Login, registration, passwords and the caller’s own account (`/auth/me`, LGPD data-subject rights).

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| POST | `/api/auth/login` | public | `login` | Log in |
| POST | `/api/auth/register` | public | `register` | Register a trainer |
| GET | `/api/auth/me` | any role | `getMe` | The caller’s own account |
| PATCH | `/api/auth/me` | any role | `updateMe` | Correct the caller’s own profile |
| DELETE | `/api/auth/me` | any role | `deleteMe` | Delete the caller’s own account |
| GET | `/api/auth/me/export` | any role | `exportMyData` | Download the caller’s data |
| POST | `/api/auth/me/consent` | any role | `recordConsent` | Record the caller’s consent to a legal text |
| POST | `/api/auth/password` | any role | `changePassword` | Change the caller’s password |
| POST | `/api/auth/password/setup` | public | `setupPassword` | Choose a password with a first-access token |

### Legal

Versions of the legal texts, for the consent flow.

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| GET | `/api/legal/versions` | public | `getLegalVersions` | Current versions of the legal texts |

### Clients

A trainer’s roster of clients (TRAINER only).

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| GET | `/api/clients` | TRAINER | `listClients` | The trainer’s roster |
| POST | `/api/clients` | TRAINER | `createClient` | Create a client |
| GET | `/api/clients/{id}` | TRAINER | `getClient` | A client’s details |
| PATCH | `/api/clients/{id}` | TRAINER | `updateClient` | Update a client |
| DELETE | `/api/clients/{id}` | TRAINER | `endClientRelationship` | End the relationship with a client |
| GET | `/api/clients/{id}/overview` | TRAINER | `getClientOverview` | The header of a client’s detail screen |
| POST | `/api/clients/{id}/setup-token` | TRAINER | `reissueClientSetupToken` | Re-issue a client’s first-access link |

### Exercises

The exercise catalog (shared starter set plus each trainer’s own) and muscle groups.

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| GET | `/api/exercises` | TRAINER, ADMIN | `listExercises` | List the exercise catalog |
| POST | `/api/exercises` | TRAINER | `createExercise` | Create an exercise |
| GET | `/api/exercises/{id}` | any role | `getExercise` | One exercise |
| PATCH | `/api/exercises/{id}` | TRAINER | `updateExercise` | Replace an exercise |
| DELETE | `/api/exercises/{id}` | TRAINER | `deleteExercise` | Delete an exercise |
| GET | `/api/exercises/{id}/progress` | TRAINER, CLIENT | `getExerciseProgress` | Weight over time for one exercise |
| GET | `/api/muscle-groups` | any role | `listMuscleGroups` | List the muscle groups |

### Training plans

A plan is one trainer’s and one client’s.

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| GET | `/api/training-plans` | TRAINER, CLIENT | `listTrainingPlans` | List training plans |
| POST | `/api/training-plans` | TRAINER | `createTrainingPlan` | Create a training plan |
| GET | `/api/training-plans/{id}` | TRAINER, CLIENT | `getTrainingPlan` | A training plan with its workouts |
| PATCH | `/api/training-plans/{id}` | TRAINER | `updateTrainingPlan` | Update a training plan |
| DELETE | `/api/training-plans/{id}` | TRAINER | `deleteTrainingPlan` | Delete a training plan |

### Workouts

Workouts of a plan, including the full aggregate (`/full`) and cloning.

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| GET | `/api/training-plans/{planId}/workouts` | TRAINER, CLIENT | `listPlanWorkouts` | The workouts of a plan |
| POST | `/api/training-plans/{planId}/workouts` | TRAINER | `createWorkout` | Create a workout, with its exercises and sets |
| GET | `/api/workouts` | TRAINER | `listRecentWorkouts` | The trainer’s workouts across every plan |
| GET | `/api/workouts/{id}` | TRAINER, CLIENT | `getWorkout` | One workout |
| PATCH | `/api/workouts/{id}` | TRAINER | `updateWorkout` | Rename a workout or move it to another day |
| DELETE | `/api/workouts/{id}` | TRAINER | `deleteWorkout` | Delete a workout |
| GET | `/api/workouts/{id}/full` | TRAINER, CLIENT | `getFullWorkout` | A workout with its exercises and sets |
| POST | `/api/workouts/{id}/clone` | TRAINER | `cloneWorkout` | Clone a workout into a plan |

### Workout exercises

The exercises of a workout.

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| GET | `/api/workouts/{workoutId}/exercises` | TRAINER, CLIENT | `listWorkoutExercises` | The exercises of a workout |
| POST | `/api/workouts/{workoutId}/exercises` | TRAINER | `addWorkoutExercise` | Add an exercise to a workout |
| PUT | `/api/workouts/{workoutId}/exercises` | TRAINER | `replaceWorkoutExercises` | Replace the whole exercise and set tree of a workout |
| PATCH | `/api/workout-exercises/{id}` | TRAINER | `updateWorkoutExercise` | Update a workout exercise |
| DELETE | `/api/workout-exercises/{id}` | TRAINER | `deleteWorkoutExercise` | Remove an exercise from a workout |

### Exercise sets

The sets of a workout exercise.

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| GET | `/api/workout-exercises/{workoutExerciseId}/sets` | TRAINER, CLIENT | `listExerciseSets` | The sets of a workout exercise |
| POST | `/api/workout-exercises/{workoutExerciseId}/sets` | TRAINER | `createExerciseSet` | Add a set to a workout exercise |
| PATCH | `/api/exercise-sets/{id}` | TRAINER | `updateExerciseSet` | Update a set |
| DELETE | `/api/exercise-sets/{id}` | TRAINER | `deleteExerciseSet` | Delete a set |

### Workout sessions

The client’s “do a workout” flow: the session aggregate, set logs and workout logs.

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| GET | `/api/workouts/{workoutId}/session` | TRAINER, CLIENT | `getWorkoutSession` | The “do a workout” screen in one call |
| GET | `/api/workout-logs` | TRAINER, CLIENT | `listWorkoutLogs` | Which workouts were done in a week |
| POST | `/api/workout-sessions/{workoutLogId}/sets` | CLIENT | `recordSetLog` | Record one set’s actual performance |
| POST | `/api/workout-sessions/{workoutLogId}/complete` | CLIENT | `completeWorkoutLog` | Mark a workout log done |

### Feedback

Client feedback on a workout log, read by the trainer.

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| POST | `/api/workout-logs/{workoutLogId}/feedback` | CLIENT | `submitWorkoutFeedback` | Send feedback on a workout log |
| GET | `/api/feedback` | TRAINER | `listFeedback` | The trainer’s feedback, newest first |

### Dashboard

The trainer’s landing page in one call.

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| GET | `/api/dashboard` | TRAINER | `getDashboard` | The trainer dashboard |

### Health

Liveness.

| Method | Path | Access | `operationId` | Summary |
|---|---|---|---|---|
| GET | `/health` | public | `getHealth` | Liveness |

<!-- END GENERATED ROUTE REFERENCE -->

## Dates and times

**The business time zone is `America/Sao_Paulo`.** The rule is vertice-api's, stated in its
[`README.md`](https://github.com/herbertpdl/vertice-api/blob/main/README.md) ("Dates and times") and
[`CLAUDE.md`](https://github.com/herbertpdl/vertice-api/blob/main/CLAUDE.md) ("Time: instants vs.
business dates"), which are the source of truth; this section is the same rule as the BFF's HTTP
surface presents it. Every date-ish field here is one of exactly two kinds, and a client must treat
them differently:

| Kind | Over the wire | Meaning | Examples |
| --- | --- | --- | --- |
| **Instant** | ISO-8601 with the `Z` designator, e.g. `2026-10-17T01:00:00Z` | An absolute point in time. Format it for display in a time zone — never read the clock or the calendar day off the string. | `startedAt`, `completedAt`, `recordedAt`, `createdAt`, `expiresAt`, `lastWorkoutAt`, the consent timestamps, `completedToday[].completedAt` |
| **Business date** | `yyyy-MM-dd`, e.g. `2026-10-31` | A local calendar day in `America/Sao_Paulo`. No time, no zone. | a plan's `startDate`/`endDate`, a log's `weekStartDate`, `expiringPlans[].end`, `weekActivity[].date`, the export filename's date |

Instants are relayed from vertice-api verbatim, in UTC. There is no third kind: no field is a bare
local time, and none carries a fixed `-03:00`.

What a client must do:

- **Format an instant in a zone, with `Intl`.** `Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })`,
  not `completedAt.slice(11, 16)`. Slicing the string reads the UTC wall clock, so an evening
  workout displays about three hours early (audit REL-API-008).
- **Never put a business date through a UTC conversion.** `new Date("2026-10-31")` is UTC midnight,
  which renders as 30/10/2026 in Brazil. Parse the three parts, or parse it as local midnight.
- **Derive "today" and a week start in `America/Sao_Paulo`**, never from
  `new Date().toISOString().slice(0, 10)` — that is the UTC day, so it flips at 21:00 local and put
  Sunday-evening workouts into next week's log (audit XREPO-006).
- **Don't assume a fixed −03:00 offset.** Brazil observed DST until 2019, so instants from before
  then were recorded at −02:00. Use the zone, not an offset.

What the BFF does, so a client doesn't have to:

- Every "today" and "this week" the BFF computes is the business day and the business week —
  `GET /dashboard` (which plans are active, which are expiring, which completions are today's),
  `GET /clients` (the current plan, the Monday–Friday activity strip), `GET /clients/:id/overview`
  (the active plan, this week's count, the 4-week adherence lookback), the `weekStartDate` default
  on `GET /workouts/:workoutId/session` and `GET /workout-logs`, and the date in
  `GET /auth/me/export`'s filename. All of it is `src/lib/dates.ts`.
- `daysLeft` on `GET /dashboard` counts whole calendar days between two business dates, so a plan
  ending today is `0` all day rather than turning negative during the afternoon.
- The BFF's correctness does not depend on its host's `TZ`, and must not come to: `npm run test:hostile-tz`
  runs the whole suite a second time under `TZ=Pacific/Kiritimati` (UTC+14), and CI runs it. The
  contract itself is `src/lib/dates.test.ts`, the counterpart of vertice-api's
  `BusinessTimeZoneIntegrationTest`.
- Historic rows keep whatever key they were written with: logs keyed by a UTC-derived week are left
  alone, and the rule applies going forward (plan item P2-02).

## Input bounds

Every request body and query string is parsed with Zod before any upstream call; a violation is `400 VALIDATION_ERROR` with field `details`. The rules mirror vertice-api's (its PR #70 is the table of record; vertice-api stays authoritative), and string lengths count UTF-16 code units, like JavaScript's `.length`. "Not blank" means `trim().length > 0`, and the stored text is trimmed.

| Input | Rule |
|---|---|
| user `name`, plan `name`, workout `name`, exercise `name` | not blank, ≤ 255 |
| `email` | trimmed, lower-cased, valid, ≤ 255 (also on `PATCH /clients/:id`) |
| `password` (register, setup, change) | ≥ 8 characters, ≤ 72 UTF-8 bytes, not blank. **Login and the current-password re-check** only need 1..1000 characters (no policy, uniform 401) |
| `cpf` | register: required. Clients (create, PATCH) and `PATCH /me`: optional. When set: exactly 11 digits, no punctuation, valid check digits; `""` means none |
| `cref` | ≤ 20 |
| plan `description`, exercise `description`, notes (workout exercise, set) | ≤ 255 |
| `videoUrl` | `""` or `^https?://\S+$`, ≤ 500 (`javascript:`, `data:`, `ftp:` are refused) |
| feedback `text` | not blank, ≤ 2000 |
| plan `startDate`, `endDate`, `weekStartDate` | an existing `YYYY-MM-DD` date; `endDate` ≥ `startDate` |
| `order`, `setNumber` | integer 1..1000 |
| `reps` | integer 0..1000 |
| `durationSeconds` | integer 0..86400 |
| `restSeconds`, `restSecondsBetweenSets` | integer 0..3600 |
| `weight` | `^\d{1,4}(\.\d{1,2})?$` (`""` = unset on a set; required on a set log) |
| `loadPercentage` | `^\d{1,3}(\.\d{1,2})?$` (`""` = unset) |
| exercises per workout / sets per exercise | ≤ 20 / ≤ 10 in the nested bodies (`POST /training-plans/:planId/workouts`, `PUT /workouts/:workoutId/exercises`). The per-item creates are capped by vertice-api, which answers `400 VALIDATION_ERROR` `exercises: must not exceed 20 entries` / `sets: must not exceed 10 entries` |
| feedback entries per workout log | ≤ 10, enforced by vertice-api |
| query ids (`clientId`, `trainingPlanId`) | positive integers; a malformed one is a 400 (a CLIENT's `clientId` is still ignored once it parses) |

## Rate limits
- **Global:** every route shares a loose per-IP bucket (default 300 requests per minute; `RATE_LIMIT_GLOBAL_MAX`/`RATE_LIMIT_GLOBAL_WINDOW_MS`).
- **Auth (strict):** separate buckets per route, per IP and (where the body has one) per email, default 5 per 15 minutes (`AUTH_RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_WINDOW_MS`). Once a bucket is full the next request is `429 RATE_LIMITED`, whatever its credentials, until the window ends.
  - `POST /auth/login` (IP + email) and `POST /auth/password/setup` (IP) count **failed** attempts only: a response below 400 gives the attempt back, so the 6th failure in 15 minutes is a 429 and a gym full of clients on one IP can still log in.
  - `POST /auth/register` (IP + email) counts **every** attempt: a successful sign-up is what a spammer repeats.
  - `POST /auth/password` and `DELETE /auth/me` (IP + user, separate buckets) count failed attempts.
- **Data export:** `GET /auth/me/export` has its own per-user bucket, default **3 per hour**, counting **every** export (`EXPORT_RATE_LIMIT_MAX`/`EXPORT_RATE_LIMIT_WINDOW_MS`); the 4th is `429 RATE_LIMITED` with `Retry-After`. It is keyed on the user, not the IP, so changing networks doesn't reset it.
  - A 5xx (upstream down) never counts.
- Per-IP means the client's address (IPv6 by /64). vertice-web-react calls the BFF from its server, so it **must forward the browser's IP as `X-Forwarded-For`**, and the BFF must run with `TRUST_PROXY` set to the web server's address; otherwise every web user shares one bucket. `X-Forwarded-For` from any other peer is ignored. See `docs/specs/password-lifecycle/spec.md`, "Client IPs and the rate limits".
- Per-IP keys are aggregated too: each route also has a bucket per client **network** (IPv6 /48, IPv4 /24, default 20 × the per-IP limit = 100 failures per 15 minutes), so rotating addresses within one network doesn't buy more attempts.
- Shared networks: the network bucket is shared by everyone behind the same IPv4 /24 or IPv6 /48 — carrier-grade NAT, an office or university network, a mobile carrier's /48. One abuser on that network can use it up (about 100 failures in 15 minutes by default) and lock everyone else on it out of that route for the rest of the window, even with correct passwords. Raise `AUTH_RATE_LIMIT_NETWORK_MAX` if many users sit behind shared networks. The long-term fix is a shared store plus a CAPTCHA or proof-of-work step instead of a hard network limit.
- Counters live in the BFF process (one instance today). Keys are fixed-size (normalized IPs, SHA-256 of the email; a malformed email gets no email bucket, a non-IP gets one shared `invalid` bucket), at most `AUTH_RATE_LIMIT_MAX_KEYS` of them (default 1M, ~230 MB). When full, a request that needs a new key gets `429 RATE_LIMITED` until older buckets expire (fail closed); clients already tracked are unaffected. Residual risk: once the cap is reached, clients the limiter isn't already tracking get 429 until windows expire. Reaching it takes many distinct networks: each IPv6 /48 or IPv4 /24 can mint only about `2 × AUTH_RATE_LIMIT_NETWORK_MAX` keys per route per window, but keys from consecutive windows overlap, so it can hold about `4 × AUTH_RATE_LIMIT_NETWORK_MAX` (≈400 by default; 399 measured). Filling 1M keys therefore needs roughly 2,500 distinct /48s (or /24s) failing at full rate on one route, or about 625 spread over all four strict routes. That is within reach of a large botnet or a cheap pool of IPv6 allocations; the remedies then are a shared store, a CAPTCHA/proof-of-work step, or blocking at the edge.

---

## Auth — `/auth`
Passwords follow vertice-api's policy everywhere one is set: **at least 8 characters, at most 72 UTF-8 bytes, not blank**. A violation is `400 VALIDATION_ERROR`, checked in the BFF before any upstream call. Emails are trimmed and lower-cased.

- `POST /login` `{email, password}` → `{token, user: {id,name,email,role}}`. The password is checked by vertice-api (`VerifyCredentials`). A wrong password, an unknown email and an account with no password yet all get the **same** `401 {"error":{"code":"UNAUTHORIZED","message":"Invalid email or password"}}`.
  - Rollout flag: with `VERIFY_PASSWORDS=false` (development/test only; the BFF refuses to start with it anywhere else) login only checks that the email exists, the old MVP behaviour. Default is `true`.
- `POST /register` `{name, email, password, role: "TRAINER", cpf, cref?, acceptedTermsVersion}` → `201`, same shape as login. **Only `TRAINER`**: `role: "CLIENT"` is `400 VALIDATION_ERROR` (clients are created by their trainer, `POST /clients`). **`cpf` is required for a trainer** (vertice-api rejects an empty or invalid one; it is optional only for a CLIENT). `cref` is optional (trainer license number). **`acceptedTermsVersion`** (P1-04): the version of the Terms of Use / Privacy Policy the user accepted on the form, normally `terms` from `GET /legal/versions`. Format: 1 to 32 of `[A-Za-z0-9._-]` (vertice-api's); malformed is `400 VALIDATION_ERROR` before any upstream call. Any well-formed version is accepted, not only the current one. vertice-api stores it with its own timestamp. **Required**: missing is `400 VALIDATION_ERROR` before any upstream call, so no account is created without an acceptance on record. A taken email or CPF is `409 CONFLICT` `Email or CPF already in use`, the same body for both.
Every `/me` route is **self only by construction**: the user is the token's, and no id in the path, query or body is read. Any role, ADMIN included (it is the caller's own account).

- `GET /me` (auth) → `Me` = `{id, name, email, cpf, cref, role, consent}`: the caller's own account. **`cpf` is masked** (`***.***.***-25`, `""` when none), with no reveal: the profile screen shows that a CPF is on file, and the user corrects it by typing the full new one in `PATCH /me`. The full value is in their export (`GET /me/export`). `cref` is `""` for anyone but a trainer who set one. `consent` is the caller's `Consent` (below), from vertice-api's self view.
- `PATCH /me` (auth) `{name?, email?, cpf?, cref?}` → `200` `Me`. The caller corrects their own profile (LGPD art. 18 III) through `UpdateUser` with their own token. Every field is optional and **an omitted field keeps the stored value** (vertice-api's `UpdateUser` replaces every field, so the BFF reads the self view and sends the rest back). The **role can't change**: a `role` in the body is ignored and the stored role is sent.
  - `cpf`: a string sets it (validated `400` and unique `409` upstream); `null` (or `""`) removes it, which only a non-trainer may do: **a TRAINER's CPF is required**, so removing it is `400 VALIDATION_ERROR` `cpf: required for a trainer` with no `UpdateUser` call. A masked value (anything with `*`, e.g. what `GET /me` returns) is `400 VALIDATION_ERROR`, nothing is sent; forms must omit `cpf` unless the user typed a new one.
  - `cref`: a TRAINER's only (a non-empty `cref` from anyone else is `400 VALIDATION_ERROR`); `null` clears it.
  - `email`: trimmed and lower-cased. **No verification yet**: the new address is used as is, and it is the login from then on (a verification flow is a P1-06 follow-up). A taken email or CPF is `409 CONFLICT` `Email or CPF already in use`.
  - Logged as `audit: "account.update"` with the actor's id and the names of the fields sent, never their values.
- `DELETE /me` (auth) `{password}` → `204`, no body. Deletes the caller's own account (LGPD art. 18 VI, vertice-api's `DeleteAccount`): their workout feedback, set logs, workout logs and the plans written for them are deleted, their relationships end, and the user row is anonymised (plans a trainer wrote for others stay with those clients). **Every token of the account stops working** (`401 UNAUTHENTICATED` on the next call): on the 204 the web clears its session cookie and leaves the app.
  - **Re-authentication:** `password` is the caller's current password, re-checked with `VerifyCredentials` before anything is deleted, so a stolen session alone can't delete the account. Missing or empty is `400 VALIDATION_ERROR` (send `Content-Type: application/json` with the body); a wrong one is **`400 INVALID_CURRENT_PASSWORD`** (not a 401: the session is still valid). Rate-limited like `POST /password` (IP + user, failures only).
  - A TRAINER who still has active clients is **`409 ACTIVE_CLIENTS`** `End your client relationships before deleting your account`: end each with `DELETE /clients/:id` first.
  - Logged as `audit: "account.delete"` with the actor's id.
- `GET /me/export` (auth) → `200` the caller's data as a **JSON file download** (LGPD art. 18 II and V): `Content-Type: application/json; charset=utf-8`, `Content-Disposition: attachment; filename="vertice-dados-YYYY-MM-DD.json"` (the UTC date), `Cache-Control: no-store`. The body is vertice-api's `ExportUserData` document as is: top-level `formatVersion`, `exportedAt`, `profile` (CPF and CREF in full: it is their own copy), `consent`, `relationships`, `plans`, `workoutLogs`, `exercises`; never a credential. An account over vertice-api's export bounds (20 000 rows per section, 3 MB) is **`413 TOO_LARGE`** `The requested data is too large to return` rather than a truncated file. **3 per hour per user** (see Rate limits). Logged as `audit: "account.export"`.
- `POST /me/consent` (auth, any role) `{type: "TERMS" | "HEALTH_DATA", version}` → `200` `Consent`, the caller's state after the change. **Self only**: there is no user id in the request; vertice-api's `RecordConsent` records it for the token's user and stamps the time. `TERMS` is the Terms of Use / Privacy Policy (an existing user re-accepting a new version), `HEALTH_DATA` the consent to processing health-related data (loads, session logs, feedback; LGPD art. 11, I). A later call replaces the earlier record of that type. `version` has the same format as `acceptedTermsVersion`; an unknown `type` or a malformed version is `400 VALIDATION_ERROR` before any upstream call.

```ts
Consent = {
  termsVersion: string | null,        // Terms / Privacy Policy version accepted, null if never
  termsAcceptedAt: string | null,     // ISO-8601 instant
  healthDataVersion: string | null,   // health-data notice version consented to, null if never
  healthDataConsentAt: string | null, // ISO-8601 instant
}
```
The web compares `termsVersion` / `healthDataVersion` with `GET /legal/versions`: null or different means "show the text and ask" (first access, or the text changed). Users created before P1-04, and every trainer-created client, start with all four null.
- `POST /password` (auth, any role) `{currentPassword, newPassword}` → `204`. Changes the caller's own password after re-checking the current one. A wrong `currentPassword` is **`400 INVALID_CURRENT_PASSWORD`**, not a 401: the session is still valid, so clients must not log out on it.
- `POST /password/setup` (public) `{token, newPassword}` → `204`. First access: the client chooses a password with the setup token from `POST /clients` (or `POST /clients/:id/setup-token`), then logs in normally. An unknown, expired (72h) or already used token is **`400 INVALID_SETUP_TOKEN`** (vertice-api's `UNAUTHENTICATED`, mapped so clients don't read it as a logout). The token is single-use, and issuing a new one invalidates the previous one.

## Legal — `/legal`
- `GET /versions` (public) → `{terms, healthData}`: the current version of the Terms of Use / Privacy Policy and of the health-data consent notice (env `TERMS_VERSION`, `HEALTH_DATA_CONSENT_VERSION`, default `2026-10-draft`; the texts are drafts pending legal review). The web shows the matching texts, sends `terms` as `acceptedTermsVersion` on register and the versions to `POST /auth/me/consent`, and compares them with `GET /auth/me`'s `consent` to tell whether a stored consent is outdated. No upstream call. Cacheable: `Cache-Control: public, max-age=300` (errors stay `no-store`). A version changes only on a BFF deploy that bumps the env var.

## Clients — `/clients` (TRAINER only)
A trainer's roster = the clients with an active trainer–client relationship, from vertice-api's `TrainerClientService` (a `User` has no direct trainer link, and the roster is not derived from training plans). A client the trainer just created (`POST /`) is on the roster right away, with `currentPlan: null` until a plan exists. Ending the relationship (`DELETE /:id`) takes the client off it.
**CPF.** No list carries a CPF. The detail shapes (`ClientDetail`, below) carry it **masked**, `***.***.***-25` (only the two check digits; `""` when the client has none), except `GET /:id?reveal=cpf`.

`ClientDetail` = `{id, name, email, cpf, role}` (`cpf` masked; no `cref`).

- **`GET /`** → `ClientSummary[]` = `{id, name, activePlanCount, currentPlan, lastWorkoutAt, weekActivity}`, for the roster/list screen. **No `email`, `cpf`, `cref` or `role`** (P1-03); the detail routes carry the email.
  - `currentPlan`: `{id, name, endDate} | null` — the student's date-active training plan (`startDate <= today <= endDate`) among the trainer's plans for them; `null` if none is currently active (shown as a "Sem plano" tag in the UI). If more than one plan is active at once, the most recently started one is returned.
  - `lastWorkoutAt`: ISO timestamp of the student's most recent *completed* workout log, or `null`. **Scoped to the current week only** — see limitation note below.
  - `weekActivity`: `{date, dayOfWeek, completed}[]`, always 5 entries for Monday–Friday of the current week, `completed` true if a workout log finished on that calendar date. Powers the 5-dot weekly-activity indicator.

  Limitation: vertice-api's `ListWorkoutLogs` RPC is scoped to one `trainingPlanId` + one `weekStartDate` at a time (no general "this client's workout history" query), so — mirroring the dashboard module's `completedToday` logic — `lastWorkoutAt`/`weekActivity` only reflect the *current* week's logs across all of the trainer's plans for that client. A student whose last completed workout falls in an earlier week shows `lastWorkoutAt: null` and an all-empty week strip here, rather than a stale older date.
- `GET /:id` → `ClientDetail` with the CPF masked (403 if not one of your clients).
  - `GET /:id?reveal=cpf` → the same, with the CPF in full. TRAINER only, through the same "one of your clients" check (an ADMIN or CLIENT gets 403 by role, another trainer's client 403). Every reveal is logged (`audit: "client.cpf.reveal"`, the trainer's id and the client's id, never the value). Any other query (`reveal=email`, a repeated `reveal`, an unknown key) is `400 VALIDATION_ERROR`.
- **`GET /:id/overview`** → aggregation for the student-detail header (active plan, this-week progress, last workout, adherence). One call instead of orchestrating training-plans + workouts + workout-logs from the frontend:
  ```json
  {
    "student": { "...ClientDetail, cpf masked" },
    "activePlan": { "id": 0, "name": "", "level": "BEGINNER", "startDate": "", "endDate": "" } | null,
    "thisWeek": { "completed": 0, "total": 0 },
    "lastWorkoutAt": "2026-08-26T16:52:17.169082Z" | null,
    "adherence4Weeks": 0 | null
  }
  ```
  `activePlan` is the plan whose `[startDate, endDate]` contains today (most recently started one wins if more than one overlaps); everything else is zeroed/null when the student has no active plan. `thisWeek` counts completed vs. total workouts in the active plan for the current ISO week. `adherence4Weeks` is an **approximation**: vertice-api's `ListWorkoutLogs` RPC is scoped to one plan + one week (no general history query), so this re-fetches logs for the last 4 Mondays (clamped to weeks on/after the plan's start date), treats the plan's workout list as the recurring weekly schedule, and computes `completed / (workoutsPerWeek × weeksElapsed) × 100`, capped at 100. `lastWorkoutAt` is the latest `completedAt` found in that same 4-week lookback window (not a true all-time last-workout value — there's no cheaper way to get that from the current API surface).
- `POST /` `{name, email, cpf?}` → `201` `ClientDetail & {setup}` (CPF masked). **`cpf` is optional** for a client (vertice-api #65, data minimisation, pending legal review): omitted or `""` creates the client without one (stored as NULL, `cpf: ""` in responses); a CPF that is set must be valid (400) and unique (409); a masked value (anything with `*`) is `400 VALIDATION_ERROR` and never sent — creates a CLIENT user **without a password** and issues a first-access token. A `password` in the body is ignored (never sent upstream): the client chooses their own.
  ```json
  {
    "id": 42, "name": "Ana", "email": "ana@example.com", "cpf": "***.***.***-25", "role": "CLIENT",
    "setup": { "token": "<43-char base64url>", "expiresAt": "2026-10-16T18:00:00Z" } | null
  }
  ```
  The web builds the link the trainer shares from the token: `/definir-senha?token=<token>` (the page posts it to `POST /auth/password/setup`). The token is shown once (vertice-api only stores its hash) and expires after 72h. There is no email delivery yet. `setup` is `null` only when the client was created but issuing the token failed; re-issue it with the route below rather than re-creating the client (that would be a 409 `CONFLICT`).
- `POST /:id/setup-token` (**TRAINER only**, one of your clients) → `201` `{token, expiresAt}`. Re-issues the first-access link; the previous one stops working. Only while the client has no password yet: once they set one it is **`409 PRECONDITION_FAILED`**, since a trainer-issued link would let the trainer reset the client's password. (Clients created before setup tokens existed have a random password, so they get their link from ops: `npm run ops:issue-setup-tokens`, see the README.) Errors: 403 `Requires role: TRAINER` (ADMIN, CLIENT); 403 `This client is not one of your clients`.
- `PATCH /:id` `{name, email, cpf?}` → `ClientDetail` (CPF masked). `name` and `email` are required. `cpf`:
  - **omitted: keeps the stored CPF.** vertice-api's `UpdateUser` replaces every field, so the BFF reads the stored CPF (`GetUser`, the active trainer's detail view) and sends it back;
  - a string: the new CPF (`""` also removes it), validated (400) and unique (409) upstream;
  - `null`: removes the CPF (stored as NULL, `cpf: ""` in the response). Clients only, which every `/clients` user is;
  - a masked value (anything with `*`, e.g. the `***.***.***-25` this API returns): `400 VALIDATION_ERROR`, nothing is sent. Edit forms must not echo the detail's `cpf` back; omit the field unless the trainer typed a new one.

  A taken email or CPF is `409 CONFLICT` `Email or CPF already in use`.
- `DELETE /:id` → `204`, no body. **Ends the trainer's relationship with the client** ("Encerrar acompanhamento", vertice-api's `EndTrainerClientRelationship`, which sets `ended_at`); it **does not delete the client's account**. The client drops off `GET /` and the trainer loses what the active link grants (`GET /:id`, the overview, progress, setup links, new plans for them, editing their plans' dates); the plans the trainer wrote, and the logs under them, stay readable to both. The client is free to be linked to another trainer. Deleting an account is only ever the user's own action (`DELETE /auth/me`). Errors: 403 `This client is not one of your clients` (another trainer's client, or one whose relationship already ended); upstream refusals as in the table above.

### What vertice-web-react must change (P1-03, web step)
The detail page renders whatever `cpf` string it gets (now the mask). The web PR must:
1. **Roster** (`src/app/(app)/alunos/AlunosContent.tsx`, done in vertice-web-react #45): no email under the name, search by name only, and `GET /clients` typed `ClientSummary` (`{id, name, activePlanCount, currentPlan, lastWorkoutAt, weekActivity}`, `src/lib/api/types.ts`), so nothing reads `email`/`cpf`/`cref`/`role` from it. With that live, the BFF dropped `email` from `GET /clients`, and vertice-api moves `ListClientsForTrainer` to its summary view.
2. **Student detail** (`src/app/(app)/alunos/[studentId]/StudentDetailContent.tsx`): `overview.student.cpf` is now masked (`***.***.***-25`). Show it as is, with a "mostrar" toggle that fetches `GET /clients/:id?reveal=cpf` (`fetchStudent(id, { revealCpf: true })` in `src/lib/api/students.ts`) and shows that response's `cpf`. Don't cache the revealed CPF beyond the page (no long-lived React Query entry); hiding it again drops it.
3. **`/auth/me`** (`src/lib/api/auth.ts`, `User` in `src/lib/api/types.ts`): no `cpf` any more. Use a `Me` type `{id, name, email, cref, role}`; nothing in the web reads `cpf` from it today. (Since P1-05 `Me` carries `cpf` again, masked, for the profile screen.)
4. **Error copy**: key on `code`, never on `message` (already true for 409 `CONFLICT` in `RegisterForm`/`NewStudentDialog`). The `error.message` fallbacks (`PlanDialog`, `NewStudentDialog`, `LoginForm`, `RegisterForm`) now show fixed English text for non-validation errors; replace them with Portuguese copy per code.
5. **Caching**: set `Cache-Control: no-store` and `Vary: Cookie` on the web's own `/api/bff` and `/api/auth` route responses (plan step 3), whatever `relayBffResponse` copies from the BFF. The proxy already forwards the query string, so `?reveal=cpf` reaches the BFF.

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
  - Errors: 403 `FORBIDDEN` (not visible to you; vertice-api's refusal, fixed message); 404 `NOT_FOUND` for a non-existent id (existence is not hidden).
- `GET /exercises/:id/progress?clientId=` (TRAINER, CLIENT) → `{weekStartDate, weight}[]` (weight-over-time for a graph). **`weight` here is a JSON number**, the one exception to the decimals-are-strings rule below: it is a chart value, converted from the upstream decimal string (`Number(...)`), so it can lose precision. Everywhere else a decimal (`ExerciseSet.weight`, `SetLog.weight`) stays a string. CLIENT role ignores `clientId` and uses their own id; TRAINER must pass it.
  - Errors: 403 `FORBIDDEN` `Requires role: TRAINER or CLIENT` (ADMIN); 400 `VALIDATION_ERROR` `clientId is required` (TRAINER, absent) or field `details` on `clientId` (malformed); 403 `FORBIDDEN` `This client is not one of your clients` (TRAINER).
- `POST /exercises` `{name, description?, videoUrl?, muscleGroupIds}` (TRAINER only) → `201` `Exercise` (`isStarter: false`, private to the caller).
  - `name` 1..255 chars (must not be blank); `description` ≤255, default `""`; `videoUrl` `""` or an http(s) URL ≤500, default `""`; `muscleGroupIds` at least one positive integer id — duplicates are dropped. A trainer-created exercise has no primary group, so its `muscleGroups` come back in id order whatever order was sent. Duplicate names are allowed.
  - Errors: 403 `FORBIDDEN` `Requires role: TRAINER` (CLIENT, ADMIN); 400 `VALIDATION_ERROR` with field `details` for Zod failures (`name` missing/empty/too long, `description`/`videoUrl` too long, `videoUrl` not a URL, `muscleGroupIds` missing/empty/non-positive — a body with only the old `muscleGroup` fails here); 400 `VALIDATION_ERROR` with a flat upstream message for `name: must not be blank`, `videoUrl: must be a valid http(s) URL`, `muscleGroupIds: unknown muscle group <id>`.
- `PATCH /exercises/:id` (TRAINER only), same body as `POST` — **full replacement** of name, description, video URL and the whole group list → `200` `Exercise`.
  - Errors: as `POST`, plus 403 `FORBIDDEN` for a starter row or another trainer's exercise (vertice-api's refusal, fixed message: the two are not told apart); 404 `NOT_FOUND`.
- `DELETE /exercises/:id` (TRAINER only) → `204`, no body.
  - Errors: 403 `FORBIDDEN` `Requires role: TRAINER`; 403 `FORBIDDEN` for a starter row or another trainer's exercise (fixed message); 404 `NOT_FOUND`; **409 `PRECONDITION_FAILED`** while any workout references it — remove it from those workouts first.

403 means "never allowed for you" (fix nothing, hide the action); 409 means "not right now" (the state can change).

## Training plans — `/training-plans`
Every route here is TRAINER or CLIENT; ADMIN gets 403 `Requires role: …`.
- `GET /?clientId=` → `TrainingPlan[]`. CLIENT: own plans only. TRAINER: own plans, optionally filtered by `clientId`.
- `GET /:id` → `TrainingPlan & { workouts: Workout[] }` (nested workouts included for the plan-detail screen)
- `POST /` `{name, description, clientId, startDate: "YYYY-MM-DD", endDate, level: "BEGINNER"|"INTERMEDIATE"|"ADVANCED"}` (TRAINER)
  - Errors: 403 `FORBIDDEN` `This client is not one of your clients` when `clientId` is not the trainer's client. vertice-api also requires an active trainer–client link and answers 409 `PRECONDITION_FAILED` without one.
- `PATCH /:id` same body minus clientId (TRAINER). A plan's client is fixed at creation: a `clientId` in the body is ignored and the stored one is sent upstream.
- `DELETE /:id` (TRAINER) → `204`. **409 `PRECONDITION_FAILED`** once a client recorded training under it (see Errors).

`TrainingPlan` = `{id, name, description, trainerId, clientId, startDate, endDate, level}`

## Workouts
- **`GET /workouts?recent=true`** (TRAINER) → `RecentWorkoutSummary[]` = `Workout & {studentName, planName, exerciseCount}` — the trainer's workouts **across every plan/student**, for the workout-builder's "usar treino existente como base" clone picker. `?recent=true` is currently the only supported mode (no unfiltered "list all" query). Sorted by workout id descending (proxy for recency — `Workout` has no timestamp field). `exerciseCount` costs one `listWorkoutExercises` call per workout, not a full `/full` fetch.
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
  Errors: Zod failures (missing `name`, >20 exercises, >10 sets, bad enum, negative number) → 400 `VALIDATION_ERROR` with field `details`; upstream rejections (cap, malformed decimal) → 400 `VALIDATION_ERROR` with a flat message that does not say which entry. For a TRAINER, every `exerciseId` must be visible to them (the shared starter set or their own exercise). The BFF looks each distinct id up through `GetExercise` before writing; another trainer's private exercise and a nonexistent id both get **400 `VALIDATION_ERROR`** `exerciseId <id> is not available to you`, so the answer does not reveal which.
- `GET /workouts/:id` → `Workout` = `{id, name, trainingPlanId, dayOfWeek}`
- **`GET /workouts/:id/full`** → `Workout & { exercises: FullWorkoutExercise[] }` — **the key aggregate for a workout-builder or read-only workout view.** Each `FullWorkoutExercise` = `WorkoutExercise & { exercise: Exercise, sets: ExerciseSet[] }`, sorted by `order`/`setNumber`. One call gets everything needed to render a workout. `FullWorkoutExercise.exercise` is the `Exercise` shape from the Exercises section (`muscleGroups`, `isStarter`; no `muscleGroup`).
- `PATCH /workouts/:id` `{name, dayOfWeek}` (TRAINER)
- `DELETE /workouts/:id` (TRAINER) → `204`. **409 `PRECONDITION_FAILED`** once a client recorded training under it (see Errors).
- `POST /workouts/:id/clone` `{targetTrainingPlanId, name, dayOfWeek}` (TRAINER) → clones exercises+sets into a new workout, for "reuse a previous workout as a base"

`dayOfWeek`: `MONDAY..SUNDAY`

## Workout exercises
- `GET /workouts/:workoutId/exercises` → `WorkoutExercise[]`
- `POST /workouts/:workoutId/exercises` `{exerciseId, order, restSecondsBetweenSets, notes?}` (TRAINER). For a TRAINER, `exerciseId` must be visible to them (the shared starter set or their own exercise). The BFF looks it up through `GetExercise` before writing; another trainer's private exercise and a nonexistent id both get **400 `VALIDATION_ERROR`** `exerciseId <id> is not available to you`, so the answer does not reveal which.
- **`PUT /workouts/:workoutId/exercises`** `{exercises: WorkoutExerciseEntry[]}` (TRAINER) → `200` **`FullWorkout`** — replaces the workout's **entire** exercise/set tree with the given list (full replace, not merge; same entry shape as `POST /training-plans/:planId/workouts`, max 20). `exercises` is required — `[]` empties the workout, omitting it is a 400. Upstream deletes and recreates the tree, so **every `WorkoutExercise`/`ExerciseSet` id in the response is new**; any id held from before the call is invalid. Refused with **409 `PRECONDITION_FAILED`** once *any* set under the workout has recorded client data (not just sets the replace would drop) — from then on the workout can only be edited through the one-at-a-time endpoints on this page. All-or-nothing: on any 4xx nothing changed. Body `exerciseId`s are checked as for `POST /training-plans/:planId/workouts` (400 when not visible to the trainer). Upstream RPC: `ReplaceWorkoutExercises`. `FullWorkoutExercise.exercise` in the response is the `Exercise` shape from the Exercises section.
- `PATCH /workout-exercises/:id` `{order, restSecondsBetweenSets, notes?}` (TRAINER)
- `DELETE /workout-exercises/:id` (TRAINER) → `204`. **409 `PRECONDITION_FAILED`** once a client recorded training under it (see Errors).

`WorkoutExercise` = `{id, workoutId, exerciseId, order, restSecondsBetweenSets, notes}`

## Exercise sets
- `GET /workout-exercises/:workoutExerciseId/sets` → `ExerciseSet[]`
- `POST /workout-exercises/:workoutExerciseId/sets` (TRAINER)
- `PATCH /exercise-sets/:id` (TRAINER)
- `DELETE /exercise-sets/:id` (TRAINER) → `204`. **409 `PRECONDITION_FAILED`** once a client recorded training under it (see Errors).

`ExerciseSet` = `{id, workoutExerciseId, setNumber, reps, durationSeconds, weight, loadPercentage, strategy, restSeconds, notes}`.
`weight`/`loadPercentage` are decimal **strings** (preserve precision — don't round-trip through float).
`strategy`: `STRAIGHT | WARM_UP | BACKOFF | DROPSET | REST_PAUSE | CLUSTER | AMRAP | ISOMETRIC_HOLD | FAILURE`

## Workout sessions (the client "do a workout" flow)
- **`GET /workouts/:workoutId/session?weekStartDate=YYYY-MM-DD`** (defaults to the current week's Monday) — CLIENT uses own id (any `clientId` is ignored); TRAINER must pass `?clientId=`, the client of the workout's plan.
  - Errors: 403 `FORBIDDEN` `Requires role: TRAINER or CLIENT` (ADMIN); 400 `VALIDATION_ERROR` `clientId is required` (TRAINER, absent) or field `details` on `clientId` (malformed); 403 `FORBIDDEN` `You do not have access to this training plan` (another trainer's or client's workout) or `That training plan does not belong to this client` (TRAINER, `clientId` is not the plan's client); 404 `NOT_FOUND` for an unknown workout.
  → `Workout & { exercises: [...FullWorkoutExercise, sets: [...ExerciseSet, lastPerformed: SetLog|null]] , workoutLog: WorkoutLog }`.
  Each `exercise` under `exercises[]` is the `Exercise` shape from the Exercises section (`muscleGroups`, `isStarter`; no `muscleGroup`).
  This auto-starts (or resumes) this week's log and merges in last time's recorded weight/reps per set (`lastPerformed`), so the UI can show "last time: 60kg × 12" inline. **This is the single call the workout-execution screen needs.**
- `POST /workout-sessions/:workoutLogId/sets` `{exerciseSetId, weight, reps}` (CLIENT) → records one set's actual performance
  - Errors: 403 `FORBIDDEN` `You do not have access to this workout log` (another client's log); 400 `VALIDATION_ERROR` `exerciseSetId does not belong to this workout log` when the set is not one of the log's workout's sets. A missing set gets the same 400, so the answer never tells "someone else's set" from "no such set". vertice-api enforces the same rule (409 `PRECONDITION_FAILED`); the BFF check answers first. 404 `NOT_FOUND` for an unknown log.
- `POST /workout-sessions/:workoutLogId/complete` (CLIENT) → marks the log done
  - Errors: 403 `FORBIDDEN` `You do not have access to this workout log`; 404 `NOT_FOUND` for an unknown log.
- `GET /workout-logs?trainingPlanId=&weekStartDate=&clientId=` — **`trainingPlanId` is required** by vertice-api (this RPC is scoped to one plan + one week, not a general history query). CLIENT uses own id; TRAINER must pass `clientId`, one of their clients. ADMIN gets 403. The plan must belong to that client and to the caller. Use this to render "which workouts are done this week."
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
  "completedToday": [ { "student": "", "workout": "", "completedAt": "2026-10-11T22:00:00Z" } ]
}
```
`stats` are the tiles, `recentFeedback` the five newest entries, `expiringPlans` the plans ending within 14 days (`end` a business date, `daysLeft` whole calendar days from today, `0` on the day it ends), `completedToday` the workouts completed today across the roster.

"Today" and "this week" here are the business day and week in `America/Sao_Paulo` (see "Dates and times"), so a Sunday-evening workout counts as Sunday's. `completedAt` is the completion **instant** (ISO-8601, `Z`): the client formats the clock in the business zone. It replaced a `time: "HH:MM"` field that was `completedAt.slice(11, 16)`, i.e. the UTC wall clock shown as if it were local, which displayed an evening workout about three hours early (audit REL-API-008, plan item P2-02). **This is a breaking change for `GET /dashboard` consumers:** `time` is gone, `completedAt` is new, and a client that renders it must format it rather than slice it.

---

## Running locally
1. `cd vertice-api && docker compose up -d` (postgres on 5432)
2. `cd vertice-api && ./gradlew bootRun --args='--spring.profiles.active=local'` — gRPC on `:9090`, auth disabled for local dev (see `application-local.properties`)
3. `cd vertice-bff && cp .env.example .env && npm install && npm run dev` — REST API on `:3000`
4. `cd vertice-web-react && npm install && npm run dev` — Next.js dev server, pinned to `:5173`
