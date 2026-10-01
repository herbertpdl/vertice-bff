# Spec: Starter exercise catalog (BFF)

Status: Draft
Owner: hebertpdl@gmail.com
Related: [vertice-api/docs/prds/exercise-starter-catalog/prd.md](https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/exercise-starter-catalog/prd.md)
(product rules R1–R59, E1–E23 — this document does not restate them; there is no BFF PRD),
[vertice-api/docs/assessments/exercise-starter-catalog/assessment.md](https://github.com/herbertpdl/vertice-api/blob/main/docs/assessments/exercise-starter-catalog/assessment.md),
[vertice-api/docs/specs/exercise-starter-catalog/spec.md](https://github.com/herbertpdl/vertice-api/blob/main/docs/specs/exercise-starter-catalog/spec.md)
(the upstream gRPC contract this bridges — **not on `main` yet**, being written in the same run),
[vertice-web-react/docs/specs/exercise-starter-catalog/spec.md](https://github.com/herbertpdl/vertice-web-react/blob/main/docs/specs/exercise-starter-catalog/spec.md)
(the web spec consuming the endpoints below — **not on `main` yet**, same run),
`docs/assessments/exercise-starter-catalog/assessment.md` (this repo's assessment, F1–F17, Q1),
`docs/api-contract.md` (updated by this change), `docs/specs/create-workout-with-exercises/spec.md`
(touched: its `POST /training-plans/:planId/workouts` and `PUT /workouts/:workoutId/exercises`
responses embed the `Exercise` shape that changes here), `verification.md` next to this file.

This BFF change does three things: it forwards the caller's own JWT to `vertice-api` as gRPC
metadata on every upstream call (so upstream can finally know who is calling); it moves the
`exercises` module onto the new `ExerciseService` contract (multi-group exercises, a starter-set
flag, a muscle-group list, server-side filter/search, and the role gates the PRD requires); and
it documents the 403s that appear on the workout-side endpoints once upstream enforces R17–R19.
The BFF deliberately owns none of the rules: visibility, ownership, the starter-set refusals, the
in-use delete refusal, ordering and search semantics all live in `vertice-api` and are relayed
here with a usable status code. In particular, **no exercise-ownership check is written in this
repo** (§0, D10) — a reader who expects an `assertOwnsExercise` next to `assertOwnsWorkout`
should read that decision before adding one.

## 0. Scope decisions

No owner was available when the cross-repo contract brief was written. **Every decision below
that cites a `D<n>` is assumed in the absence of the owner; it is the assessment's
recommendation where one was made, otherwise the orchestrator's best judgment.** The hand-over
lists them for the owner to overturn before implementation starts. Decisions with no `D<n>` are
this spec's own design choices inside the space the brief leaves open.

- **Base branch.** This spec is written against `feat/create-workout-with-exercises` (the
  exemplar spec's branch), which is not on `main` yet. It relies on things that branch adds:
  `PreconditionFailedError`, the exported `mapGrpcError`, `src/grpc/call.test.ts`,
  `src/modules/workouts/schemas.test.ts`, and `PUT /workouts/:workoutId/exercises`. That PR must
  merge before PR1 here opens; nothing below is written twice.
- **D1 — identity crosses the boundary as the caller's own BFF JWT, on every upstream call
  (Increment 0).** `vertice-api` will verify it with the shared HS256 `JWT_SECRET` and read
  claims `id` and `role`. This repo's part is purely mechanical: attach
  `authorization: Bearer <token>` as gRPC metadata. Assumed (api Q3's recommendation; bff F15).
- **How the token reaches `grpcCall`: an `AsyncLocalStorage` request context, not an explicit
  parameter.** The alternative — a `metadata`/`ctx` argument threaded through every service
  function — was rejected because there are 45 `grpcCall` sites across 9 service files, the
  composed endpoints (`getFullWorkout`, `getWorkoutSession`, the `clients` roster, `dashboard`)
  chain four to six service functions each, and `src/lib/ownership.ts` calls services from
  outside any module; every signature in the repo would gain a parameter that carries no
  business meaning. The token is request-scoped ambient data, which is exactly what Node's
  `AsyncLocalStorage` (`node:async_hooks`) exists for and what `@fastify/request-context` is
  built on. Implemented directly (one hook, one small module) rather than adding that
  dependency. Cost: implicit — a `grpcCall` made outside a request (there are none today; no
  background jobs) silently goes anonymous. The `call.test.ts` cases in §5 pin both branches
  ("context with token → header present", "no context → no header") so the wiring is proven,
  not trusted. `src/modules/**` and `src/lib/ownership.ts` are untouched by Increment 0, which
  verification.md checks with a diff.
- **Only a token `app.authenticate` has verified is forwarded.** The context is created empty
  in an `onRequest` hook; `app.authenticate` fills it after `verifyToken` succeeds. `/health`,
  `POST /api/auth/login` and `POST /api/auth/register` therefore call upstream anonymously, as
  they do today — a stale `Authorization` header a web client may still send to `/auth/login`
  is never relayed, so a login cannot fail because of an expired token. Consequence worth
  stating: under the `local` profile this is fine (brief D1: token optional there). Under a
  non-local profile `vertice-api` requires authentication on *every* RPC, so `login`'s
  `ListUsers` and `register`'s `CreateUser` cannot succeed — that is exactly today's situation
  (nothing is forwarded today either) and is out of scope here; recorded in §7 as a follow-up
  for a BFF service credential.
- **`.env.example` gets `JWT_SECRET=dev-secret-change-me`.** CLAUDE.md's setup is
  `cp .env.example .env`, and `.env.example` currently says `change-me-in-production`, which is
  not the `dev-secret-change-me` default the brief fixes on both sides for local. A developer
  following CLAUDE.md would mint tokens `vertice-api` rejects the day it starts verifying them.
  The line gets a comment that the value must equal `vertice-api`'s `JWT_SECRET`.
- **D2 — cross-trainer / wrong-role refusals are `PERMISSION_DENIED` → 403 `FORBIDDEN`; a
  missing id stays 404.** No BFF code: `mapGrpcError` already has the branch (assessment F10).
  Existence of an id is revealed to a refused caller; accepted per the PRD's "refused, not
  merely absent". Assumed.
- **D3 / D4 — starter-set refusals are 403 `FORBIDDEN` and the in-use delete refusal is 409
  `PRECONDITION_FAILED`, upstream messages verbatim.** Both branches exist in `call.ts`; no new
  `HttpError` subclass. The web tells "cannot be edited, ever" (403) from "cannot be deleted
  right now" (409) by status alone. Assumed.
- **D5 — role gates.** `GET /exercises` gains `requireRole('TRAINER','ADMIN')` (closes
  assessment F5 for R21). `POST/PATCH/DELETE /exercises[/:id]` narrow from
  `('TRAINER','ADMIN')` to `('TRAINER')` — the platform team has no exercise-management surface
  (PRD §6, R37), so ADMIN gets no write path. `GET /exercises/:id` stays authenticate-only and
  lets upstream decide, because a CLIENT reaching an exercise inside their own workout is
  legitimate (R20/R22) and only upstream can tell. Assumed.
- **D6 — muscle groups are `{id, name}` rows from `ExerciseService.ListMuscleGroups`, exposed
  as `GET /api/muscle-groups`.** Overrides this repo's assessment Q1 ("static list in the web"):
  ids are database-generated, so a static list would have to hardcode ids too. Assumed.
- **`GET /api/muscle-groups` is a second route plugin exported from the `exercises` module,
  mounted at `/muscle-groups` from `app.ts` — not a new module.** The RPC is on
  `ExerciseService` (`exerciseClient`), which by this repo's "one service file per upstream
  gRPC service" split puts `listMuscleGroups()` in `exercises/service.ts`; the `MuscleGroup`
  type is needed by `Exercise` anyway; there is no request schema. A `muscle-groups` module
  would be a one-route `routes.ts` importing everything from `exercises` and one more entry in
  CLAUDE.md's layout for nothing. Precedent: `workouts/routes.ts` and `workout-sessions/routes.ts`
  already export several plugins mounted at different prefixes. The path is fixed by the brief
  because `/api/exercises/muscle-groups` would collide with `/api/exercises/:id`.
- **D9 — the `Exercise` shape break (`muscleGroup: string` → `muscleGroups: {id,name}[]` plus
  `isStarter`) and the `GET /exercises` behavior break (unfiltered → scoped) are accepted
  without versioning.** No `/api/v*` exists (assessment F11); the only consumer is
  `vertice-web-react`, whose `WorkoutExerciseCard` reads `exercise.exercise.muscleGroup` today
  and breaks at PR2. Increment 1 is a coordinated deploy api → bff → web in one window (§6).
  Assumed.
- **D10 — no `assertOwnsExercise` is written in this repo, and `POST /workouts/:workoutId/exercises`
  gains no `exerciseId` check. This is deliberate; do not "fix" it.** The assessment (F6, F7)
  recommended a BFF-side exercise-ownership check written as an exception to the ADMIN-bypass
  convention. The brief settles R16/R17/R22/R32/R36 differently: with the caller's identity
  forwarded (D1), `vertice-api` is the single enforcer of exercise visibility on `GetExercise`,
  `UpdateExercise`, `DeleteExercise` (Increment 1) and on `CreateWorkoutExercise`,
  `CreateWorkoutWithExercises`, `ReplaceWorkoutExercises`, `CloneWorkout` (Increment 2). A BFF
  copy would be a second implementation of the same rule with its own ADMIN semantics to get
  wrong, and it would cost one extra `GetExercise` per attached exercise. The existing
  `assertOwnsPlan`/`assertOwnsWorkout`/`assertOwnsWorkoutExercise` stay exactly as they are,
  ADMIN bypass included: they guard plan/workout ownership, which is not the rule R25 is about.
  Accepted consequence: an ADMIN can no longer add exercises to, replace the exercises of, or
  clone a trainer's workout (upstream refuses: they are not the plan's trainer), and an ADMIN
  opening `GET /workouts/:id/full` on a workout that contains a trainer's private exercise gets
  403 from the embedded `GetExercise`. There is no product surface for any of those. Assumed.
- **Query parameters on `GET /exercises`: `muscleGroupId` and `q`, empty string treated as
  absent.** The brief's own path template is `?muscleGroupId=&q=`, so a web client will send
  empty values literally; treating `""` as "no filter" avoids a 400 on the default screen.
  Forwarded as `muscle_group_id` (0 when absent) and `search` (`''` when absent). The response
  is returned **in upstream order, not re-sorted and not re-filtered** — R48–R50's ordering is
  upstream's contract and the web relies on it (D17). Follows the `GET /training-plans?clientId=`
  idiom (assessment F4).
- **`muscleGroupIds` duplicates are de-duplicated by the Zod schema, not rejected, preserving
  first occurrence.** The brief leaves this to the BFF. The web's MultiSelect cannot produce
  duplicates, so a 400 would describe a state the UI cannot reach; upstream de-dups too. Order
  is preserved as sent; it carries no meaning upstream, since a trainer-created exercise has no
  primary group (§7).
- **Zod mirrors upstream's length limits (`name` ≤255, `description` ≤255, `videoUrl` ≤500,
  `q` ≤100, `muscleGroupIds` ≥1) purely fail-fast.** Upstream is authoritative and rejects them
  too (`INVALID_ARGUMENT` → 400). Duplicating the numbers is accepted for the same reason the
  exemplar duplicates the 20/10 caps: a Zod 400 carries a `details` object the web can attach to
  a field. Not mirrored: "name must not be blank after trim" (a `"   "` name passes `min(1)` and
  gets upstream's `name: must not be blank` as a flat 400), the `^https?://\S+$` URL rule
  (Zod's `.url()` is looser), and "every group id must exist" — all upstream-only.
- **Composed endpoints change shape without code change.** `getFullWorkout` embeds
  `exerciseService.Exercise` per workout exercise (`src/modules/workouts/service.ts`), and
  `getWorkoutSession`, `createWorkout` and `replaceWorkoutExercises` all return `getFullWorkout`'s
  output — so `GET /workouts/:id/full`, `POST /training-plans/:planId/workouts`,
  `PUT /workouts/:workoutId/exercises` and `GET /workouts/:workoutId/session` all carry the new
  `Exercise` automatically. Audited (assessment F12): no other module reads `exerciseService`.
  The proof that the embedded shape is right is the `toExercise` mapper test (§5), since the
  composition is a pass-through.
- **Assessment findings.** F1 (High, upstream unshipped): the delivery plan gates PR2 on the
  whole Increment 1 `ExerciseService` contract being on `vertice-api` `main`. F5, F6, F7 (High):
  resolved by D5 and D10 above. F11 (High): D9. F16 (High): PR2 adds the module's first tests
  (§5). F3, F4, F12, F17 (Medium): resolved in PR2 as described. F15 (Medium): resolved by
  Increment 0. F2, F8, F9, F10, F13, F14: nothing to do, confirmed against the code.
- **Route-level tests use `buildApp()` + `app.inject` and only cover paths that stop before any
  gRPC call** (role gates, missing token, Zod rejections). `buildApp()` loads the protos and
  constructs clients without connecting, so this needs no upstream and no mocking. Anything
  that reaches upstream is verified end-to-end in verification.md, not unit-tested here.

## 1. Proto sync

`protos/vertice/exercise/v1/exercise.proto` is replaced with the brief's block below (it will
match [vertice-api/src/main/proto/vertice/exercise/v1/exercise.proto](https://github.com/herbertpdl/vertice-api/blob/main/src/main/proto/vertice/exercise/v1/exercise.proto)
once the upstream Increment 1 PRs merge; today the two files are identical to each other and
both still carry the 7-value enum). The diff against today's copy:

- new RPC `ListMuscleGroups`, new messages `MuscleGroupResponse`, `ListMuscleGroupsRequest`,
  `ListMuscleGroupsResponse`;
- `ExerciseResponse`: field 5 `muscle_group` retired (`reserved 5; reserved "muscle_group";`),
  new `repeated MuscleGroupResponse muscle_groups = 6`, new `bool is_starter = 7`;
- `ExerciseRequest`: field 4 retired the same way, new `repeated int64 muscle_group_ids = 5`;
- `ListExercisesRequest`: new `int64 muscle_group_id = 1`, `string search = 2`;
- `enum MuscleGroup` deleted.

No change to `PROTO_FILES` in `src/grpc/loadProto.ts` (the file is already listed) and none to
`src/grpc/clients.ts` (all RPCs are on the existing `exerciseClient`). With the loader's
`longs: String`, `int64` ids arrive as strings and are converted with `Number()` in the mapper
as every other module does; the loader's `enums: String` option is unaffected — this file
simply has no enum any more, so nothing in the module depends on enum names.

```proto
syntax = "proto3";

package vertice.exercise.v1;

import "google/protobuf/empty.proto";

option java_package = "com.vertice.api.generated.grpc.exercise.v1";
option java_multiple_files = true;

service ExerciseService {
  rpc ListMuscleGroups(ListMuscleGroupsRequest) returns (ListMuscleGroupsResponse);
  rpc ListExercises(ListExercisesRequest) returns (ListExercisesResponse);
  rpc GetExercise(GetExerciseRequest) returns (ExerciseResponse);
  rpc CreateExercise(ExerciseRequest) returns (ExerciseResponse);
  rpc UpdateExercise(UpdateExerciseRequest) returns (ExerciseResponse);
  rpc DeleteExercise(DeleteExerciseRequest) returns (google.protobuf.Empty);
}

message MuscleGroupResponse {
  int64 id = 1;
  string name = 2;
}

message ListMuscleGroupsRequest {
}

message ListMuscleGroupsResponse {
  repeated MuscleGroupResponse muscle_groups = 1;
}

message ExerciseResponse {
  reserved 5;
  reserved "muscle_group";
  int64 id = 1;
  string name = 2;
  string description = 3;
  string video_url = 4;
  repeated MuscleGroupResponse muscle_groups = 6;
  bool is_starter = 7;
}

message ExerciseRequest {
  reserved 4;
  reserved "muscle_group";
  string name = 1;
  string description = 2;
  string video_url = 3;
  repeated int64 muscle_group_ids = 5;
}

message ListExercisesRequest {
  int64 muscle_group_id = 1;
  string search = 2;
}

message ListExercisesResponse {
  repeated ExerciseResponse exercises = 1;
}

message GetExerciseRequest {
  int64 id = 1;
}

message UpdateExerciseRequest {
  int64 id = 1;
  ExerciseRequest exercise = 2;
}

message DeleteExerciseRequest {
  int64 id = 1;
}
```

The identity metadata (Increment 0) needs no proto: it is the gRPC metadata key `authorization`
with value `Bearer <the caller's BFF JWT>` on every call, from every client in `clients.ts`.
Upstream reads claims `id` (numeric user id) and `role` (`ADMIN` | `TRAINER` | `CLIENT`) —
exactly what `signToken` in `src/lib/jwt.ts` already puts in the token.

Increment 2 changes no proto: `vertice/plan/v1/workout.proto` and
`vertice/plan/v1/workout_exercise.proto` stay as they are.

## 2. Endpoints

Shared response types (exported from `src/modules/exercises/service.ts`):

```ts
MuscleGroup = { id: number, name: string }
Exercise    = { id: number, name: string, description: string, videoUrl: string,
                muscleGroups: MuscleGroup[],   // upstream order: primary group first, then the others by id
                isStarter: boolean }
```

`muscleGroup` (the string enum) no longer exists on `Exercise` anywhere — including inside
`FullWorkoutExercise.exercise` (§2.8).

### 2.1 `GET /api/muscle-groups` (new)

Auth: `app.authenticate` only (any role; reference data). No ownership check. Mounted from
`app.ts` as `api.register(muscleGroupRoutes, { prefix: '/muscle-groups' })`, `muscleGroupRoutes`
exported from `src/modules/exercises/routes.ts` (§0).

Request: no params, no query, no body.

Upstream: `ExerciseService.ListMuscleGroups {}` → `listMuscleGroups()` maps
`muscle_groups[]` with `Number(id)`.

Response: `200` `MuscleGroup[]` in upstream (id) order — 14 rows at launch, `id` 1..14 in the
PRD R8 order (Peito … Cardio).

### 2.2 `GET /api/exercises?muscleGroupId=&q=` (changed)

Auth: `app.authenticate` + `app.requireRole('TRAINER', 'ADMIN')` (new gate, D5). No BFF
ownership check: upstream scopes the list to the caller (TRAINER: starter set ∪ own; ADMIN:
starter set only).

Query (`exerciseListQuerySchema`, parsed with `schema.parse(req.query)`):

| Field | Type | Rule | Forwarded as |
|---|---|---|---|
| `muscleGroupId` | string → number | optional; `""` = absent; otherwise coerced to a positive integer (else 400) | `muscle_group_id` (`0` when absent) |
| `q` | string | optional; trimmed; `""` after trim = absent; 1..100 chars (else 400) | `search` (`''` when absent) |

A repeated parameter (`?q=a&q=b`, which Fastify parses as an array) fails the schema → 400.

Upstream: `ExerciseService.ListExercises { muscleGroupId, search }` →
`listExercises({ muscleGroupId?, search? })`.

Response: `200` `Exercise[]` **in upstream order** — own exercises first (name asc), then
starter exercises (with a group filter: primary-group matches in catalog order, then secondary
matches by name; without: name asc). The BFF does not sort or filter.

### 2.3 `GET /api/exercises/:id` (changed behavior, same route)

Auth: `app.authenticate` only — unchanged. No `requireRole` and no ownership check, on purpose
(D5/D10): upstream decides per caller (TRAINER → starter or own; ADMIN → starter only; CLIENT →
only an exercise referenced by a workout in one of their plans).

Upstream: `ExerciseService.GetExercise { id }` → `getExercise(id)`.

Response: `200` `Exercise`.

### 2.4 `POST /api/exercises` (changed)

Auth: `app.authenticate` + `app.requireRole('TRAINER')` (narrowed from `('TRAINER','ADMIN')`,
D5).

Body (`exerciseInputSchema`):

| Field | Type | Rule | Forwarded as |
|---|---|---|---|
| `name` | string | required, 1..255 chars | `name` |
| `description` | string | optional, ≤255, default `''` | `description` |
| `videoUrl` | string | optional; `''` or a URL per Zod `.url()`, ≤500 chars; default `''` | `video_url` |
| `muscleGroupIds` | number[] | required; each a positive integer; at least one; duplicates removed, first occurrence kept | `muscle_group_ids` |

The retired `muscleGroup` key is ignored if sent (Zod strips unknown keys); a body carrying
only the old field fails on the missing `muscleGroupIds`.

Upstream: `ExerciseService.CreateExercise { name, description, videoUrl, muscleGroupIds }`
→ `createExercise(input)`.

Response: `201` `Exercise` with `isStarter: false` and the groups upstream resolved.

### 2.5 `PATCH /api/exercises/:id` (changed)

Auth: `app.authenticate` + `app.requireRole('TRAINER')` (narrowed, D5). Same body as 2.4 —
full replacement of name, description, video URL and the whole group list (D11), as today.

Upstream: `ExerciseService.UpdateExercise { id, exercise: {...} }` → `updateExercise(id, input)`.

Response: `200` `Exercise`.

### 2.6 `DELETE /api/exercises/:id` (changed)

Auth: `app.authenticate` + `app.requireRole('TRAINER')` (narrowed, D5).

Upstream: `ExerciseService.DeleteExercise { id }` → `deleteExercise(id)`.

Response: `204`, no body.

### 2.7 Increment 2: workout-side endpoints gain documented 403s (no shape or code change)

`POST /api/workouts/:workoutId/exercises`, `PUT /api/workouts/:workoutId/exercises`,
`POST /api/training-plans/:planId/workouts` (when `exercises` is non-empty) and
`POST /api/workouts/:id/clone` keep their routes, hooks, bodies and responses. Once
`vertice-api` Increment 2 is on `main`, they can additionally return `403 FORBIDDEN` from
upstream's `PERMISSION_DENIED` when an `exerciseId` is not visible to the caller (R17) or when
the workout/plan is not the caller's (R18/R19). For a TRAINER the BFF's own `assertOwnsWorkout`
/ `assertOwnsPlan` still refuses R18/R19 first (same status and code, BFF message); an ADMIN
passes those and is refused upstream. Only `docs/api-contract.md` changes (PR3).

### 2.8 Composed endpoints whose embedded `Exercise` changes shape (Increment 1, no route change)

`GET /api/workouts/:id/full`, `POST /api/training-plans/:planId/workouts`,
`PUT /api/workouts/:workoutId/exercises`, `GET /api/workouts/:workoutId/session`: every
`FullWorkoutExercise.exercise` is the new `Exercise` (`muscleGroups`, `isStarter`; no
`muscleGroup`). Nothing in `workouts/service.ts` or `workout-sessions/service.ts` changes — the
type flows from `exerciseService.Exercise`. Because the embedded `GetExercise` now carries the
caller's identity, an ADMIN opening a workout that contains a trainer's private exercise gets
`403 FORBIDDEN` for the whole aggregate (D5/D10 consequence, documented in the contract). A
CLIENT opening their own session and a TRAINER opening their own workout are unaffected: every
exercise there is starter or the plan's trainer's own, which upstream allows.

### 2.9 Unchanged

- `GET /api/exercises/:id/progress?clientId=` — same route, same role logic (`CLIENT` uses own
  id, `TRAINER` passes `clientId`), still `WorkoutSessionService.GetExerciseProgress`, which does
  not require identity in this run.
- All `/workout-exercises/*`, `/exercise-sets/*`, `/workout-logs/*`, `/workout-sessions/*`,
  `/feedback/*`, `/dashboard`, `/clients/*`, `/training-plans/*` (other than the composed
  create above), `/auth/*`: no route, schema or response change. They now carry identity
  metadata upstream (Increment 0), which upstream ignores until an RPC requires it.
- `src/lib/ownership.ts` — no new helper, no change to the three existing ones (D10).
- `GET /api/workouts?recent=true` — uses `ListWorkoutExercises` only, never `GetExercise`; no
  embedded `Exercise`, no change.

## 3. Errors the web will see

Envelope `{ error: { code, message, details } }` as everywhere. No new `HttpError` subclass and
no new `mapGrpcError` branch: every upstream status this feature emits already has one.

| HTTP | `error.code` | When | Upstream gRPC status |
|---|---|---|---|
| 401 | `UNAUTHORIZED` | no/invalid bearer token at the BFF (any endpoint in §2) | — (never reaches upstream) |
| 401 | `UNAUTHENTICATED` | upstream rejected or missed the forwarded identity — must not happen once Increment 0 is deployed on both sides with the same `JWT_SECRET`; if it does, the secrets differ or `vertice-api` required identity before this BFF forwarded it | `UNAUTHENTICATED` |
| 400 | `VALIDATION_ERROR` | `GET /exercises`: bad `muscleGroupId` (non-numeric, 0, negative, repeated), `q` > 100 chars; `POST`/`PATCH`: Zod failure (`name` missing/empty/>255, `description` >255, `videoUrl` not a URL/>500, `muscleGroupIds` missing/empty/non-positive) — `message: "Invalid request"`, `details` = Zod flatten | — |
| 400 | `VALIDATION_ERROR` | upstream rejected: `name: must not be blank`, `videoUrl: must be a valid http(s) URL`, `muscleGroupIds: must contain at least one muscle group`, `muscleGroupIds: unknown muscle group <id>`, `search` >100 — flat upstream message | `INVALID_ARGUMENT` |
| 403 | `FORBIDDEN` | `GET /exercises` as CLIENT — `Requires role: TRAINER or ADMIN`; `POST`/`PATCH`/`DELETE /exercises` as CLIENT or ADMIN — `Requires role: TRAINER` (BFF gate, D5) | — |
| 403 | `FORBIDDEN` | `GET /exercises/:id`: another trainer's exercise, ADMIN on a private one, CLIENT outside their own workouts — `You do not have access to exercise <id>` (R16/R22/R25) | `PERMISSION_DENIED` |
| 403 | `FORBIDDEN` | `PATCH /exercises/:id` on a starter-set row — `Exercise <id> belongs to the shared starter set and cannot be changed` (R26/E1, D3); on another trainer's — `You do not have access to exercise <id>` (R32/E21) | `PERMISSION_DENIED` |
| 403 | `FORBIDDEN` | `DELETE /exercises/:id` on a starter-set row — `Exercise <id> belongs to the shared starter set and cannot be deleted` (R27/E2, D3); on another trainer's — `You do not have access to exercise <id>` (R36/E21) | `PERMISSION_DENIED` |
| 403 | `FORBIDDEN` | `GET /exercises` as CLIENT if the BFF gate were bypassed (defense in depth, R21); `POST/PATCH/DELETE` role refusals upstream (R23/R24) | `PERMISSION_DENIED` |
| 403 | `FORBIDDEN` | composed: `GET /workouts/:id/full`, `POST /training-plans/:planId/workouts`, `PUT /workouts/:workoutId/exercises`, `GET /workouts/:workoutId/session` when the embedded `GetExercise` is refused (ADMIN on a workout holding a private exercise) — `You do not have access to exercise <id>` | `PERMISSION_DENIED` |
| 403 | `FORBIDDEN` | **Increment 2**: `POST /workouts/:workoutId/exercises`, `PUT /workouts/:workoutId/exercises`, `POST /training-plans/:planId/workouts`, `POST /workouts/:id/clone` — `You do not have access to exercise <id>` (R17/E18), `You do not have access to workout <id>` / `... training plan <id>` (R18/R19, E19/E20; a TRAINER usually hits the BFF's `You do not have access to this training plan` first) | `PERMISSION_DENIED` |
| 404 | `NOT_FOUND` | `GET /exercises?muscleGroupId=<unknown>` — `MuscleGroup with id <id> not found`; `GET/PATCH/DELETE /exercises/:id` on a non-existent id — `Exercise with id <id> not found` (D2: existence is not hidden) | `NOT_FOUND` |
| 409 | `PRECONDITION_FAILED` | `DELETE /exercises/:id` while any workout uses it — `Exercise <id> is used by a workout and cannot be deleted` verbatim (R34/E5, D4) | `FAILED_PRECONDITION` |
| 503 | `UPSTREAM_UNAVAILABLE` | `vertice-api` down — as today | `UNAVAILABLE` |

Check order the web can rely on (upstream's, relayed): identity → role → shape → existence →
visibility/starter → in-use. So a CLIENT never learns whether an id exists (403 before 404),
while a TRAINER probing another trainer's id gets 403 only if it exists (404 otherwise, D2).

## 4. Code changes

### PR1 — Increment 0

- `src/lib/request-context.ts` (new) — `export interface RequestContext { bearerToken?: string }`;
  `export const requestContext = new AsyncLocalStorage<RequestContext>()` (from `node:async_hooks`).
- `src/plugins/request-context.ts` (new, `fastify-plugin`) — one callback-style hook:
  `app.addHook('onRequest', (_req, _reply, done) => requestContext.run({}, done))`, so every
  later hook, the handler and every `await` under it share one store. Callback style (not
  `async`) is required: `run()` must wrap the continuation, which `done()` is.
- `src/app.ts` — `await app.register(requestContextPlugin)` between `errorHandler` and
  `authenticatePlugin`.
- `src/plugins/authenticate.ts` — after `verifyToken` succeeds:
  `requestContext.getStore()?.bearerToken = token` (assignment guarded by the optional store;
  no store means "not inside a request", e.g. a direct unit call).
- `src/grpc/call.ts` — `export function withCallerIdentity(metadata: grpc.Metadata): grpc.Metadata`:
  reads `requestContext.getStore()?.bearerToken`; if present and `metadata.get('authorization')`
  is empty, `metadata.set('authorization', \`Bearer ${token}\`)`; returns the same object.
  `grpcCall` passes `withCallerIdentity(metadata)` to the client method. The `metadata`
  parameter's default and signature are unchanged.
- `src/grpc/call.test.ts` — the three `grpcCall` cases and the `PERMISSION_DENIED` case in §5.
- `.env.example` — `JWT_SECRET=dev-secret-change-me` with the comment from §0.
- `CLAUDE.md` — gRPC bridge paragraph: one sentence that `grpcCall` attaches the verified
  bearer as `authorization` metadata from the request context, and that `/health`/`/auth/login`/
  `/auth/register` call upstream anonymously. Auth paragraph: `JWT_SECRET` must equal
  `vertice-api`'s.
- Touches nothing under `src/modules/**` or `src/lib/ownership.ts`.

### PR2 — Increment 1, exercises module on the new contract

- `protos/vertice/exercise/v1/exercise.proto` — replaced with §1's block.
- `src/modules/exercises/service.ts` — `MuscleGroup`, `Exercise` (new shape), `ExerciseInput`
  (`muscleGroupIds: number[]`); internal `MuscleGroupResponse`/`ExerciseResponse` wire types
  (`id: string`, `muscleGroups: MuscleGroupResponse[]`, `isStarter: boolean`); `toMuscleGroup`
  and `toExercise` **exported** (for the mapper test); new `listMuscleGroups()`;
  `listExercises(filter: { muscleGroupId?: number; search?: string })` sending
  `{ muscleGroupId: filter.muscleGroupId ?? 0, search: filter.search ?? '' }`;
  `createExercise`/`updateExercise` send `muscleGroupIds` instead of `muscleGroup`. The old
  `MuscleGroup` string union is deleted (nothing outside the module imports it).
- `src/modules/exercises/schemas.ts` — delete `muscleGroupSchema`; `exerciseInputSchema` per
  §2.4 (`muscleGroupIds: z.array(z.number().int().positive()).min(1).transform(ids => [...new Set(ids)])`);
  new `exerciseListQuerySchema` per §2.2 (a `z.preprocess` that turns `''` into `undefined`
  for both fields, then `z.coerce.number().int().positive().optional()` and
  `z.string().trim().min(1).max(100).optional()`).
- `src/modules/exercises/routes.ts` — `GET /` gains `{ preHandler: app.requireRole('TRAINER','ADMIN') }`
  and parses `exerciseListQuerySchema`; `POST /`, `PATCH /:id`, `DELETE /:id` change to
  `app.requireRole('TRAINER')`; `GET /:id` and `GET /:id/progress` untouched; new exported
  `muscleGroupRoutes(app)` with `app.addHook('preHandler', app.authenticate)` and
  `app.get('/', () => exerciseService.listMuscleGroups())`.
- `src/app.ts` — `api.register(muscleGroupRoutes, { prefix: '/muscle-groups' })`.
- `src/modules/exercises/schemas.test.ts`, `src/modules/exercises/service.test.ts`,
  `src/modules/exercises/routes.test.ts` (all new) — §5.
- `src/modules/workouts/service.ts`, `src/modules/workout-sessions/service.ts` — no change
  (the embedded type flows through); verification.md checks the diff is empty.
- `docs/api-contract.md` — **Exercises** section rewritten: the `Muscle groups —
  /muscle-groups` line, the query params on `GET /`, the `Exercise`/`MuscleGroup` shapes, the
  role on every line (`GET /` TRAINER/ADMIN, writes TRAINER), the per-endpoint error rows from
  §3 including the three verbatim upstream messages, and the line "trainer-created exercises
  are private; the starter set is shared" replacing "Shared across all trainers". The
  `PRECONDITION_FAILED` paragraph at the top gains `DELETE /exercises/:id` as a second emitter.
  **Workouts** (`GET /workouts/:id/full`, `POST /training-plans/:planId/workouts`),
  **Workout exercises** (`PUT /workouts/:workoutId/exercises`) and **Workout sessions**
  (`GET /workouts/:workoutId/session`): one sentence each that `FullWorkoutExercise.exercise` is
  the new `Exercise` shape, plus the ADMIN-403 note on `/full`.
- `CLAUDE.md` — module layout: `exercises` "(also owns `/muscle-groups`)".

### PR3 — Increment 2, documentation only

- `docs/api-contract.md` — the 403 rows of §3's Increment 2 line under
  `POST /workouts/:workoutId/exercises`, `PUT /workouts/:workoutId/exercises`,
  `POST /training-plans/:planId/workouts`, `POST /workouts/:id/clone`, with a sentence that
  exercise visibility is enforced upstream only (no `assertOwnsExercise`, D10) and that ADMIN is
  refused by upstream on these four.
- No file under `src/` changes.

## 5. Tests

Vitest, `npm test`; no gRPC is spun up anywhere. Today the `exercises` module has no tests
(assessment F16); PR2 adds its first three files.

### `src/grpc/call.test.ts` (PR1) — extends the existing `mapGrpcError` suite

Uses a stub client `{ Ping(request, metadata, cb) { seen = metadata; cb(null, {}) } }` cast to
`grpc.Client`.

- `grpcCall attaches "authorization: Bearer <token>" metadata when the request context holds a token`
  — `requestContext.run({ bearerToken: 'abc' }, () => grpcCall(stub, 'Ping', {}))`;
  `seen.get('authorization')` equals `['Bearer abc']`. (D1, Increment 0)
- `grpcCall sends no authorization metadata outside a request context` — same call with no
  `run`; `seen.get('authorization')` is `[]`. (login/register/health path, §0)
- `grpcCall keeps caller-supplied metadata and adds the bearer to it` — pass a `Metadata` with
  `x-test: 1` inside a context; both keys present; a caller-supplied `authorization` is not
  overwritten. (D1)
- `mapGrpcError maps PERMISSION_DENIED to 403 FORBIDDEN with the upstream message verbatim` —
  details `You do not have access to exercise 12`; `statusCode` 403, `code` `FORBIDDEN`,
  `message` verbatim. (D2/D3; assessment §6)
- The three existing cases (`FAILED_PRECONDITION`→409, `INVALID_ARGUMENT`→400, `NOT_FOUND`→404)
  stay.

### `src/modules/exercises/schemas.test.ts` (PR2)

`exerciseInputSchema`:
- `rejects an empty muscleGroupIds` (R40/E13, R31/E22)
- `rejects a body without muscleGroupIds even when it carries the retired muscleGroup field`
  (D9 — the shape break is enforced)
- `accepts a single muscle group` (R39)
- `accepts several muscle groups and de-duplicates them keeping first occurrence` —
  `[3, 1, 3, 2]` → `[3, 1, 2]` (R43, §0)
- `rejects a non-integer or non-positive muscle group id` — `[0]`, `[-1]`, `[1.5]`, `['1']`
- `keeps videoUrl optional-or-blank and rejects a non-URL` — omitted → `undefined`, `''` ok,
  `https://x.test/v` ok, `not a url` rejected (R42 regression while the schema is reshaped)
- `rejects name longer than 255, description longer than 255, videoUrl longer than 500`
- `defaults description to ''`

`exerciseListQuerySchema`:
- `treats empty muscleGroupId and q as absent` — `{ muscleGroupId: '', q: '' }` → `{}` (§0)
- `coerces muscleGroupId to a positive integer` — `'12'` → `12`; `'0'`, `'-1'`, `'abc'`,
  `'1.5'`, `['1','2']` rejected (R45)
- `trims q and rejects more than 100 characters` — `'  supino '` → `'supino'`; 101 chars
  rejected; `'   '` → absent (R46)

### `src/modules/exercises/service.test.ts` (PR2)

- `toExercise converts int64 strings to numbers, keeps muscleGroups in upstream order and passes isStarter through`
  — `{ id: '7', muscleGroups: [{ id: '1', name: 'Peito' }, { id: '5', name: 'Tríceps' }], isStarter: true, ... }`
  → `{ id: 7, muscleGroups: [{ id: 1, name: 'Peito' }, { id: 5, name: 'Tríceps' }], isStarter: true, ... }`
  and no `muscleGroup` key. This is the composed-endpoint proof: `getFullWorkout` embeds this
  output unchanged (§2.8, assessment F12).
- `toExercise yields an empty muscleGroups array when upstream sends none` — defensive against
  a loader without `defaults: true`.

### `src/modules/exercises/routes.test.ts` (PR2)

`buildApp()` + `app.inject`, tokens minted with `signToken` from `src/lib/jwt.ts`. Every case
stops before `grpcCall` (role gate, missing token, Zod).

- `GET /api/exercises with a CLIENT token is refused with 403 FORBIDDEN before any upstream call` (R21/E16, F5)
- `GET /api/exercises without a token is 401 UNAUTHORIZED`
- `GET /api/exercises?muscleGroupId=abc with a TRAINER token is 400 VALIDATION_ERROR` (fail-fast)
- `GET /api/muscle-groups without a token is 401 UNAUTHORIZED`
- `POST /api/exercises with an ADMIN token is 403 FORBIDDEN` — message `Requires role: TRAINER` (D5)
- `POST /api/exercises with a CLIENT token is 403 FORBIDDEN` (R23/E17)
- `PATCH and DELETE /api/exercises/:id with a CLIENT token are 403 FORBIDDEN` (R24/E17)
- `POST /api/exercises with a TRAINER token and muscleGroupIds: [] is 400 VALIDATION_ERROR with a details.fieldErrors.muscleGroupIds entry` (R40/E13)
- `GET /api/exercises/:id has no role gate` — a CLIENT token is not refused by the BFF: the
  response is not a BFF role refusal (`error.message` does not start with `Requires role`; with
  no upstream running the actual result is 503 `UPSTREAM_UNAVAILABLE`, with one running it is
  whatever upstream decides). Pins D5/D10 so nobody adds `requireRole` here.

### Not unit-tested here

Everything that needs upstream — scoping, ordering, the starter-set and in-use refusals, the
CLIENT-inside-own-workout case, the composed ADMIN 403 — is covered by `vertice-api`'s own tests
and by the end-to-end checks in `verification.md`.

## 6. Rollout

- **PR1 (Increment 0) must be on `main` and deployed before any `vertice-api` PR that makes an
  RPC require identity is deployed.** Otherwise the live BFF starts getting `UNAUTHENTICATED`
  → 401 and the web logs users out. PR1 is harmless against today's `vertice-api` (metadata is
  ignored) and against `vertice-api` Increment 0 (verified, not required), so it can ship first
  in any order relative to the api's Increment 0. Both sides must run the same `JWT_SECRET`
  (`dev-secret-change-me` locally).
- **PR2 (Increment 1) merges only when the whole Increment 1 `ExerciseService` contract is on
  `vertice-api` `main`** (`ListMuscleGroups` and the changed `ListExercises`, `GetExercise`,
  `CreateExercise`, `UpdateExercise`, `DeleteExercise`, `ExerciseResponse`, `ExerciseRequest`).
  There is no old-BFF/new-API coexistence for the changed fields, so deploy is coordinated
  api → bff → web in one window (D9). The currently deployed web build reads
  `exercise.muscleGroup` and breaks the moment PR2 is live; the web's Increment 1 PRs follow
  in the same window.
- **PR3 (Increment 2) is docs-only.** Merge it once `vertice-api` Increment 2 is on `main`, so
  the contract does not document a 403 that cannot happen yet. Nothing to deploy.
- **Env:** `.env.example`'s `JWT_SECRET` changes to `dev-secret-change-me` (PR1). No new env
  var, no `CORS_ORIGIN` change, no port change.
- **Backward compatibility** beyond the accepted D9 break: none. `/auth/*`, `/health` and every
  endpoint in §2.9 respond exactly as today.

## 7. Out of scope

- A BFF-side `assertOwnsExercise` or any exercise-visibility check, including on
  `POST /workouts/:workoutId/exercises` (D10) — enforced upstream. Not a gap: a deliberate
  single-enforcer design.
- A BFF service credential for `/auth/login` and `/auth/register`'s upstream calls under a
  non-local `vertice-api` profile (they have no caller token; today they cannot work non-locally
  either). Follow-up for `vertice-api` + this repo.
- Replacing the BFF-minted JWT with a real identity provider (D1 reuses it deliberately).
- Any platform-team surface (R25/R37/R38), videos/descriptions on starter-set exercises,
  accent-insensitive search, pagination of `GET /exercises`, metrics/logging conventions —
  PRD §6 and the brief's out-of-scope list; baselines unchanged.
- Client-side web screens for R20–R24; a `CloneWorkout`-backed clone UI.
- Mitigating the ADMIN consequences of D5/D10 (documented in `api-contract.md`, not worked
  around).
- **Settled (owner, 2026-09-23):** a trainer-created exercise has no primary group, so its
  `muscleGroups` come back in id order. The BFF still de-duplicates and forwards `muscleGroupIds`
  as sent; `api-contract.md` says so.

## 8. Delivery plan

| PR | Title | Increment | Contains (spec §) | Depends on | Verified by |
|---|---|---|---|---|---|
| PR1 | Forward the caller's JWT as gRPC metadata on every upstream call | 0 | §0 (D1 bullets), §4 PR1, §5 `call.test.ts` | `feat/create-workout-with-exercises` merged | verification.md §1.1 |
| PR2 | Exercises module on the starter-catalog `ExerciseService` contract (proto sync, `Exercise` shape, `/muscle-groups`, filters, role gates) | 1 | §1, §2.1–2.6, §2.8, §3, §4 PR2, §5 exercises tests | PR1; `vertice-api` `ExerciseService` Increment 1 contract on main (`ListMuscleGroups` + changed `ListExercises`/`GetExercise`/`CreateExercise`/`UpdateExercise`/`DeleteExercise`, `ExerciseResponse`, `ExerciseRequest`) | verification.md §1.2 |
| PR3 | Document the Increment 2 workout-side 403s in `api-contract.md` | 2 | §2.7, §3 (Increment 2 row), §4 PR3 | PR2; `vertice-api` Increment 2 guards on `CreateWorkoutExercise`, `CreateWorkoutWithExercises`, `ReplaceWorkoutExercises`, `CloneWorkout` on main | verification.md §1.3 |

### PR1 — Forward the caller's JWT as gRPC metadata on every upstream call
Branch: `feat/exercise-starter-catalog-identity-metadata`. Scope: the request-context module and
plugin, the one-line change in `app.authenticate`, `withCallerIdentity` in `call.ts`, the four
`call.test.ts` cases, `.env.example`, CLAUDE.md. Deliberately left out: anything under
`src/modules/**` and `src/lib/ownership.ts` (no signature changes — that is the point of the
context approach), and every proto. Cross-cutting, reviewed alone because it touches every
upstream call. After merge, `main` still deploys against today's `vertice-api` (extra metadata
is ignored) and against `vertice-api` Increment 0. Done when: verification.md §1.1 passes.

### PR2 — Exercises module on the starter-catalog `ExerciseService` contract
Branch: `feat/exercise-starter-catalog-exercises`. Scope: the proto copy, the reshaped
`exercises` module (service, schemas, routes, the `muscleGroupRoutes` plugin and its mount in
`app.ts`), the three new test files, the Exercises/Workouts/Workout-exercises/Workout-sessions
sections of `api-contract.md`, the CLAUDE.md layout line. One PR rather than reads/writes split:
the proto sync retires the `muscle_group` field, so a reads-only PR would leave `POST`/`PATCH`
sending a field the loader drops — `main` would deploy with a broken create in between. About
350 hand-written lines. Deliberately left out: any change to `workouts/service.ts` or
`workout-sessions/service.ts` (none needed) and any ownership helper (D10). After merge, `main`
deploys only against `vertice-api` with the Increment 1 contract on main (coordinated window,
D9). Done when: verification.md §1.2 passes.

### PR3 — Document the Increment 2 workout-side 403s
Branch: `docs/exercise-starter-catalog-increment-2`. Scope: `api-contract.md` only — the 403
rows on the four workout-side endpoints and the sentence that exercise visibility is upstream's
(no `assertOwnsExercise`). No `src/` change; the BFF's behavior change comes entirely from
upstream. After merge, `main` deploys unchanged. Done when: verification.md §1.3 passes
(including the end-to-end refusals against `vertice-api` Increment 2).
