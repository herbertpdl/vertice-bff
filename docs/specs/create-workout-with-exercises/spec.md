# Spec: Create Workout With Exercises (BFF)

Status: Draft
Owner: hebertpdl@gmail.com
Related: [vertice-api/docs/prds/create-workout-with-exercises/prd.md](https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/create-workout-with-exercises/prd.md) (product rules R1–R16,
E1–E11 — this document does not restate them), [vertice-api/docs/specs/create-workout-with-exercises/spec.md](https://github.com/herbertpdl/vertice-api/blob/main/docs/specs/create-workout-with-exercises/spec.md)
(the upstream gRPC contract this bridges, already implemented on `vertice-api` `main`),
[vertice-web-react/docs/prds/create-workout-with-exercises/prd.md](https://github.com/herbertpdl/vertice-web-react/blob/main/docs/prds/create-workout-with-exercises/prd.md) (the web PRD that consumes the
endpoints below), `docs/api-contract.md` (must be updated as part of this change)

This BFF owns no business rules for this feature. Everything below is "which REST endpoints to
expose, how they map onto the two new upstream RPCs, and what the web can rely on." Validation,
ordering, defaulting and the recorded-data refusal all happen in `vertice-api`; the BFF only
fails fast on shape and relays upstream errors with a usable status code.

## 0. Scope decisions

- **Extend `POST /training-plans/:planId/workouts` instead of adding a second create endpoint.**
  The body gains an optional `exercises` array; the handler always delegates to the new
  `CreateWorkoutWithExercises` RPC. Upstream guarantees an empty/omitted list produces exactly
  what `CreateWorkout` produces (PRD R1/E1), so one code path covers both. The old
  `workoutService.createWorkout` → `CreateWorkout` call goes away. Chosen over
  `POST .../workouts/with-exercises` because the web has one "create a workout" action, not two,
  and the product explicitly allows breaking changes right now (no deployments exist).
- **Both endpoints return the full tree (`FullWorkout`), not the bare `Workout`.** Upstream
  returns only `WorkoutResponse` (`{id, name, trainingPlanId, dayOfWeek}`) and expects callers to
  re-list exercises/sets. The web needs every new `WorkoutExercise`/`ExerciseSet` id right after
  saving (to switch from an unsaved draft to per-item editing), and after a replace *every id in
  the tree changes* (upstream deletes and recreates the whole tree — see the api spec §0). So the
  BFF calls its existing `getFullWorkout(id)` aggregate after the RPC and returns that. Cost: one
  extra round of `ListWorkoutExercises`/`GetExercise`/`ListExerciseSets` calls per save — same
  cost the web would otherwise pay with a follow-up `GET /workouts/:id/full`. For create, the
  response is a superset of today's `Workout`, so existing callers are not broken.
- **Replace is `PUT /workouts/:workoutId/exercises`, registered in the workout-exercises route
  plugin, delegating to the workouts service.** `PUT` because the semantics are "this is now the
  whole list" (PRD R11 full replace, not merge). It lives in
  `workoutExercisesUnderWorkoutRoutes` (mounted at `/workouts/:workoutId/exercises`, next to the
  existing `GET`/`POST` on the same path) rather than in `workoutRoutes` as `/:id/exercises`, so
  the same path is not registered twice with differently named params (`:id` vs `:workoutId`).
  The gRPC call itself belongs in `workouts/service.ts` because the RPC is on `WorkoutService`
  (`workoutClient`), matching the "one service file per upstream gRPC service" split.
- **`FAILED_PRECONDITION` stops being a 400.** Today `grpc/call.ts` folds `FAILED_PRECONDITION`
  into `ValidationError` (400 `VALIDATION_ERROR`). The recorded-data refusal (PRD R12/R13) is the
  first upstream code path that emits `FAILED_PRECONDITION` (verified: it is the only
  `Status.FAILED_PRECONDITION` in `vertice-api`), and the web must tell it apart from "your
  payload is malformed" — one means "fix the form", the other means "this workout cannot be
  edited as a whole any more". Map it to a new `PreconditionFailedError` → **409**
  `PRECONDITION_FAILED`, message passed through verbatim from upstream (it names the blocking
  exercise and set number, which is what R13 requires the trainer to see). No other endpoint is
  affected since nothing else upstream emits this code.
- **Caps (20 exercises, 10 sets per exercise) are enforced in Zod as well as upstream.** Purely
  fail-fast: the API is authoritative and rejects them too (PRD R8/R9). Duplicating the numbers
  is accepted because a 400 from Zod carries a `details` object the web can attach to a field,
  whereas the upstream `INVALID_ARGUMENT` arrives as a flat message.
- **`strategy` is optional in the BFF schema and is *not* defaulted here.** An omitted strategy is
  forwarded unset so upstream applies its own "plain working set" default (PRD R6). Keeps the
  default in one place. Note this is the opposite of the existing per-set
  `exerciseSetInputSchema`, where `strategy` is required — that schema is untouched (PRD R15).
- **No "does this workout have recorded data?" signal is added.** The web would like to know
  *before* the trainer starts a whole-list edit whether the replace will be refused, so it can
  fall back to one-at-a-time editing without losing a draft. `vertice-api` exposes no RPC for
  this: `GetLastSetLogs` only covers the last *completed* log (an in-progress log with recorded
  sets is invisible to it), and `ListWorkoutLogs` is scoped to one plan+week. The BFF cannot
  compute it reliably, so it is not faked. This is recorded as a follow-up for `vertice-api`
  (§6) and the web PRD handles the refusal after the fact meanwhile.

## 1. Proto sync

`protos/vertice/plan/v1/workout.proto` is stale relative to
[vertice-api/src/main/proto/vertice/plan/v1/workout.proto](https://github.com/herbertpdl/vertice-api/blob/main/src/main/proto/vertice/plan/v1/workout.proto). Copy it over verbatim. The diff is:

- new `import "vertice/plan/v1/exercise_set.proto";` (for `SetStrategy`) — resolves through the
  existing `includeDirs: [PROTOS_ROOT]` in `src/grpc/loadProto.ts`; `exercise_set.proto` is
  already in `PROTO_FILES`, and proto-loader tolerates a file being both listed and imported.
- two new RPCs on `WorkoutService`: `CreateWorkoutWithExercises`, `ReplaceWorkoutExercises`.
- four new messages: `CreateWorkoutWithExercisesRequest`, `ReplaceWorkoutExercisesRequest`,
  `WorkoutExerciseEntry`, `ExerciseSetEntry`.

No change to `PROTO_FILES` or `src/grpc/clients.ts` — the RPCs are on the existing
`workoutClient`.

(`protos/vertice/trainerclient/v1/trainer_client.proto` also differs from upstream, but only in
whitespace/formatting — resync it in the same commit for hygiene, no behavior change.)

## 2. Endpoints

### 2.1 `POST /api/training-plans/:planId/workouts` (changed)

Role: `TRAINER` | `ADMIN`. Ownership: `assertOwnsPlan(req.user, plan)` as today.

Request body:

```jsonc
{
  "name": "Treino A",
  "dayOfWeek": "MONDAY",
  "exercises": [                       // optional; omitted or [] → empty workout (R1/E1)
    {
      "exerciseId": 12,                // catalog exercise; must exist (R10/E3) — same id may repeat (R7/E5)
      "restSecondsBetweenSets": 90,    // optional, default 0
      "notes": "",                     // optional, default ""
      "sets": [                        // optional; omitted or [] → exercise with no sets (E6)
        {
          "reps": 10,                  // optional, default 0
          "durationSeconds": 0,        // optional, default 0
          "weight": "60.0",            // optional decimal string, default "" (unset)
          "loadPercentage": "",        // optional decimal string, default "" (unset)
          "strategy": "STRAIGHT",      // optional; omitted → upstream defaults to STRAIGHT (R6)
          "restSeconds": 90,           // optional, default 0
          "notes": ""                  // optional, default ""
        }
      ]
    }
  ]
}
```

No `order` on an exercise entry and no `setNumber` on a set entry — list position is the order
(R4/R5). Max 20 `exercises`, max 10 `sets` per exercise (R8/R9).

Response: `201` **`FullWorkout`** = `Workout & { exercises: FullWorkoutExercise[] }` — the same
shape as `GET /workouts/:id/full`, exercises sorted by `order`, sets by `setNumber`.

Mapping: `CreateWorkoutWithExercises { name, trainingPlanId, dayOfWeek, exercises[] }` with the
entries forwarded field-for-field (camelCase; proto-loader's `keepCase: false` handles the
`snake_case` conversion as it does for every other call). Then `getFullWorkout(res.id)`.

### 2.2 `PUT /api/workouts/:workoutId/exercises` (new)

Role: `TRAINER` | `ADMIN`. Ownership: `assertOwnsWorkout(req.user, workoutId)`.

Request body: `{ "exercises": [ ...WorkoutExerciseEntry ] }` — the same entry shape as 2.1.
`exercises` is required here (it may be `[]`, which empties the workout); omitting it is a 400,
because a `PUT` with no list is more likely a bug than an intent to clear the workout.

Response: `200` **`FullWorkout`** — the workout's new tree. **Every `WorkoutExercise` and
`ExerciseSet` id in it is new**; any id the web held from before the call is now invalid.

Mapping: `ReplaceWorkoutExercises { workoutId, exercises[] }`, then `getFullWorkout(workoutId)`.

### 2.3 Unchanged

`POST /workouts/:workoutId/exercises`, `PATCH|DELETE /workout-exercises/:id`,
`POST /workout-exercises/:id/sets`, `PATCH|DELETE /exercise-sets/:id`, `PATCH /workouts/:id`,
`POST /workouts/:id/clone`, `GET /workouts/:id/full` — all exactly as today (PRD R15).

## 3. Errors the web will see

| Situation | Upstream code | BFF status / `error.code` | Message |
|---|---|---|---|
| Body fails Zod (missing `name`, >20 exercises, >10 sets, bad enum, negative number…) | — (never reaches upstream) | 400 `VALIDATION_ERROR` | "Invalid request" + `details` = Zod flatten |
| Upstream rejects (cap, nonexistent `exerciseId`, malformed decimal, unset `dayOfWeek`) | `INVALID_ARGUMENT` | 400 `VALIDATION_ERROR` | upstream message, e.g. `exercise_id: one or more referenced exercises do not exist` — generic by design (api spec §0/F10), does not say which entry |
| Plan / workout does not exist | `NOT_FOUND` | 404 `NOT_FOUND` | as today |
| Replace refused: a client has recorded data under this workout (R12) | `FAILED_PRECONDITION` | **409 `PRECONDITION_FAILED`** (new) | upstream message verbatim, e.g. `Cannot replace exercises: exercise 'Supino reto' (id 12) set 2 has recorded workout data` (R13) |
| Caller does not own the plan/workout | — | 403 `FORBIDDEN` | as today |

All-or-nothing: on any 4xx from either endpoint nothing was created or changed upstream
(PRD R10/R12).

Note for the web: once *any* set under a workout has recorded data, **every** replace of that
workout is refused, not just ones that would drop that set — upstream cannot tell a resubmitted
entry from a new one (api spec §0, last bullet). The trainer's only path from there is the
one-at-a-time endpoints in 2.3.

## 4. Code changes (checklist)

- `protos/vertice/plan/v1/workout.proto` — replace with the upstream copy (§1).
- `src/lib/errors.ts` — add `PreconditionFailedError extends HttpError` (409,
  `PRECONDITION_FAILED`).
- `src/grpc/call.ts` — split `FAILED_PRECONDITION` out of the `INVALID_ARGUMENT` case; map it to
  `PreconditionFailedError(error.details)`.
- `src/modules/workouts/schemas.ts` — add `exerciseSetEntrySchema` (reuse `setStrategySchema`
  from `exercise-sets/schemas.ts`, made `.optional()`), `workoutExerciseEntrySchema`
  (`sets: z.array(exerciseSetEntrySchema).max(10).default([])`),
  `workoutCreateSchema = workoutInputSchema.extend({ exercises: z.array(workoutExerciseEntrySchema).max(20).default([]) })`,
  and `replaceWorkoutExercisesSchema = z.object({ exercises: z.array(workoutExerciseEntrySchema).max(20) })`.
  Keep `workoutInputSchema` as-is for `PATCH /workouts/:id`.
- `src/modules/workouts/service.ts` — add `WorkoutExerciseEntry`/`ExerciseSetEntry` input types;
  change `createWorkout` to call `CreateWorkoutWithExercises` and return
  `getFullWorkout(...)`; add `replaceWorkoutExercises(workoutId, entries)` calling
  `ReplaceWorkoutExercises` then `getFullWorkout(workoutId)`. Apply the same `withDefaults`-style
  fill-in that `exercise-sets/service.ts` does (numbers → 0, strings → `''`) so proto3 defaults
  are explicit, but leave `strategy` undefined when omitted (§0).
- `src/modules/workouts/routes.ts` — `POST /` under the plan prefix parses
  `workoutCreateSchema` instead of `workoutInputSchema`.
- `src/modules/workout-exercises/routes.ts` — add `app.put('/')` in
  `workoutExercisesUnderWorkoutRoutes`: `requireRole('TRAINER','ADMIN')` →
  `assertOwnsWorkout` → `replaceWorkoutExercisesSchema.parse` →
  `workoutService.replaceWorkoutExercises`.
- `docs/api-contract.md` — under **Workouts**: update the `POST /training-plans/:planId/workouts`
  line with the optional `exercises` body and the `FullWorkout` response; add the
  `PUT /workouts/:workoutId/exercises` line; add `PRECONDITION_FAILED (409)` to the common
  error-codes list at the top, with the one-line explanation from §3.
- `CLAUDE.md` — the `call.ts` sentence listing the status-code mapping needs
  `FAILED_PRECONDITION→409` split out of the `→400` group.

## 5. Tests

The Vitest suite is currently empty; this feature is a reasonable place to seed it, without
spinning up gRPC:

- `src/modules/workouts/schemas.test.ts` — `workoutCreateSchema` accepts a body with no
  `exercises`, accepts 20 exercises / 10 sets, rejects 21 / 11, accepts an entry with no
  `strategy`, rejects a negative `reps`; `replaceWorkoutExercisesSchema` rejects a body without
  `exercises` and accepts `{ exercises: [] }`.
- `src/grpc/call.test.ts` — `mapGrpcError` (export it, or test through `grpcCall` with a stub
  client) turns `FAILED_PRECONDITION` into a 409 `PRECONDITION_FAILED` carrying the upstream
  `details` string, and still turns `INVALID_ARGUMENT` into 400.

End-to-end behavior (caps, nonexistent exercise, recorded-data refusal) is covered upstream by
`WorkoutControllerTest` in `vertice-api`; the BFF does not re-test it.

## 6. Follow-ups (not in this change)

- **Expose "has recorded data" from `vertice-api`.** So the web can decide up front whether a
  workout is still editable as a whole (see §0, last bullet, and the web PRD §6 — the owner accepted the refuse-on-save trade-off until this exists).
  Once an RPC exists, surface it as a `hasRecordedData: boolean` on `GET /workouts/:id/full`.
- The web's "Usar treino existente como base" today goes through `POST /workouts/:id/clone`
  (a separate copy). The web PRD proposes seeding the editor's draft from
  `GET /workouts/:id/full` instead and creating via 2.1 on save — no BFF change needed for that,
  and `POST /workouts/:id/clone` stays as-is; noted here so nobody adds a special endpoint for it.
