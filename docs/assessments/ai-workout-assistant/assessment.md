# Technical assessment (BFF): AI Workout Assistant

Status: Draft
Owner: hebertpdl@gmail.com
Related: [vertice-web-react PRD](https://github.com/herbertpdl/vertice-web-react/blob/main/docs/prds/ai-workout-assistant/prd.md)
(source PRD; rules `R1`–`R50`, edge cases `E1`–`E27`; the editor rules it amends are `WE-R#` in
[the editor PRD](https://github.com/herbertpdl/vertice-web-react/blob/main/docs/prds/create-workout-with-exercises/prd.md)),
[vertice-ai foundation assessment](https://github.com/herbertpdl/vertice-ai/blob/main/docs/assessments/vertice-ai-foundation/assessment.md)
(the AI service this BFF will call), `docs/specs/create-workout-with-exercises/spec.md` (touched:
the proposal reuses its entry shapes), `docs/specs/lazy-exercise-search/spec.md` (touched: the catalog
is paged)
Spec: not yet written (will be `docs/specs/ai-workout-assistant/spec.md`)

## 1. Summary

Overall risk: **High**. The feature needs only one new BFF route, but that route differs from
anything this BFF has done so far in four ways:
- it is the BFF's first outbound HTTP call (to `vertice-ai`, not `vertice-api`);
- it is the first streamed response;
- it is the first request that can run for over a minute;
- it is the first place where trainer-written training data leaves the platform for a third-party
  processor.

Nothing on `vertice-api` changes. Applying a proposal goes through the editor's existing
`PUT /workouts/:id/exercises` and `POST /training-plans/:planId/workouts`. `vertice-ai`, on the
other hand, has no endpoint for this feature yet and isn't deployed. So the BFF route can be
specified now, but it can only be tested against a stub until `vertice-ai` ships the feature
endpoint and its infrastructure.

Recommended shape: one trainer-only, stateless, streamed endpoint.
- **The web sends:** the conversation so far, the new message, and the workout as it stands on
  screen.
- **The BFF adds:** the plan and its other workouts plus the trainer's exercise catalog, all
  read with the trainer's own token. It signs a service token and forwards everything to
  `vertice-ai`.
- **The BFF relays:** stages and text as server-sent events.
- **Before relaying a proposal,** the BFF validates it against the catalog and the 20/10
  limits, then enriches it with exercise names and muscle groups so the web can render cards
  without extra calls.

| Id | Severity | One line |
|---|---|---|
| F1 | Blocker | `vertice-ai` has no endpoint for this feature, isn't deployed, and has no network path from the BFF |
| F2 | High | The AI can only use catalog exercises (R29), but the catalog is paged and never loaded whole; the BFF must give the AI a bounded candidate list |
| F3 | High | First streamed response: the CloudFront, ALB and Next proxy timeouts and buffering can cut or delay the stream before R21's 60-second rule |
| F4 | High | "The workout on screen" (R12, R36) is unsaved client state; the BFF must accept it from the web, bound it, and check every exercise id |
| F5 | High | Proposals must be validated in the BFF (R29, R31, R32), not trusted from the model |
| F6 | High | "Parar" and leaving (R16, R50) must cancel the upstream call, or tokens keep being spent with no one listening |
| F7 | High | Health-related data leaves the platform (PRD §8); the feature needs an off-by-default switch and must keep message text out of logs |

## 2. PRD coverage map

"Web only" means the rule is screen behavior with no REST surface. The new route is
`POST /api/assistant/workout-chat` (name to be confirmed in the spec, F8).

| Rule | Lands on | Notes |
|---|---|---|
| R1 | new route, `requireRole('TRAINER')` | Clients and admins get 403 |
| R2 | new route | Takes `trainingPlanId` plus an optional `workoutId`: a new workout has no id yet (F4) |
| R3–R5 | web only | The panel, and the conversation living in browser memory. The BFF is stateless: the web sends the history with each message (F8) |
| R6 | not exposed | Nothing is stored about the assistant, so clients can't see it |
| R7, R8, R9 | forwarded to `vertice-ai` | Prompt behavior; the BFF does nothing |
| R10 | new route schema | `message` max 2,000 characters, counted the way the web counts them (F8) |
| R11 | web only | |
| R12 | new route + existing reads | The workout comes from the request body (F4). The plan and its other workouts come from `GET /training-plans/:id` and `listWorkouts` + `getFullWorkout`, read in the service (F9) |
| R13 | new route (context building) | Forward the plan's name, description, level and dates, workout content and notes; never the client's id, name or email (F7) |
| R14 | web only + new route | The web blocks a second send. The BFF also refuses a second message from the same trainer while one is still running (F10) |
| R15 | web only | |
| R16 | new route | The client aborting the request cancels the upstream call (F6) |
| R17, R18 | new route (stream) | `text` and `stage` events relayed (F3, F8) |
| R19, R20 | web only | |
| R21 | new route (stream) | A 60-second no-progress rule: heartbeats must not count as progress; the BFF emits an `error` event on its own idle timer (F3) |
| R22 | web only | Resends the same request |
| R23, R24 | forwarded to `vertice-ai` | |
| R25 | new route (stream) | Changes always arrive as a `proposal` event in JSON (PRD §9) |
| R26 | forwarded to `vertice-ai` | The one-line "ready" text is the AI's or the web's; to settle in the spec (Q3) |
| R27, R28 | new route (proposal validation) | The proposal carries no name or weekday: it uses the `ReplaceWorkoutExercisesRequest` exercise entries only (F5) |
| R29, R30 | new route (catalog candidates + validation) | F2, F5 |
| R31 | new route (proposal validation) | Same caps as `workoutExerciseEntrySchema` (`src/modules/workouts/schemas.ts:51–61`) |
| R32 | new route (proposal validation) | An invalid proposal becomes an `error` event with code `AI_INVALID_PROPOSAL` (F5) |
| R33–R37, R39 | web only | Markers, review, chaining and discard are client state |
| R38, R40 | existing routes | `PUT /workouts/:workoutId/exercises` (`src/modules/workout-exercises/routes.ts:70`), and nested `POST /training-plans/:planId/workouts` for a new workout. Unchanged |
| R41 | existing route | The 409 `PRECONDITION_FAILED` path the editor already handles. Unchanged |
| R42, R43–R46 | web only | |
| R47–R49 | web only | Closing the panel doesn't end the request |
| R50 | new route | Leaving aborts the request; same as F6 |
| E1, E2, E9, E10 | forwarded to `vertice-ai` | |
| E3 | new route schema | 400 `VALIDATION_ERROR` if the web's own block is bypassed |
| E4 | web only + F10 | |
| E5, E26, E27 | new route | Abort cancels upstream (F6) |
| E6, E7 | web only | |
| E8 | new route | `error` event (F3, F4) |
| E11 | new route | F2: no candidate fits, so the AI answers in text |
| E12 | new route | The proposal is capped (F5); the text explanation is the AI's |
| E13 | new route | `AI_INVALID_PROPOSAL` (F5) |
| E14, E15, E15a, E15b | new route + web | The web sends the on-screen proposal as `workout` (F4) |
| E16 | existing route | 409 path, unchanged |
| E17–E19, E21, E23–E25 | web only | |
| E20, E22 | existing routes | Nested create, and last write wins as today |

## 3. Current state

- **Modules** (`ls src/modules`): auth, clients, dashboard, exercise-sets, exercises, feedback,
  legal, training-plans, users, workout-exercises, workout-sessions, workouts. None fits an AI
  conversation, so this needs a new `assistant` module (F8).
- **Upstream calls:** all of them are gRPC to `vertice-api` through `src/grpc/clients.ts`. There
  is no outbound HTTP client anywhere: `grep -rn "fetch(\|undici" src` returns nothing. There is
  no streamed response either: no `text/event-stream` and no `reply.raw` in `src`. There is no
  per-call deadline: `src/grpc/call.ts` sets none, and `DEADLINE_EXCEEDED` only appears in
  `call.test.ts:200` as a status mapped to 502.
- **Config:** `src/config/env.ts` (Zod, fails closed outside development and test) has
  `JWT_SECRET` with strength guards (`env.ts:147–167`). It has no `vertice-ai` URL or secret.
- **Reusable pieces:**
  - `workoutExerciseEntrySchema` and `replaceWorkoutExercisesSchema` (`src/modules/workouts/schemas.ts:51–67`), with the 20/10 caps.
  - `assertCanUseExercises` (`src/lib/ownership.ts:79`), which answers "not found" and "not yours" the same way.
  - `assertOwnsPlan` / `assertOwnsWorkout`.
  - `getFullWorkout` (`src/modules/workouts/service.ts:231`).
  - The paged catalog `GET /exercises` (`src/modules/exercises/routes.ts:25`): 30 per page by default, at most 50, with `q` and `muscleGroupId` filters.
- **Rate limiting:** `src/plugins/rate-limit.ts` has a global per-IP bucket (300 a minute by
  default) and strict auth and export buckets. Nothing is per trainer.
- **Starter catalog size:** about 199 exercises (the rows in vertice-api
  `V24__seed_starter_exercises.sql`), plus each trainer's own exercises.
- **Drift:** none found in `docs/api-contract.md` for the routes this feature reuses.

## 4. Findings by dimension

### 1. Upstream readiness

**F1 — Blocker — `vertice-ai` cannot serve this feature yet.**
- **What:** `vertice-ai` is only a scaffold. Its one route is `POST /v1/smoke`, which only runs in
  development. It isn't deployed: there is no ECS service, no image registry and no network path
  from the BFF's tasks (vertice-ai foundation assessment, "Still to do").
- **Where:** upstream. On the BFF side this is a new client, `src/ai/client.ts` (new).
- **Why it matters:** this is the "new upstream method" case. The BFF route can be specified and
  built against a stub, but not tested end to end or shipped.
- **Recommendation:**
  - Sequence the work as: `vertice-ai` feature endpoint and its deployment → BFF → web.
  - Specify the BFF ↔ `vertice-ai` contract (request body, event names, error events) once, in
    the BFF spec. The `vertice-ai` side implements it, so both stay in sync.
  - The service token is the one the foundation assessment fixed: HS256 with
    `SERVICE_JWT_SECRET`, `iss=vertice-bff`, `aud=vertice-ai`, `sub=service:bff`, a short `exp`,
    and `uid` and `role` from `req.user` for attribution.

### 2. Route and schema design

**F8 — Medium — The new route's shape.**
- **What:** this is an action, not a resource, and its answer is a stream.
- **Where:** new module `src/modules/assistant/` (routes, schemas, service), mounted at
  `/api/assistant`.
- **Recommendation:**
  - **The call:** `POST /api/assistant/workout-chat` answering `text/event-stream`.
  - **Request body:**
    - `trainingPlanId`
    - optional `workoutId`
    - `workout: { exercises: WorkoutExerciseEntry[] }`: the screen's state, reusing
      `workoutExerciseEntrySchema`. Each entry also carries an opaque client `key`, and each
      proposal entry echoes the key of the exercise it modifies, or none when it's new. The web
      needs this to tell "Alterado" from "Novo" + "Removido" (R33; web assessment F5). The BFF
      checks that every echoed key was sent.
    - `history`: earlier turns, each a role and text, bounded in turns and characters
    - `message`: at most 2,000 characters
  - **Events:**
    - `stage`: a label key
    - `text`: a chunk
    - `proposal`: the exercise entries enriched with each exercise's name, muscle groups and
      video flag, the way `fullWorkoutSchema` shapes them, but with no ids for the workout
      exercises or sets
    - `done`
    - `error`: one of the codes in F11
  - **OpenAPI:** the web generates its types from `docs/openapi.json`, and an event stream doesn't
    fit `routeDoc`'s `ok` schema. The spec must decide how the event payloads get into the
    contract, for example by publishing a schema per event under `components.schemas` so
    `api:types` picks them up.
  - **History:** the BFF keeps no conversation (R5: lost on leaving), so the web sends it every
    time. Cap it, for example at the last 20 turns and 40,000 characters, and reject anything
    over the cap.

**F9 — Medium — Building "the plan's other workouts" costs many upstream calls.**
- **What:** `getFullWorkout` makes one `GetWorkout`, one `ListWorkoutExercises`, and a
  `GetExercise` plus `ListExerciseSets` for each exercise (`service.ts:231–242`). A plan of 7
  workouts with 10 exercises each is about 150 gRPC calls before the AI even starts.
- **Where:** the new `assistant/service.ts`.
- **Recommendation:** for each other workout, send only what the AI needs to balance the week:
  each exercise's name and muscle groups, and the number of sets. Read it with
  `ListWorkoutExercises`, `ListExerciseSets` and one deduplicated `GetExercise` per exercise
  id. Measure it in the spec. The `GET /dashboard` and `listRecentWorkoutsForTrainer` comments
  show the same N+1 pattern was accepted before at this scale.

### 3. Auth, roles and ownership

**F4 — High — The on-screen workout comes from the client.**
- **What:** R12 sends "the workout on screen", and R36 builds a new change on a proposal that
  hasn't been saved. Neither is stored anywhere, so the web must send it. A tampered body could:
  - name exercise ids that belong to another trainer, leaking their private exercise names into
    the context;
  - be oversized.
- **Where:** the new route.
- **Recommendation:**
  - **Ownership:** `assertOwnsPlan(trainingPlanId)`, and `assertOwnsWorkout(workoutId)` when an id
    is given. Check that the workout belongs to that plan.
  - **Exercise ids:** run `assertCanUseExercises` on every id in `workout` and in the history's
    proposals.
  - **Size:** parse with the existing 20/10 caps and field bounds.
  - **Name and weekday:** never accept either from the body (R28).

### 4. Error mapping

**F11 — Medium — New failure modes, most of them after the stream has started.**
- **What:** once the first byte is sent, the HTTP status is already 200, so failures after that
  must be `error` events.
- **Where:** new codes, alongside `src/lib/errors.ts`.
- **Recommendation:**
  - **Before streaming,** normal statuses apply:
    - 400 `VALIDATION_ERROR`
    - 403 / 404 through the ownership checks
    - 409 `CONFLICT` for a second message already running (F10)
    - 503 `AI_UNAVAILABLE` when `vertice-ai` can't be reached or the feature is switched off (F7)
  - **In the stream,** `error` events carry `AI_UNAVAILABLE` (503 from upstream), `AI_TIMEOUT` (60
    seconds with no stage or text, R21), `AI_INVALID_PROPOSAL` (R32) or `AI_ERROR` (anything
    else).
  - **Docs:** add the codes to `docs/api-contract.md`'s common codes and to the `CLAUDE.md`
    mapping list.

### 5. Backward compatibility

Nothing found. Checked:
- The feature is a new route on a new module.
- No existing response shape changes, and there is still no `/api/v1` prefix
  (`grep -rn "api/v" src` is empty).
- An old web build simply never calls the route.

### 6. Composed / aggregate endpoint impact

**Info.**
- The new route is itself a composed endpoint: plan, workouts and catalog go in, and an enriched
  proposal comes out (F8).
- No existing composed endpoint changes.
- Applying a proposal reuses `PUT /workouts/:id/exercises`, which already re-reads the full
  workout (`routes.ts:70–103`).

### 7. Performance

**F2 — High — The AI needs the catalog, and the catalog is never loaded whole.**
- **What:**
  - R29 limits proposals to the trainer's catalog.
  - The catalog is paged (`GET /exercises`, at most 50 a page), on purpose
    (`lazy-exercise-search`).
  - The starter set alone is about 199 exercises, plus each trainer's own.
  - `vertice-ai` has no access to `vertice-api` by design (foundation assessment), so the AI can't
    search the catalog itself.
- **Where:** the new `assistant/service.ts`.
- **Options, for the spec:**
  - **(a) Send the whole visible catalog with every message.** About 4–6 pages upstream, and a
    few thousand tokens of id, name and muscle groups. It can be prompt-cached because it rarely
    changes. This is the simplest.
  - **(b) Let `vertice-ai` call back to a BFF search endpoint as a tool.** This needs a new
    service-to-service auth path into the BFF, a model-driven loop, and the read-only tool
    assessment that vertice-ai's `CLAUDE.md` requires.
  - **(c) Let the AI propose exercises by name and have the BFF resolve the names to ids.**
    Fuzzy matching would quietly pick the wrong exercise.
- **Recommendation:** (a) for v1, with a size cap: refuse the message with a clear code if a
  trainer's own catalog ever pushes the total past the cap. Keep (b) as the path if catalogs
  grow.

**F3 — High — Streaming through the current network path.**
- **What:** this is the first response that stays open for a long time and sends bytes
  intermittently. Each hop can cut it, or hold it back until it ends:
  - The web's `/api/bff/[...path]` proxy (`relayBffResponse`, web repo) must stream rather than
    buffer.
  - The BFF sits behind CloudFront and the shared ALB (`api.vertice.fit`).
  - CloudFront's origin read timeout is 30 seconds by default.
  - The ALB's idle timeout is 60 seconds by default.
  - Compression or `@fastify/helmet` headers must not buffer `text/event-stream`.
- **Where:** the new route, plus the infrastructure (vertice-devops).
- **Recommendation:**
  - The BFF sends a comment heartbeat about every 15 seconds. R21's own 60-second no-progress
    timer stays separate and counts only `stage` and `text`.
  - Confirm, or raise, the CloudFront and ALB timeouts for this path.
  - Set `Cache-Control: no-cache` and `X-Accel-Buffering: no`.
  - The web assessment covers the proxy side.

### 8. Security and privacy

**F7 — High — Health-related data goes to an external processor.**
- **What:** the context includes prescribed loads and trainer notes, which are D4 health data,
  plus free text (plan name and description) that can name the client (PRD R13 and §8). The
  PRD says the feature does not reach trainers until the assessment settles the legal question.
- **Where:** the new route and `src/config/env.ts`.
- **Recommendation:**
  - **Kill switch:** a new `AI_ASSISTANT_ENABLED` flag, false by default. When it's off, the
    route answers 503 `AI_UNAVAILABLE` and the web hides the AI icon. The web needs a way to
    know the flag's state (Q2).
  - **Never send:** the client's id, name or email.
  - **Logs:** log the request id, trainer id, durations and token counts, but never the message,
    history or proposal (`grep -rn "console\.\|logger\." src/modules` shows no body logging
    today; keep it that way).
  - **New env vars:** `VERTICE_AI_URL` and `SERVICE_JWT_SECRET`, with the same strength guards as
    `JWT_SECRET` (`env.ts:147–167`). The secret must differ from `JWT_SECRET`, and the env guard
    should check that.
  - **LGPD:** the processor question (consent text, data inventory) is a product and legal
    decision recorded in the PRD's §8, not a BFF one. It blocks turning the flag on, not building
    the feature.

**F5 — High — The model's proposal is untrusted input.**
- **What:** a model can return ids outside the candidate list, more than 20 exercises,
  out-of-range values, or a workout name or weekday.
- **Where:** the new route.
- **Recommendation:**
  - Parse every `proposal` with `replaceWorkoutExercisesSchema`'s rules.
  - Check that every `exerciseId` is in the candidate list sent for this message. That check is
    cheaper than `assertCanUseExercises`, and just as strict.
  - On any failure, send `AI_INVALID_PROPOSAL` and send no proposal (R32).
  - Never forward fields outside the schema.

**F10 — Medium — No server-side limit on concurrent or repeated AI calls.**
- **What:** R14 blocks a second send only in the web. A script can open many streams, each one
  costing model tokens. The usage limit is out of scope (PRD §6), but one in-flight message per
  trainer is cheap insurance.
- **Where:** an in-memory map keyed by trainer id in the new module, like the attempt limiter's
  in-memory buckets (`src/lib/attempt-limiter.ts`).
- **Recommendation:**
  - Answer 409 `CONFLICT` when a message is already running for this trainer, and free the slot
    on `done`, `error` or abort.
  - Because it's in memory per task, it only bounds each BFF task, not the whole service. Note
    that in the spec.

**F6 — High — Abort must reach `vertice-ai`.**
- **What:** "Parar" (R16) and leaving (R50) close the browser's request. Unless the BFF notices
  (`req.raw.on('close')`) and aborts its outbound `fetch` with an `AbortController`, `vertice-ai`
  keeps generating and the tokens are billed anyway.
- **Where:** the new route and client.
- **Recommendation:** wire the abort end to end and test it with a stub upstream that checks it
  was cancelled. `vertice-ai` must also stop the model call on disconnect; that belongs in its
  own spec.

### 9. Testing

What to test is listed in §6. This would be the first streaming test in the repo. Tests today
(`find src -name "*.test.ts"`) cover schemas, config, plugins and `lib`; routes are not tested
against a live upstream. The new module follows the same approach, with a stub `vertice-ai`
served over HTTP.

### 10. Documentation

- **`docs/api-contract.md`:** a new section for the endpoint and its events, plus the new error
  codes.
- **`CLAUDE.md`:** the first outbound HTTP upstream, the new env vars, the new error codes, and
  the rule that message text is never logged.
- **`docs/openapi.json`:** regenerated with the event schemas (F8).
- **`.env.example`:** `VERTICE_AI_URL`, `SERVICE_JWT_SECRET` and `AI_ASSISTANT_ENABLED`.

### 11. Effort, risk and dependencies

See §8.

## 5. Options

The catalog question (F2) is the real choice: (a) send the whole visible catalog, (b) a search
tool that calls back into the BFF, or (c) resolve names. The recommendation is (a), with a cap.

## 6. Testing strategy

**Schema (`assistant/schemas.test.ts`):**
- A 2,000-character message is accepted; 2,001 is refused.
- The history caps are enforced.
- `workout` at the 20/10 caps is accepted; 21 exercises or 11 sets are refused.
- Unknown fields such as `name` or `dayOfWeek` are stripped or refused.
- `workoutId` is optional.

**Ownership:**
- Another trainer's plan or workout is refused.
- A `workoutId` from a different plan is refused.
- An exercise id the trainer can't see is answered like "not found".

**Proposal validation:**
- An id outside the candidates, 21 exercises, an out-of-range weight, or an extra name field
  each give `AI_INVALID_PROPOSAL` and no proposal.
- A valid proposal is enriched with names and muscle groups.

**Streaming, with a stub upstream:**
- Events arrive in order.
- Heartbeats are sent but don't reset the R21 timer.
- 60 seconds with no stage or text gives `AI_TIMEOUT`.
- An upstream 503 gives `AI_UNAVAILABLE`.
- A client abort cancels the upstream request.

**Concurrency:** a second message from the same trainer gets 409, and the slot frees on done,
error and abort.

**Config:**
- `SERVICE_JWT_SECRET` has the same guards as `JWT_SECRET` and is refused when equal to it.
- `AI_ASSISTANT_ENABLED` defaults to false.
- When the flag is off, the route answers 503.

**Context:** the request sent upstream never contains the client's id, name or email.

**Repo-wide guards:**
- The new route needs a row in `src/test/route-authorization.test.ts`: 401 with no token, 403 for
  CLIENT and ADMIN, and 403 for another trainer's `trainingPlanId` or `workoutId` in the body.
  The suite fails when a route has no row.
- Every new error code goes into `ERROR_CODES`, which a test scans.
- The service token for `vertice-ai` uses `aud: "vertice-ai"`, so `verifyToken` must never
  accept it as a user token, and vertice-api must never accept it either.

## 7. Rollout

**Order:**
1. `vertice-ai`: the feature endpoint, and its deployment on ECS, reachable only from the BFF.
2. vertice-devops: CloudFront and ALB timeouts, and the service secret in Secrets Manager.
3. vertice-bff, with `AI_ASSISTANT_ENABLED=false`.
4. vertice-web-react.

**Turning it on:** the flag goes on only after the PRD §8 question is settled.

**Rollback:** turn the flag off. The route needs no data cleanup because nothing is stored.

**Old web builds:** they keep working, since the change is purely additive.

**Docs:** see §4.10.

## 8. Effort and risk

**Size: L.** The work is one new module, but it introduces:
- an outbound HTTP client with a service token;
- event streaming with heartbeats, an idle timer and abort;
- context building across plans, workouts and the catalog;
- proposal validation and enrichment;
- new configuration and its guards.

**Risk:** High, mainly from F1 (upstream doesn't exist yet) and F3 (streaming through
infrastructure that has only served short requests).

**Dependency:** the `vertice-ai` feature endpoint and its deployment must ship first. Until then,
build and test against a stub.

## 9. Questions and assumptions

- **Q1.** The AI service's own wait time for the model, and whether the BFF's 60-second
  no-progress timer or `vertice-ai`'s timeout fires first. Assume `vertice-ai` reports a stage at
  least every 30 seconds while working. The BFF's timer is the one the trainer sees.
- **Q2.** How the web learns that the feature is switched off. Assume a field in an existing
  response the web already loads (for example `GET /auth/me`), decided in the spec, rather than
  a new call.
- **Q3.** Who writes the one-line "ready" message (R26): the AI or the web. Assume the web shows a
  fixed text when a `proposal` event arrives. That's cheaper and always consistent.
- **Q4.** The history caps. Assume 20 turns and 40,000 characters. The owner can tune them with
  the usage-limit PRD.

## 10. Inputs to the spec

- F1: define the BFF ↔ `vertice-ai` contract (request, events, errors, service token) once, and
  sequence `vertice-ai` first.
- F2: choose how the AI sees the catalog. Recommended: (a), the whole visible catalog with a cap.
- F3: heartbeat interval, response headers, and the CloudFront and ALB timeout changes with
  vertice-devops.
- F4: request shape for the on-screen workout, and its ownership and exercise-id checks.
- F5: the proposal validation rules and the `AI_INVALID_PROPOSAL` path.
- F6: end-to-end abort.
- F7: the `AI_ASSISTANT_ENABLED` flag, the new env vars and their guards, and a no-content
  logging rule.
- F8: module, path, event names, and how the events reach the OpenAPI document.
- F9: what each other workout contributes to the context, and how many upstream calls it costs.
- F10: one in-flight message per trainer.
- F11: new error codes, before and inside the stream.
