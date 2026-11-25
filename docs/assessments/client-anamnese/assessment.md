# Technical assessment (BFF): Client Anamnese

Status: Draft
Owner: hebertpdl@gmail.com
Related: [vertice-api PRD](https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/client-anamnese/prd.md)
(source; rules `R1`–`R42`, edge cases `E1`–`E25`; the AI assistant's rules are `AI-R#`),
[vertice-api assessment](https://github.com/herbertpdl/vertice-api/blob/main/docs/assessments/client-anamnese/assessment.md)
(its findings are cited as `API-F#`),
[vertice-web-react AI assistant PRD](https://github.com/herbertpdl/vertice-web-react/blob/main/docs/prds/ai-workout-assistant/prd.md)
(AI-R13, AI-R26, AI-R30, AI-R51), `docs/specs/ai-workout-assistant/spec.md` (touched: the chat
payload and the stream), `docs/specs/feature-flags/spec.md` (touched: `GET /assistant/status` is
reused for R39), `docs/specs/data-subject-rights/spec.md` (touched: export and deletion, no code change)
Spec: not yet written (will be `docs/specs/client-anamnese/spec.md`)

## 1. Summary

Overall risk: **Medium**. The REST surface is small and every part follows a pattern that exists:
- two new routes on the `clients` module, `GET` and `PUT /clients/:id/anamnese`;
- one additive field, `hasAnamnese`, on the `GET /clients` roster, mapped like `suspended`;
- one new small read route for the AI panel, `GET /assistant/anamnese-notice?trainingPlanId=`, which
  returns the R25/R26 state and the client's name (§5);
- one change inside `POST /assistant/workout-chat`: read the anamnese fresh on every message and
  send only its text to vertice-ai.

R39 (the tab mentions the AI only when the trainer has it) is already covered by
`GET /assistant/status`. Export and account deletion need no BFF code.

The risk is in scheduling and in the AI path, not in the routes:
- **Nothing upstream exists yet.** The routes need vertice-api's new `ClientAnamneseService`
  (`GetClientAnamnese`/`SaveClientAnamnese`) and `UserResponse.has_anamnese` (F1). The chat change
  also needs vertice-ai to accept an `anamnese` field: its request model rejects unknown keys, so
  a BFF that sends it first breaks every chat message (F2).
- **The BFF deploy is the launch.** The `AI_ASSISTANT_ENABLED` flag is already on. The first BFF
  build that reads the anamnese into the chat sends health data to Anthropic right away, so R33's
  privacy text and data inventory must be live before it (F3).
- **The chat must keep working without an anamnese.** A former trainer can still open the assistant
  on a former client's workout. Their read is refused (PERMISSION_DENIED), and that must mean
  "no anamnese", not a failed message. Any other failure must not be quietly sent as "no
  anamnese" either (F4).
- **The panel needs data no route gives today** (F5). It needs presence, the client's name and the
  link target, and the former-trainer case needs a third state.
- **R31's two separate lines** can't be expressed on today's stream. `text` is a stream of deltas
  the web appends together, and the BFF relays only `delta` (F6).

Recommended approach: the `clients` routes as resource routes (`PUT` because a save replaces,
R13), and a separate light panel route built from the roster RPC, so the editor page never loads
the health text only to learn that it exists (§5, option C).

| Id | Severity | One line |
|---|---|---|
| F1 | Blocker | `ClientAnamneseService` and `UserResponse.has_anamnese` don't exist upstream yet: routes can be spec'd, not built or tested against a real API |
| F2 | Blocker | vertice-ai's `WorkoutChatRequest` forbids unknown keys: sending `anamnese` before vertice-ai accepts it 400s every chat message |
| F3 | High | No switch of its own and the AI flag is on: the first BFF deploy with the chat change sends health data to Anthropic, so R33 must be live first |
| F4 | High | Chat path: PERMISSION_DENIED on the read means "omit the field", any other failure fails the message before the stream; never cache (R29) |
| F5 | High | The AI panel needs presence, the client's name and the link target for a plan, plus a "not available" state for former trainers: no route answers that |
| F6 | High | R31 needs two separate lines after a proposal; the stream's `text` deltas are concatenated and the BFF drops unknown events and fields |

## 2. PRD coverage map

| Rule | Lands on | Notes |
|---|---|---|
| R1 | new routes: `GET`/`PUT /clients/:id/anamnese` behind the module's TRAINER hook (`clients/routes.ts:17-20`) plus `assertIsTrainersClient` (`clients/service.ts:235-244`); vertice-api is authoritative (API-F7) | F7 |
| R2 | not exposed separately: trainers use the web only (web-trainer-only-access), and the mobile app builds no screen for it. The BFF can't tell the apps apart and needs no check | — |
| R3 | new routes are TRAINER only, so a CLIENT gets 403 by role before any upstream call | F7, §6 |
| R4 | new routes are outside `/api/admin` and TRAINER only, so ADMIN gets 403 by role. Nothing under `modules/admin` reads or returns it | F7 |
| R5 | not exposed: upstream key (trainer, client) (API-F4); the BFF never sends a `trainerId`, since the API takes the trainer from the token | — |
| R6 | not exposed: the empty state from upstream, returned as is | — |
| R7 | new routes: `assertIsTrainersClient` refuses a former client with 403. Chat path: refused read → field left out | F4, F5 |
| R8 | not exposed: upstream data model (API-F1, F4) | — |
| R9 | not exposed (web tab) | — |
| R10 | new route `PUT /clients/:id/anamnese`: `utf16String(5000)` (`lib/validation.ts:15-19`), the same constant as vertice-api's `@Size` | F8 |
| R11 | `PUT` refuses 5,001 UTF-16 units with 400 before any upstream call; the web blocks it first | F8 |
| R12 | not exposed (web); the BFF stores only what a `PUT` sends | — |
| R13 | `PUT` replaces; no history route | — |
| R14 | `GET`/`PUT` response `updatedAt`: an ISO-8601 instant, relayed verbatim (CLAUDE.md "Dates and times") | — |
| R15 | not exposed (web) | — |
| R16, R17, R18 | not exposed (web copy). The text is stored as written: no trim in the schema | F8 |
| R39 | existing route: `GET /assistant/status` (`assistant/routes.ts:49-69`), already TRAINER, always 200 | Nothing changes |
| R19 | `PUT` with blank text clears; the BFF passes it through and answers the empty state upstream returns | F8 |
| R20 | `PUT`, last write wins; no `If-Match`/version | — |
| R21 | existing route that must change: `GET /clients` (`clients/routes.ts:22-38`, `clients/service.ts:172-232`) gains `hasAnamnese`, mapped like `suspended` (`:186-187`, `:229`) | F9 |
| R22 | existing route that must change: `POST /assistant/workout-chat`, `buildChatContext` (`assistant/service.ts:83-132`) reads it by `plan.clientId` | F4 |
| R23 | not exposed: vertice-ai prompt (API-F20) | — |
| R24 | `buildChatContext` adds only the text; `AiWorkoutChatRequest` (`ai/contract.ts:30-55`) gains `anamnese?: string` | F4, §6 |
| R40 | `ai/contract.ts` and docs ("What reaches vertice-ai", `docs/api-contract.md:708`, spec §3 "Never sent") | F2, F11 |
| R25 | new route: `GET /assistant/anamnese-notice?trainingPlanId=` → `present` with the client's id and name | F5 |
| R26 | the same route → `missing`, with the client's id for the fill-in link | F5 |
| R27 | chat path: no field sent, so vertice-ai behaves as today | F4 |
| R28 | not exposed (web link); the route gives the `clientId` the link needs | F5 |
| R29 | chat path: one read per message, no cache (`Cache-Control: no-store` already on `/api/*`) | F4 |
| R30, R31 | existing stream that must change: `text` relay (`assistant/session.ts:179-185`), unknown events dropped (`:224-226`) | F6 |
| R32, R41, R42 | not exposed: legal framing; nothing in the BFF reads consent for this (the `PUT` must not check `consent`) | F3 |
| R33 | not exposed, but gates this repo's deploy (privacy text in vertice-web-react, inventory in vertice-api) | F3 |
| R34 | not exposed (legal review) | — |
| R35, R36 | existing route, no change: `GET /auth/me/export` passes `ExportUserData`'s JSON through (`auth/routes.ts:225-244`, `users/service.ts:362-365`) | F12 |
| R37, R38 | existing route, no change: `DELETE /auth/me` → `DeleteAccount`; the deletion is vertice-api's (API-F11) | — |
| E1 | `GET` → `{ text: "", updatedAt: null }` | — |
| E2 | `PUT` 400 `VALIDATION_ERROR` | F8 |
| E3, E24 | not exposed (web) | — |
| E4 | stored as written | F8 |
| E5 | `PUT` blank → empty state; `GET /clients` `hasAnamnese` false; notice `missing` | F8, F9 |
| E6 | `PUT` last write wins | — |
| E7 | CLIENT 403 by role | F7 |
| E8 | ADMIN 403 by role; nothing under `/api/admin` | F7 |
| E9, E10 | not exposed (upstream data model; not reachable in the product today, API-F1) | — |
| E11, E12 | notice route `present` / `missing` | F5 |
| E13, E14 | chat path reads per message (the saved text only) | F4 |
| E15, E25 | stream: the conflict line, separately from the R51 line | F6 |
| E16 | not exposed (vertice-ai prompt) | — |
| E17 | sent as written: the BFF never filters the text | F4 |
| E18, E23 | export pass-through | F12 |
| E19, E20 | `DELETE /auth/me`, no change | — |
| E21 | `GET /assistant/status` → `enabled: false` | — |
| E22 | `PUT` with no consent check | — |

## 3. Current state

**`clients` module** (`src/modules/clients/`, all three files plus `routes.test.ts`,
`schemas.test.ts`, `service.test.ts`):
- Plugin-level hooks `app.authenticate` then `app.requireRole('TRAINER')` (`routes.ts:17-20`).
- Every `/:id` route calls `assertIsTrainersClient` (`IsTrainersClient`, `service.ts:235-244`)
  before anything else. A former client is 403 `This client is not one of your clients`
  (`routes.ts:59-68`, `:87-91`).
- `GET /clients` builds `ClientSummary` field by field (`service.ts:130-142`). `suspended` is read
  from the raw `UserResponse` because `toUser` doesn't carry it (`service.ts:185-187`, `:229`).
  This is the precedent for a roster-only flag.

**`assistant` module** (`src/modules/assistant/`, `src/ai/`):
- `GET /assistant/status` answers `{enabled}` from one `EvaluateFeatureFlag` per request, always 200
  (`routes.ts:49-69`).
- `POST /assistant/workout-chat` checks the flag first, then the body. `buildChatContext`
  (`service.ts:83-132`) does `GetTrainingPlan` → `assertOwnsPlan` (plan-tree ownership only,
  so it **admits a former trainer**, API-F2) → optional `GetWorkout` → `ListExercises` pages in
  parallel with `ListWorkouts` (`:97`). It builds the vertice-ai body field by field, never
  `clientId`, the name or the e-mail (`:13-19`, `:108-130`; test `routes.test.ts:175-190`).
- `AiWorkoutChatRequest` (`ai/contract.ts:30-55`) mirrors vertice-ai's spec, which is the source
  of truth.
- The stream relay (`session.ts`):
  - a `text` event's `delta` is forwarded (`:179-185`), before or after a proposal, with no
    order check;
  - unknown events are dropped (`:224-226`);
  - the one log line per message carries ids, outcome, durations, counts and token usage only
    (`:252-263`).
- The OpenAPI text event says "append it to what came before" (`openapi/responses.ts:801-803`).

**gRPC.**
- `protos/vertice/**` is identical to the local vertice-api checkout at the pinned
  `f04f782…` (`protos/.api-ref`). `diff -r` is clean, and neither has an anamnese RPC or field
  (`grep -rn anamnes` finds nothing in `src`, `protos` or `docs`).
- `PROTO_FILES` is an explicit list (`grpc/loadProto.ts:9-25`), and `trainerClientClient` is the
  only `TrainerClientService` client (`grpc/clients.ts:25`).
- `UserResponse.suspended` is field 14 (`user.proto:138-140`).
- `mapGrpcError` maps PERMISSION_DENIED to `ForbiddenError` with the fixed message
  (`grpc/call.ts:168-169`). INVALID_ARGUMENT relays vertice-api's text (`:151-152`).

**Logging.** Request bodies are never logged:
- the request serializer keeps method and path only (`lib/log-serializers.ts:9-25`);
- the error handler logs only unhandled errors (`plugins/error-handler.ts:32`);
- `logUpstreamError` logs the RPC, the status and the redacted upstream text (`grpc/call.ts`).

**Tests.**
- 45 `*.test.ts` files.
- `route-authorization.test.ts` needs one entry per route.
- `fakeUpstream.ts` already has a former-trainer fixture: `planAForFormerClientB`, trainer A's plan
  for client B, who isn't on A's roster (`fakeUpstream.ts:129-141`).
- `isWriteRpc` is a verb regex (`fakeUpstream.ts:1303-1305`).

**Drift.** None found in `docs/api-contract.md` for the touched routes (`:146-152`, `:690`, `:708`).
Its line 708 ("Never the client's id, name or e-mail …") and the AI spec §3 "Never sent" have to
gain the anamnese (F11).

## 4. Findings by dimension

### 1. Upstream RPC readiness

**F1 (Blocker): the RPCs and the roster field are new on vertice-api**
- **What:** the routes need `GetClientAnamnese` and `SaveClientAnamnese` (a new
  `ClientAnamneseService` in `vertice.trainerclient.v1`, API assessment "New RPCs") and
  `UserResponse.has_anamnese` (field 15, set on `ListClientsForTrainer` only, API-F8). None of
  these is in vertice-api's protos or in this repo's copy today.
- **Where:** `protos/vertice/trainerclient/v1/`, `protos/vertice/user/v1/user.proto:120-140`,
  `grpc/loadProto.ts:9-25`, `grpc/clients.ts`; R1, R10–R21.
- **Why it matters:** the BFF routes can be spec'd now, but they can only be built and tested
  against `fakeUpstream.ts` until vertice-api merges. If the new service lives in its own `.proto`
  file, it needs a `PROTO_FILES` entry and a new client (`clientAnamneseClient`); without them
  the RPC is unreachable at boot.
- **Recommendation:**
  - The spec waits for the API proto to merge.
  - Then: bump `protos/.api-ref` to the merge SHA, run `npm run sync:protos`, add the file to
    `PROTO_FILES` and the client to `clients.ts`, and add it to CLAUDE.md's client list ("gRPC
    bridge").
  - Name the exact RPC and message names in the spec from the merged proto, not from this
    document.

**F2 (Blocker): vertice-ai must accept `anamnese` before the BFF sends it**
- **What:** vertice-ai's `WorkoutChatRequest` forbids unknown keys (`extra="forbid"`, API-F21), so
  a body with `anamnese` is a 400. The BFF maps that to `AI_ERROR` for **every** message, with or
  without an anamnese, since the BFF would always send the key when one exists.
- **Where:** `ai/contract.ts:30-55`, `assistant/service.ts:108-130`; R22, R40.
- **Why it matters:** a BFF deployed before vertice-ai breaks the assistant for every trainer whose
  client has an anamnese.
- **Recommendation:** vertice-ai deploys first, with an optional `anamnese` string capped at 5,000
  code points. The BFF's `AI_MAX_ANAMNESE` constant goes next to `AI_MAX_CATALOG`
  (`contract.ts:57-60`). The BFF's 5,000 UTF-16 units are never more than 5,000 code points, so
  anything the API stored passes. The field is omitted, not sent empty, when there is none.

### 2. Route and schema design

**F7 (Medium): the anamnese routes belong to `clients`, as resource routes**
- **What:**
  - `GET /clients/:id/anamnese` → `ClientAnamnese` `{ text: string, updatedAt: string | null }`.
    The empty state (E1) is `{ text: "", updatedAt: null }`, never a 404.
  - `PUT /clients/:id/anamnese` `{ text }` (`.strict()`) → the saved state, the same shape.
  - `PUT` and not `PATCH`: a save replaces the whole text (R13), and a blank one clears it (R19),
    so no `DELETE` route is needed.
  - Both follow the `/:id` pattern: `parseId` → `assertIsTrainersClient` → upstream call with the
    trainer's token. The API rule is still the authoritative one (API-F7).
- **Where:** new routes in `clients/routes.ts`, `clients/schemas.ts`, `clients/service.ts`;
  response schema in `openapi/responses.ts`; R1, R3, R4, R7, R10–R14, R19, R20.
- **Why it matters:** the BFF check before the call keeps a refused save from ever reaching a write
  RPC (what `route-authorization.test.ts` asserts, `:1629`). It also keeps the refusal message the
  roster routes already use. The API's own PERMISSION_DENIED (`ForbiddenError`) covers the race
  where the link ends between the two calls.
- **Recommendation:** these two routes, TRAINER only (inherited from the plugin hooks, so CLIENT
  and ADMIN are 403 by role), with `errors: [400, 403]` documented. Don't add the anamnese to
  `GET /clients/:id` or the overview: those are loaded on every visit to the client page, and the
  text is needed only on the tab.

**F8 (Medium): the schema must not trim, and the BFF doesn't decide what "blank" means**
- **What:** the house helpers `requiredText`/`boundedText` exist (`lib/validation.ts:15-28`).
  `requiredText` trims and refuses empty, which would break both R18/E4 ("saved as written") and
  R19 (a blank save clears).
- **Where:** new `clients/schemas.ts` schema; R10, R11, R18, R19, E2, E4, E5.
- **Why it matters:**
  - Trimming changes what the trainer wrote.
  - Refusing blank turns "clear" into a 400.
  - A BFF-side "blank" rule that differs from vertice-api's (API-F6: Unicode whitespace including
    U+00A0) gives two definitions of "has an anamnese".
- **Recommendation:**
  - `text: utf16String(ANAMNESE_MAX_LENGTH)`, with the constant 5,000 named once in the BFF and
    mirroring the API's.
  - Required, empty allowed, no `.trim()`.
  - The BFF sends the text as is and returns the state vertice-api answers; the API alone decides
    what is blank.
  - Schema tests at 5,000 and 5,001 units, including a non-BMP character counted as two.

### 3. Auth, roles, and ownership

Covered by F7 (route roles and `assertIsTrainersClient`) and F4/F5 (the AI paths). No new
`assertOwns*` helper is needed.
- The anamnese is keyed by the relationship, and "is this one of my clients" is exactly
  `IsTrainersClient`, which already refuses a former client.
- The notice route checks plan ownership with `assertOwnsPlan`, then derives the relationship from
  the roster (F5), so it never re-derives the link from plans.
- Suspended client (API Q3): `IsTrainersClient` and the roster keep a suspended client, so the
  trainer keeps access. That matches the API's assumption.
- ADMIN: no route outside `/api/admin` may add ADMIN (CLAUDE.md), and none is proposed. Nothing in
  `modules/admin` reads the anamnese (R4, E8).

### 4. Error mapping

No new status or code is needed. Checked: `grpc/call.ts:146-183`, `lib/errors.ts`.
- 400 `VALIDATION_ERROR`: the BFF's own bound (Zod), or upstream INVALID_ARGUMENT. Its relayed
  text is the property path plus message and never echoes the value (API §4 "Input and output
  handling").
- 403 `FORBIDDEN`: a former, foreign or missing client, from the BFF check or the API.
- A NOT_FOUND from upstream isn't expected (the empty state is a normal answer); if it ever comes,
  it maps to 404 as today.
- The chat path's handling of a refused read is F4: it is caught there, not mapped to a new code.
- No new `ERROR_CODES` entry, unless the spec gives the chat's failed read its own code (F4).

### 5. Backward compatibility

Everything is additive: two new routes, one new route on `assistant`, one new response field on
`GET /clients`, and one optional field on the `text` stream event (F6). No API versioning exists
(`grep -rn "api/v" src` finds nothing), so this is the whole picture:
- **An old web on the new BFF** ignores `hasAnamnese` and the new `text` field. With the F6
  recommendation it shows the R51 and conflict lines run together instead of on two lines.
  That is degraded, but nothing is lost, and the web deploys right after.
- **A new BFF on an old API:** proto3 defaults `has_anamnese` to `false`, so every roster entry
  would say "Sem anamnese", and the anamnese RPCs are UNIMPLEMENTED (502). So the API goes first,
  which is the default order.
- **A new BFF on an old vertice-ai:** see F2.

**F9 (Medium): `hasAnamnese` is set by one RPC only**
- **What:** `UserResponse.has_anamnese` is meaningful on `ListClientsForTrainer` only (API-F8), like
  `suspended`. `toUser` (`users/service.ts`) must not carry it, or a later route mapping a `GetUser`
  answer would read `false` as "no anamnese".
- **Where:** `clients/service.ts:185-187`, `:222-230`; `ClientSummary` (`:130-142`);
  `clientSummarySchema` (`openapi/responses.ts:443-465`); R21, E5.
- **Why it matters:** a field read from the wrong RPC fails silently as "Sem anamnese".
- **Recommendation:** map it exactly as `suspended` is mapped: a set built from
  `rosterRes.clients` beside `suspendedIds`, plus a `hasAnamnese: boolean` field described as
  "whether you wrote an anamnese for this client (R21)". Add a service test for true and false.

### 6. Composed/aggregate endpoint impact

**F5 (High): the AI panel's notice needs a route of its own**
- **What:** R25/R26 need, for the workout being edited:
  - whether this trainer has an anamnese of the plan's client;
  - the client's name (R25 names them; only vertice-ai is kept from the name, R24);
  - the client's id, for the R28 link.

  The former-trainer case (API-F2, Q1) needs a third answer, because the tab they would be sent
  to is 403 for them. The editor has only `trainingPlanId`. Composing this on the web means either
  the whole roster (`GET /clients`, which fans out `ListWorkoutLogs` per plan,
  `clients/service.ts:196-200`) or the full anamnese text plus `GET /clients/:id` (§5).
- **Where:** new route on `assistant`; R25, R26, R28, E11, E12.
- **Why it matters:**
  - Loading the health text into the editor page just to learn whether it exists is
    over-collection.
  - The roster is the heaviest composed read.
  - Without the third state, a former trainer is invited to fill in a tab they can't open.
- **Recommendation:** `GET /assistant/anamnese-notice?trainingPlanId=:id` (TRAINER) →
  `{ state: "present" | "missing" | "unavailable", client: { id, name } | null }`.
  - Built from `GetTrainingPlan` + `assertOwnsPlan`, then `ListClientsForTrainer`: find
    `plan.clientId` and read `name` and `has_anamnese`. A client not on the roster is
    `unavailable`, with `client: null`.
  - The anamnese text is never read.
  - The web calls it when the panel opens. It may refetch on window focus so the notice follows a
    save in the other tab; the message itself is always read fresh (F4).
  - Not flag-gated (Q3): it carries no AI data, and the web only renders it inside the panel.

**F10 (Low): the notice can disagree with what the next message sends**
- **What:** the notice is read when the panel opens, but the anamnese is read on each message. If
  the trainer clears it in another tab, the panel can still say "A IA usa a anamnese" while
  nothing is sent.
- **Where:** F5's route vs `buildChatContext`; R25, R29, E13.
- **Why it matters:** the notice is misleading only until the next refetch; the AI behaviour is
  right (R29).
- **Recommendation:** refetch on focus (web), or accept the gap. Optionally, the `done` event could
  later say whether an anamnese was used. Not proposed now: it is a contract change for a cosmetic
  gain.

The other composed endpoints (`GET /clients/:id/overview`, `GET /workouts/:id/full`, the session,
`GET /dashboard`) are unaffected. Checked their service functions: none renders client
background.

### 7. Performance

- **Chat:** one extra primary-key gRPC read per message (`GetClientAnamnese`), issued in parallel
  with `loadCatalog()`/`listWorkouts()` (`assistant/service.ts:97`). That is noise next to the 5+
  catalog pages and the per-exercise `ListExerciseSets` fan-out.
- **Roster:** no extra call. The flag rides on `ListClientsForTrainer`, and the API computes it in
  one query (API-F13).
- **Notice route:** two calls (`GetTrainingPlan`, `ListClientsForTrainer`) per panel open.
- No pagination is involved. `page_size` exists only on exercises and the admin lists, and neither
  is touched.

### 8. Security and privacy

**F4 (High): the chat path's anamnese read — refused, failed, fresh, and only the text**
- **What:**
  - **The read and its key.** After `assertOwnsPlan`, read `GetClientAnamnese` for `plan.clientId`
    with the trainer's own token. Never use `asService`: the service subject isn't allowed and
    must not be (CLAUDE.md "Trust model").
  - **A refused read.** A former trainer passes `assertOwnsPlan` (plan-tree), but the read is
    PERMISSION_DENIED (R7). `grpcCall` turns that into a `ForbiddenError` (`call.ts:168-169`). If
    it is not caught at this call site, it becomes a 403 for the whole message, and the assistant
    stops working for former trainers, which it does today.
  - **Any other failure.** UNAVAILABLE, a timeout or a 502 must not be treated as "no anamnese".
    That would send a message without it while R22 says every message carries it, and the panel
    (F5) says the AI uses it.
  - **Only the text.** The text goes into the body, whatever it contains (E17). It goes nowhere
    else: no header, no `x-request-id`, no log field.
- **Where:** `assistant/service.ts:83-132`; `ai/contract.ts:30-55`; `assistant/session.ts:252-263`
  (the log line); R7, R22, R24, R27, R29, E13, E14, E17.
- **Why it matters:**
  - Catching too much silently breaks R22.
  - Catching too little breaks the chat for former trainers.
  - Logging any of it puts art. 11 health data into 30-day logs.
- **Recommendation:**
  - Run the read in the existing `Promise.all`.
  - Catch only `ForbiddenError` from this call and treat it as "omit the field".
  - Let every other error throw, so the message fails before the stream with the normal mapped
    status (Q2).
  - Leave `anamnese` out of the body when the text is empty or the read was refused.
  - No cache of any kind (R29).
  - The log line may gain `anamnese: "sent" | "none" | "refused"` (an enum, never the text or a
    prefix).
  - Extend the R13 test: assert the anamnese is the only client-derived text in the body, that no
    log line captured during the test contains it, and that the former-trainer fixture
    (`planAForFormerClientB`) gets a normal stream with no field.

**F11 (Medium): logs, LangSmith and the documented "what reaches vertice-ai"**
- **What:**
  - Nothing in the BFF logs request or response bodies today (§3). The new paths that touch the
    text are the `PUT` handler, the `GET` handler, the chat context and any `catch`, and none may
    add a log of it.
  - A Zod error on `PUT` returns `{formErrors, fieldErrors}` with messages only, never the value
    (`plugins/error-handler.ts:18-22`).
  - The BFF has no LangSmith connection. vertice-ai's boot guard hides inputs and outputs when
    tracing is on outside dev (API §4.11 "LangSmith"), so the only thing the BFF controls there is
    to send nothing beyond the body. Trace metadata (presence, length, ids) is vertice-ai's to set.
  - `docs/api-contract.md:708` and the AI spec §3 say what reaches vertice-ai and must now name the
    anamnese (R40).
- **Where:** new `clients` handlers; `assistant/service.ts`; `docs/api-contract.md:708`;
  `docs/specs/ai-workout-assistant/spec.md` §3; R33, R40.
- **Why it matters:** the PRD's launch condition (R33) depends on the documents matching what the
  code sends.
- **Recommendation:**
  - One audit-style INFO line per save, `audit: "client.anamnese.save"`, with `actorId`,
    `clientId` and `outcome: "saved" | "cleared"`, mirroring `client.cpf.reveal`
    (`clients/routes.ts:64-66`). The API already logs the same event (API-F16); the spec decides
    whether both are wanted.
  - No line for reads.
  - Update both documents in the BFF PR.

**F3 (High): the deploy order is the launch control**
- **What:**
  - The PRD ships with no switch of its own (§6).
  - `AI_ASSISTANT_ENABLED` is already on for trainers.
  - Every merge to `main` auto-deploys (CLAUDE.md, "On pushes to main").

  So the first BFF deploy with the chat change starts sending client health text to Anthropic, and
  the first with the routes lets the web store it.
- **Where:** R33, PRD §6; API-F17.
- **Why it matters:** R33 says the inventory and the privacy text must be live **before** the
  feature reaches trainers, and nothing in the BFF can hold it back afterwards.
- **Recommendation:** the BFF PR's "Merge and deploy order":
  1. vertice-api, with the inventory;
  2. the privacy text in vertice-web-react;
  3. vertice-ai;
  4. vertice-bff;
  5. the web tab, badge and panel.

  If the AI side (vertice-ai's prompt and the F6 line, gated on #39/#41 per API-F20) lags, split
  the BFF work into two PRs: the routes and roster first, the chat change and stream after.
  Rollback goes in reverse. Rolling back the BFF alone stops sending the anamnese and hides the
  routes, which is safe.

**Enumeration and free text (Info).**
- The new routes take a client id in the path, and the answer for a foreign, former or missing id
  is the same 403. That is no oracle beyond the existing `/clients/:id`.
- The text is free text the web renders back into a textarea; the BFF doesn't sanitize (none of
  its free-text fields are) and must not alter it.
- The text goes to the browser only on the tab's `GET`.

### 9. Testing

**F12 (Info): export and deletion need no BFF change, but the contract text does**
- **What:** `GET /auth/me/export` returns `ExportUserData`'s JSON untouched (`users/service.ts:362-365`),
  so the new `anamneses` section (API-F12) reaches the user with no code change. The same holds for
  deletion through `DELETE /auth/me`.
- **Where:** `auth/routes.ts:225-244`; R35–R38, E18–E20, E23.
- **Why it matters:** a trainer's export is now larger (up to ~15 KB per anamnese). The route
  already maps the API's bound to 413 `TOO_LARGE`, and grpc-js's 4 MiB receive limit sits above
  the API's 3 MB.
- **Recommendation:** nothing in code. If `docs/api-contract.md`'s export entry describes the
  contents, note that a trainer's export now includes the anamneses of current clients.

**F13 (Medium): the fake upstream's write detector won't recognize `Save*`**
- **What:** `isWriteRpc` is a verb regex
  (`^(Create|Update|Delete|Remove|Set|Clone|Replace|Record|Complete|Submit|GetOrStart|End|Restart|Discard|Start|Verify|Issue|Reset|Suspend|Reactivate|Send|Promote|Rename)`,
  `fakeUpstream.ts:1303-1305`). `SaveClientAnamnese` doesn't match.
- **Where:** `src/test/fakeUpstream.ts:1303-1305`; used by `route-authorization.test.ts:1629` and
  `validation-routes.test.ts:30`.
- **Why it matters:** a refused or invalid `PUT` that still reached the save RPC would pass both
  suites. Those suites are the guard for R3, R4 and R7 on this route.
- **Recommendation:** add `Save` to the regex and an `isWriteRpc('SaveClientAnamnese')` case to the
  existing `describe('isWriteRpc')` (`route-authorization.test.ts:1642-1647`). Also add fake
  handlers for both RPCs that mirror the API rule: active pair only, PERMISSION_DENIED otherwise,
  blank clears. Add `has_anamnese` to the fake `ListClientsForTrainer` (`fakeUpstream.ts:1271-1275`).

Test scenarios are in §6.

### 10. Documentation

- `docs/api-contract.md`:
  - the generated route reference (`npm run openapi`);
  - prose for the three routes and `hasAnamnese`;
  - line 708 (F11);
  - the stream table's `text` row (F6).
- `docs/specs/ai-workout-assistant/spec.md`: §3 "Never sent" and the stream order (F6). It is
  this repo's own spec; the client-anamnese spec says which lines it amends.
- `CLAUDE.md`:
  - the new gRPC client in the "gRPC bridge" list;
  - the "AI workout assistant" paragraph: the anamnese read, the refused-read rule, still "never
    log …";
  - the module layout line for `clients` and `assistant`.
- Add an inline comment at the chat read explaining why PERMISSION_DENIED is "none", as other
  upstream workarounds are commented (the plan-tree access a former trainer keeps).

### 11. Effort, risk, and dependencies

See §8.

**F6 (High): R31's two separate lines need a boundary on the stream**
- **What:**
  - A proposal turn is `stage+ proposal [text] done`; the `text` after it is "R51's one line"
    (`docs/specs/ai-workout-assistant/spec.md` §5).
  - R30/R31/E25 add a second line (the conflict), shown **separately** from R51's, and R31 also
    allows it after AI-R30's message when there is no proposal.
  - `text` events are deltas the web is told to append (`openapi/responses.ts:801-803`), so two
    `text` events render as one run of text.
  - The BFF forwards only `delta` (`session.ts:184`) and drops unknown event types (`:224-226`),
    so vertice-ai can't add a marker that reaches the web without a BFF change.
- **Where:** `assistant/session.ts:179-185`, `:224-226`; `openapi/responses.ts:801-803`; AI spec
  §5; R30, R31, E15, E25; API-F19.
- **Why it matters:** without a boundary the two lines merge (R31 broken). A new event type would
  be dropped silently by this BFF and by any web build that predates it (R30 broken).
- **Recommendation:** keep the `text` event and add an optional `line` field:
  - `{ delta, line?: "left_out" | "anamnese_conflict" }`;
  - each such line is one complete `text` event;
  - R51's line comes first, then the conflict line;
  - plain answer text has no `line`.

  The BFF validates `line` against the known values, drops an unknown one (it keeps `delta`, so
  older builds degrade to merged text, never to lost text), and relays it. It also allows at most
  one event per `line` value. vertice-ai's spec owns the wire shape; this is the BFF's preferred
  option (Q4).

## 5. Options

The real choice is how the AI panel gets R25/R26's data (F5).

| Option | Description | Calls per panel open | Trade-off |
|---|---|---|---|
| A | Web composes from `GET /training-plans/:id` (`clientId`) and `GET /clients` (name, `hasAnamnese`); "not on the roster" = unavailable | 2 BFF routes; the roster fans out `ListWorkoutLogs` per plan | No new route, but the heaviest read on every panel open |
| B | Web calls `GET /clients/:id/anamnese` and `GET /clients/:id`; a 403 = unavailable | 3 BFF routes (plan, anamnese, client) | No new route, but the full health text and the client's e-mail/masked CPF reach the editor page for a boolean and a name; a 403 is used as a state |
| C | New `GET /assistant/anamnese-notice?trainingPlanId=` → `{state, client}` | 1 BFF route (2 gRPC: `GetTrainingPlan`, `ListClientsForTrainer`) | One small route and response schema; reads no text |

Recommendation: **C**. It is the minimum data for the job (no text and no e-mail on the editor
page), it costs one round trip, and it names the former-trainer state explicitly instead of
inferring it from a 403.

## 6. Testing strategy

**Schemas** (`clients/schemas.test.ts`, which exists):
- `text` of 0, 5,000 and 5,001 UTF-16 units;
- a non-BMP character counted as two;
- whitespace-only accepted and passed through untrimmed;
- leading and trailing spaces kept;
- a missing `text` and an extra key refused (`.strict()`).

**Clients service** (`clients/service.test.ts`, which exists):
- `hasAnamnese` true and false from `has_anamnese`, independent of `suspended`;
- `GET` maps the empty state to `{ text: "", updatedAt: null }`;
- `PUT` returns the state upstream answers (a blank save returns the empty state).

**Route authorization** (`src/test/route-authorization.test.ts`, one entry per new route):
- each route: 401 without a token; CLIENT and ADMIN 403 by role;
- `GET`/`PUT /clients/:id/anamnese` for `clientB` (another trainer's client): 403, with no write
  RPC reached;
- the notice route for `planB` (another trainer's plan): 403;
- `planAForFormerClientB` answers 200 `unavailable`;
- `isWriteRpc('SaveClientAnamnese')` (F13).

**Assistant** (`assistant/routes.test.ts`, which runs a stub vertice-ai over real HTTP):
- the body carries `anamnese` when it exists and omits it when it is empty;
- the former-trainer plan streams normally with no field (F4);
- a read failing with UNAVAILABLE fails the message before the stream, and vertice-ai is never
  called;
- two messages around a save carry the old text, then the new one (R29, E13);
- the extended R13 test: the anamnese is the only client-derived text, and no captured log line
  contains it (F4, F11);
- the notice route: `present`, `missing`, `unavailable`.

**Stream** (`assistant/session.test.ts`):
- `text` with `line: "left_out"` then `"anamnese_conflict"` after a proposal, relayed in order;
- an unknown `line` value dropped while `delta` is kept;
- a repeated `line` value handled as the spec decides (F6).

**Contract:** `ai/contract.ts` gains the field and the cap. `openapi/responses.ts` compile-time
`SameShape` checks cover `ClientAnamnese`, the notice and the new `ClientSummary` field;
`npm run openapi -- --check` runs in CI.

## 7. Rollout

- **Order:** vertice-api (RPCs, `has_anamnese`, inventory) → vertice-web-react privacy text (R33)
  → vertice-ai (`anamnese` field, prompt, conflict line) → **vertice-bff** → vertice-web-react tab,
  badge and panel (F3).
  - The BFF can't ship before the API: UNIMPLEMENTED, and every roster entry would read
    "Sem anamnese".
  - The chat change can't ship before vertice-ai (F2).
  - The routes, roster and notice can ship before vertice-ai if the PR is split (F3).
- **Proto sync** in the BFF PR: `protos/.api-ref`, `npm run sync:protos`, `PROTO_FILES`, the new
  client (F1).
- **Old web on the new BFF:** works. New fields are ignored, and the two lines merge until the web
  ships (§4.5).
- **Docs** in the same PR: `docs/api-contract.md` (generated block plus prose, line 708, the
  stream), the AI spec's §3 and §5 notes, CLAUDE.md (§4.10).
- **After deploy:**
  - save and clear for a test client, and check `hasAnamnese` on `GET /clients`;
  - open the panel for a current and a former client's plan;
  - send one chat message and check the BFF log line has the enum and no text;
  - check that `done`'s input tokens rose by about the expected amount.
- **Rollback:** reverting the BFF stops sending the anamnese and removes the routes; stored data is
  untouched.

## 8. Effort and risk

**Size: M.**
- Three new routes: two on `clients`, one on `assistant`.
- One additive roster field.
- One change in the chat context.
- One optional stream field.
- A contract mirror, fake-upstream handlers and the docs.

Every piece has a precedent: the `/:id` pattern, `suspended`, `buildChatContext`'s parallel reads,
and the event relay.

**Dependencies:**
- **vertice-api first** (F1). Its RPCs gate building and testing anything but the fake.
- **vertice-ai first for the chat slice** (F2). vertice-ai's own readiness for R23/R30 is gated on
  its prompt (#39) and eval (#41) work (API-F20). That is the likeliest delay, so plan the BFF as
  two PRs if the AI side lags:
  1. routes, roster and notice (R1–R21, R25–R28), useful to the web on their own;
  2. the chat read and the `line` field (R22, R24, R29–R31).
- **R33 before either PR deploys** (F3).

## 9. Questions and assumptions

None of these could be put to the owner during this run. Each has an assumption for the spec to
use.

- **Q1.** What does the panel show a former trainer (assistant open on a former client's plan)?
  - **Assumption:** the notice route answers `unavailable`, and the web shows neither R25's line
    nor R26's link. The chat works without an anamnese (R27). The copy, if any, is the web's
    (API Q1).
- **Q2.** When the anamnese read fails for a reason other than a refusal (vertice-api unavailable,
  timeout), does the message fail or go without it?
  - **Assumption:** it fails before the stream with the normal mapped status (503
    `UPSTREAM_UNAVAILABLE` / 502). Sending without it would break R22 while the panel says the AI
    uses it.
- **Q3.** Should the notice route be gated on the AI flag?
  - **Assumption:** no. It carries no AI data, and the web only calls it inside the panel, which
    exists only when the flag is on.
- **Q4.** What shape do R31's separate lines take on the wire?
  - **Assumption:** the `text` event gains an optional `line: "left_out" | "anamnese_conflict"`,
    one complete line per event, R51's first. vertice-ai's spec has the final word, and the BFF
    mirrors it (F6).
- **Q5.** Does `PUT /clients/:id/anamnese` answer 200 with the saved state or 204?
  - **Assumption:** 200 `{ text, updatedAt }`, so the tab can show "Atualizada em" (R14) without a
    second read. This needs `SaveClientAnamnese` to return the state, as the API assessment implies.
- **Q6.** Should the BFF log saves (`audit: "client.anamnese.save"`) when vertice-api already does
  (API-F16)?
  - **Assumption:** yes, ids and outcome only, like `client.cpf.reveal`.

## 10. Inputs to the spec

- [ ] F1: the exact RPC and message names from the merged vertice-api proto, the proto-sync step,
      the `PROTO_FILES` entry and the new client.
- [ ] F2: vertice-ai's optional `anamnese` field and cap, mirrored in `ai/contract.ts`; vertice-ai
      deploys before the chat change.
- [ ] F3: the "Merge and deploy order" with R33 first, and whether the BFF work ships as one PR or
      two.
- [ ] F4: the chat read (fresh, parallel, the trainer's token), only `ForbiddenError` means "omit",
      other errors fail before the stream, the log enum, no text anywhere but the body.
- [ ] F5: the notice route's path, response shape and three states, built from the roster RPC
      (option C).
- [ ] F6: the wire shape for the R51 and conflict lines and the BFF's validation and order rules.
- [ ] F7: `GET`/`PUT /clients/:id/anamnese`, the `ClientAnamnese` shape and the empty state.
- [ ] F8: `utf16String(5000)`, no trim, empty allowed, the API decides blank.
- [ ] F9: `hasAnamnese` mapped from `ListClientsForTrainer` only, like `suspended`.
- [ ] F11: the save audit line, the api-contract and AI spec updates naming the anamnese.
- [ ] F13: `Save` in `isWriteRpc`, fake handlers, and `has_anamnese` in the fake roster.
