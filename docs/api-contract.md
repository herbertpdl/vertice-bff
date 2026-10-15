# vertice-bff API contract

Base URL (dev): `http://localhost:3000/api`

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
Common codes: `VALIDATION_ERROR` (400), `UNAUTHORIZED`/`UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `PRECONDITION_FAILED` (409), `RATE_LIMITED` (429, with a `Retry-After` header in seconds), `UPSTREAM_ERROR` (502), `UPSTREAM_UNAVAILABLE` (503).

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
| anything else (`UNKNOWN`, `INTERNAL`, ...) | 502 | `UPSTREAM_ERROR` | `Upstream error` |

`details` is only set on the BFF's own validation errors (Zod field errors and the like), never from upstream. The BFF's own refusals (`Requires role: TRAINER`, `This client is not one of your clients`, ...) keep their specific messages.

`PRECONDITION_FAILED` (409) means the request was well-formed but the resource's current state forbids it — emitted by `PUT /workouts/:workoutId/exercises`, when a client has already recorded data under the workout, and by `DELETE /exercises/:id`, while any workout uses the exercise. Distinct from `VALIDATION_ERROR` ("fix the payload").

**Headers.** Every response carries API security headers (`@fastify/helmet`): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none';frame-ancestors 'none'` (the BFF serves no HTML), `Strict-Transport-Security`, `Referrer-Policy: no-referrer` and helmet's other defaults. Every `/api/*` response, errors included, is `Cache-Control: no-store`, except a successful `GET /legal/versions` (public, no personal data: `Cache-Control: public, max-age=300`).

Roles: `TRAINER`, `CLIENT`, `ADMIN`. Most write endpoints require `TRAINER`. Every id a route accepts (path, query or body) is checked against the caller: a `CLIENT` only reaches their own plans, workouts and workout logs; a `TRAINER` only their own plans and their own clients (`TrainerClientService.IsTrainersClient`). Another user's id is **403 `FORBIDDEN`**. A `CLIENT`'s `clientId` query parameter is ignored and replaced with their own id. `src/test/route-authorization.test.ts` pins this per route.

**`ADMIN` has no defined product yet** (no PRD; audit QUAL-BFF-001, plan item P1-02). Until one exists, an ADMIN keeps only what is generic: their own account and the exercise catalog reads. Every trainer- or client-scoped route answers an ADMIN with **403 `FORBIDDEN` `Requires role: …`** before any upstream call; there is no ADMIN bypass in the BFF's ownership checks. (vertice-api still lets ADMIN through on most RPCs; the BFF is just narrower.) Giving ADMIN a feature needs a short PRD first, then explicit routes.

| Routes | Roles |
|---|---|
| `POST /auth/login`, `POST /auth/register`, `POST /auth/password/setup`, `GET /legal/versions`, `GET /health` | public |
| `GET /auth/me`, `POST /auth/me/consent`, `POST /auth/password`, `GET /muscle-groups`, `GET /exercises/:id` (upstream decides visibility) | any role |
| `GET /exercises` | TRAINER, ADMIN (ADMIN sees the starter set) |
| `/clients/**`, `GET /dashboard`, `GET /feedback`, `GET /workouts?recent=true`, `POST /exercises`, `PATCH`/`DELETE /exercises/:id`, every plan/workout/workout-exercise/set write (`POST`/`PUT`/`PATCH`/`DELETE`, incl. `POST /workouts/:id/clone`) | TRAINER |
| `GET /training-plans`, `GET /training-plans/:id`, `GET /training-plans/:planId/workouts`, `GET /workouts/:id`, `GET /workouts/:id/full`, `GET /workouts/:workoutId/exercises`, `GET /workout-exercises/:workoutExerciseId/sets`, `GET /workouts/:workoutId/session`, `GET /workout-logs`, `GET /exercises/:id/progress` | TRAINER, CLIENT (each scoped to their own data) |
| `POST /workout-sessions/:workoutLogId/{sets,complete}`, `POST /workout-logs/:workoutLogId/feedback` | CLIENT |

## Rate limits
- **Global:** every route shares a loose per-IP bucket (default 300 requests per minute; `RATE_LIMIT_GLOBAL_MAX`/`RATE_LIMIT_GLOBAL_WINDOW_MS`).
- **Auth (strict):** separate buckets per route, per IP and (where the body has one) per email, default 5 per 15 minutes (`AUTH_RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_WINDOW_MS`). Once a bucket is full the next request is `429 RATE_LIMITED`, whatever its credentials, until the window ends.
  - `POST /auth/login` (IP + email) and `POST /auth/password/setup` (IP) count **failed** attempts only: a response below 400 gives the attempt back, so the 6th failure in 15 minutes is a 429 and a gym full of clients on one IP can still log in.
  - `POST /auth/register` (IP + email) counts **every** attempt: a successful sign-up is what a spammer repeats.
  - `POST /auth/password` (IP + user) counts failed attempts.
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
- `POST /register` `{name, email, password, role: "TRAINER", cpf, cref?, acceptedTermsVersion}` → `201`, same shape as login. **Only `TRAINER`**: `role: "CLIENT"` is `400 VALIDATION_ERROR` (clients are created by their trainer, `POST /clients`). **`cpf` is required for a trainer** (vertice-api rejects an empty or invalid one; it is optional only for a CLIENT). `cref` is optional (trainer license number). **`acceptedTermsVersion` is required** (P1-04): the version of the Terms of Use / Privacy Policy the user accepted on the form, normally `terms` from `GET /legal/versions`. Format: 1 to 32 of `[A-Za-z0-9._-]` (vertice-api's); missing or malformed is `400 VALIDATION_ERROR` before any upstream call. Any well-formed version is accepted, not only the current one. vertice-api stores it with its own timestamp. A taken email or CPF is `409 CONFLICT` `Email or CPF already in use`, the same body for both.
- `GET /me` (auth) → `{id, name, email, cref, role, consent}`: the caller's own account. **No `cpf`** (no screen shows it; P1-03). `cref` is `""` for anyone but a trainer who set one. `consent` is the caller's `Consent` (below), from vertice-api's self view.
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

## Students — `/students` (TRAINER only)
A trainer's roster = distinct clients across their training plans (User has no direct trainer link). **This means a newly created student with no training plan yet does not appear in `GET /` until a plan is created for them** — this is pre-existing behavior of the roster derivation, not something the endpoints below change.
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
- `POST /` `{name, email, cpf?}` → `201` `ClientDetail & {setup}` (CPF masked). **`cpf` is optional** for a client (vertice-api #65, data minimisation, pending legal review): omitted or `""` creates the client without one (stored as NULL, `cpf: ""` in responses); a CPF that is set must be valid (400) and unique (409) — creates a CLIENT user **without a password** and issues a first-access token. A `password` in the body is ignored (never sent upstream): the client chooses their own.
  ```json
  {
    "id": 42, "name": "Ana", "email": "ana@example.com", "cpf": "***.***.***-25", "role": "CLIENT",
    "setup": { "token": "<43-char base64url>", "expiresAt": "2026-10-16T18:00:00Z" } | null
  }
  ```
  The web builds the link the trainer shares from the token: `/definir-senha?token=<token>` (the page posts it to `POST /auth/password/setup`). The token is shown once (vertice-api only stores its hash) and expires after 72h. There is no email delivery yet. `setup` is `null` only when the client was created but issuing the token failed; re-issue it with the route below rather than re-creating the client (that would be a 409 `CONFLICT`).
- `POST /:id/setup-token` (**TRAINER only**, one of your clients) → `201` `{token, expiresAt}`. Re-issues the first-access link; the previous one stops working. Only while the client has no password yet: once they set one it is **`409 PRECONDITION_FAILED`**, since a trainer-issued link would let the trainer reset the client's password. (Clients created before setup tokens existed have a random password, so they get their link from ops: `npm run ops:issue-setup-tokens`, see the README.) Errors: 403 `Requires role: TRAINER` (ADMIN, CLIENT); 403 `This client is not one of your clients`.
- `PATCH /:id` `{name, email, cpf?}` → `ClientDetail` (CPF masked). Despite the verb, a **full replace** of these three fields (vertice-api's `UpdateUser`): an omitted or empty `cpf` **removes** a stored CPF. Send the full CPF to keep it (read it with `?reveal=cpf`; never send the mask back). A taken email or CPF is `409 CONFLICT` `Email or CPF already in use`.
- `DELETE /:id`

### What vertice-web-react must change (P1-03, web step)
The detail page renders whatever `cpf` string it gets (now the mask). The web PR must:
1. **Roster** (`src/app/(app)/alunos/AlunosContent.tsx`, done in vertice-web-react #45): no email under the name, search by name only, and `GET /clients` typed `ClientSummary` (`{id, name, activePlanCount, currentPlan, lastWorkoutAt, weekActivity}`, `src/lib/api/types.ts`), so nothing reads `email`/`cpf`/`cref`/`role` from it. With that live, the BFF dropped `email` from `GET /clients`, and vertice-api moves `ListClientsForTrainer` to its summary view.
2. **Student detail** (`src/app/(app)/alunos/[studentId]/StudentDetailContent.tsx`): `overview.student.cpf` is now masked (`***.***.***-25`). Show it as is, with a "mostrar" toggle that fetches `GET /clients/:id?reveal=cpf` (`fetchStudent(id, { revealCpf: true })` in `src/lib/api/students.ts`) and shows that response's `cpf`. Don't cache the revealed CPF beyond the page (no long-lived React Query entry); hiding it again drops it.
3. **`/auth/me`** (`src/lib/api/auth.ts`, `User` in `src/lib/api/types.ts`): no `cpf` any more. Use a `Me` type `{id, name, email, cref, role}`; nothing in the web reads `cpf` from it today.
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
- `GET /exercises/:id/progress?clientId=` (TRAINER, CLIENT) → `{weekStartDate, weight}[]` (weight-over-time for a graph). CLIENT role ignores `clientId` and uses their own id; TRAINER must pass it.
  - Errors: 403 `FORBIDDEN` `Requires role: TRAINER or CLIENT` (ADMIN); 400 `VALIDATION_ERROR` `clientId is required` / `Invalid clientId: <value>` (TRAINER); 403 `FORBIDDEN` `This client is not one of your clients` (TRAINER).
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
- `DELETE /:id` (TRAINER)

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
- `DELETE /workouts/:id` (TRAINER)
- `POST /workouts/:id/clone` `{targetTrainingPlanId, name, dayOfWeek}` (TRAINER) → clones exercises+sets into a new workout, for "reuse a previous workout as a base"

`dayOfWeek`: `MONDAY..SUNDAY`

## Workout exercises
- `GET /workouts/:workoutId/exercises` → `WorkoutExercise[]`
- `POST /workouts/:workoutId/exercises` `{exerciseId, order, restSecondsBetweenSets, notes?}` (TRAINER). For a TRAINER, `exerciseId` must be visible to them (the shared starter set or their own exercise). The BFF looks it up through `GetExercise` before writing; another trainer's private exercise and a nonexistent id both get **400 `VALIDATION_ERROR`** `exerciseId <id> is not available to you`, so the answer does not reveal which.
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
- **`GET /workouts/:workoutId/session?weekStartDate=YYYY-MM-DD`** (defaults to the current week's Monday) — CLIENT uses own id (any `clientId` is ignored); TRAINER must pass `?clientId=`, the client of the workout's plan.
  - Errors: 403 `FORBIDDEN` `Requires role: TRAINER or CLIENT` (ADMIN); 400 `VALIDATION_ERROR` `clientId is required` / `Invalid clientId: <value>` (TRAINER); 403 `FORBIDDEN` `You do not have access to this training plan` (another trainer's or client's workout) or `That training plan does not belong to this client` (TRAINER, `clientId` is not the plan's client); 404 `NOT_FOUND` for an unknown workout.
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
