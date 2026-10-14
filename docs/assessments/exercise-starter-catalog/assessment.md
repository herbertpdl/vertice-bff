# Technical assessment (BFF): Starter exercise catalog

Status: Draft
Owner: hebertpdl@gmail.com
Related: [`vertice-api` PRD](https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/exercise-starter-catalog/prd.md),
[`vertice-api` assessment](https://github.com/herbertpdl/vertice-api/blob/main/docs/assessments/exercise-starter-catalog/assessment.md),
`docs/specs/create-workout-with-exercises/spec.md` (touched, mapping-style precedent)
Spec: not yet written (will be `docs/specs/exercise-starter-catalog/spec.md`)

## 1. Summary

Overall risk: **High**. This is entirely blocked on `vertice-api`'s own spec/implementation
shipping first — every RPC shape change the PRD needs (multi-group, filtering, ownership-scoped
responses) is unshipped there today (upstream assessment F1/F9/F10). On top of that, investigating
this repo surfaced two things the upstream assessment couldn't see: (1) `GET /exercises` and
`GET /exercises/:id` have **no role restriction today** — any authenticated CLIENT can already
browse the whole catalog and fetch any exercise by id, directly contradicting R21/R22, which this
feature is supposed to *introduce*, not just preserve; and (2) this repo's existing `assertOwns*`
ownership pattern lets `ADMIN` bypass every ownership check by design — copying that pattern for
exercises would violate R25 ("the platform team ... has no ability to see a trainer's private
exercises"). Recommended approach: extend the existing `exercises` module in place (no new
module), add query-param filtering to `GET /`, close the two pre-existing role gaps, and write
`assertOwnsExercise` as a deliberate exception to the ADMIN-bypass convention rather than a copy
of it.

| Id | Severity | One line |
|---|---|---|
| F1 | High | Every RPC shape this feature needs is unshipped on `vertice-api` today — this work can't be implemented or tested until that spec lands |
| F5 | High | `GET /exercises` and `GET /exercises/:id` have no role restriction today — CLIENT can already browse/fetch, contradicting R21/R22 |
| F6 | High | The existing `assertOwns*` convention lets ADMIN bypass ownership — copying it for exercises violates R25 |
| F7 | High | `POST /workouts/:workoutId/exercises` checks workout ownership but never checks the caller owns (or the catalog offers) the `exerciseId` being added — R17/E18 gap |
| F11 | High | No API versioning; `Exercise`'s response shape changes (single group → multiple, plus an ownership/starter indicator) breaks any consumer reading today's shape |
| F16 | High | The `exercises` module has zero tests today — this feature is the first to need coverage for it |

## 2. PRD coverage map

| Rule/Edge | Lands on | Notes |
|---|---|---|
| R1 | existing route: `GET /` (`routes.ts:8`) | response depends on upstream ownership-scoped list (R13–R15) |
| R2 | not exposed | content constraint, no REST effect |
| R3 | new: response shape (multi-group) | see R43 |
| R4 | not exposed | |
| R5 | not exposed | |
| R6 | not exposed | |
| R7 | not exposed | |
| R8 | new (Q1) | whether the 14 groups need their own list endpoint for a picker, or ship as a static client-side list |
| R9 | not exposed | |
| R10 | not exposed | |
| R11 | new: schema/type change (`schemas.ts:3-8`, `service.ts:4-18`) | same change as R43 |
| R12 | not exposed | |
| R13 | existing route, scoping depends on upstream | |
| R14 | existing route `GET /`/`GET /:id` (`service.ts:29-38`) — currently a straight passthrough, no BFF-side scoping | |
| R15 | same as R14 | |
| R16 | existing route `GET /:id` (`routes.ts:11`) | needs identity-forwarding once upstream enforces it (F15) |
| R17 | existing route that must change: `POST /workouts/:workoutId/exercises` (`workout-exercises/routes.ts:21-30`) | F7 — `exerciseId` ownership never checked |
| R18 | existing, already covered: `assertOwnsWorkout` (`workout-exercises/routes.ts:24`) | F8 |
| R19 | existing, already covered: `assertOwnsWorkout` + `assertOwnsPlan` on clone (`workouts/routes.ts:89,92`) | F8 |
| R20 | existing: `GET /workouts/:workoutId/session` embeds exercise data unfiltered (`docs/api-contract.md:115-117`) | |
| R21 | existing route that must change: `GET /` (`routes.ts:8`) | F5 — no role restriction today |
| R22 | existing route that must change: `GET /:id` (`routes.ts:11`) | F5 |
| R23 | existing, already covered: `requireRole('TRAINER','ADMIN')` on `POST /` (`routes.ts:23`) | F9 |
| R24 | existing, already covered: same on `PATCH /:id`/`DELETE /:id` (`routes.ts:31,39`) | F9 |
| R25 | not exposed, but see F6 | no platform-team route exists; the risk is ADMIN's existing ownership-bypass convention leaking into a new `assertOwnsExercise` |
| R26 | existing route, new upstream-error handling: `PATCH /:id` | status code depends on upstream's F13 decision |
| R27 | existing route, new upstream-error handling: `DELETE /:id` | same |
| R28 | new: response field (`isStarterSet`/owner indicator) | `Exercise` type has no such field today (`service.ts:6-11`) |
| R29 | existing (`PATCH /:id`) + new ownership check | |
| R30 | existing (`PATCH /:id`) + new ownership check | |
| R31 | new: Zod validation (non-empty group array on update) | |
| R32 | new: same ownership check as R16 | |
| R33 | not exposed | nothing for the BFF to do |
| R34 | existing mapping, nothing new: `FAILED_PRECONDITION`→409 already wired (`call.ts`) | |
| R35 | existing (`DELETE /:id`) | |
| R36 | new: same ownership check as R32 | |
| R37 | not exposed | no such route exists or should exist |
| R38 | not exposed | same |
| R39 | existing route `POST /` + new: multi-group schema (R43) | |
| R40 | new: Zod validation, non-empty array | |
| R41 | existing (`schemas.ts:5`) | |
| R42 | existing (`schemas.ts:6`, `.url()`) | |
| R43 | new: schema/type change (`schemas.ts:3-8`, `service.ts:4-18`) | |
| R44 | existing/nothing found | no uniqueness check in the BFF, passthrough |
| R45 | new: `GET /` gains a `?muscleGroupId=` query param | `service.ts:29-35` takes no params today |
| R46 | new: `GET /` gains a `?q=` query param | |
| R47 | not exposed | query semantics live upstream; BFF forwards params |
| R48 | not exposed | ordering is upstream's job |
| R49 | not exposed | same |
| R50 | not exposed | same |
| R51 | not exposed | internal to `vertice-api`, one-off migration |
| R52 | not exposed | same |
| R53 | not exposed | same |
| R54 | not exposed | same |
| R55 | not exposed | same |
| R56 | not exposed | same |
| R57 | not exposed | same |
| R58 | not exposed | same |
| R59 | not exposed | same |
| E1 | new (R26) | |
| E2 | new (R27) | |
| E3 | existing/nothing found (R44) | |
| E4 | existing/nothing found (R14/R44) | |
| E5 | existing mapping (R34) | |
| E6 | not exposed (R33) | |
| E7 | existing (R20) | |
| E8 | not exposed (R11/R47) | |
| E9 | not exposed | out of scope, existing R42 path |
| E10 | not exposed | |
| E11 | not exposed | |
| E12 | not exposed | |
| E13 | new (R40) | |
| E14 | existing/nothing found (R15) | |
| E15 | not exposed (R46) | |
| E16 | existing route that must change (R21/R22) | F5 |
| E17 | existing, already covered (R23/R24) | F9 |
| E18 | new (R16/R17) | F7 |
| E19 | existing, already covered (R18) | F8 |
| E20 | existing, already covered (R19) | F8 |
| E21 | new (R32/R36) | |
| E22 | new (R31/R40) | |
| E23 | not exposed (R56–R58) | |

## 3. Current state

`src/modules/exercises/` is a thin passthrough today: `routes.ts` registers `GET /`, `GET /:id`,
`GET /:id/progress`, `POST /`, `PATCH /:id`, `DELETE /:id`; `service.ts` maps 1:1 to
`ExerciseService`'s RPCs with no filtering, composition, or ownership logic of its own;
`schemas.ts` has one Zod schema (`exerciseInputSchema`) with a single required `muscleGroup` enum
(7 values, matching `vertice-api`'s current proto exactly). `docs/api-contract.md:52-61` documents
this accurately — "Shared across all trainers," no role restriction listed on `GET /`/`GET /:id`,
matching the code (no drift found here).

Two things this investigation found that the upstream assessment's own coverage map couldn't see,
because they live entirely in this repo:

- `GET /` and `GET /:id` (`routes.ts:8,11`) have only `app.addHook('preHandler', app.authenticate)`
  — no `requireRole` gate. Any authenticated CLIENT can call both today. `POST /`, `PATCH /:id`,
  `DELETE /:id` already require `TRAINER`/`ADMIN` (`routes.ts:23,31,39`).
- `src/lib/ownership.ts`'s `assertOwnsPlan`/`assertOwnsWorkout`/`assertOwnsWorkoutExercise` all
  let `role === 'ADMIN'` bypass the check by design (`ownership.ts:8-13`) — the existing
  convention in this codebase is "ADMIN sees and touches everything." This directly conflicts with
  R25.

Also found: `POST /workouts/:workoutId/exercises` (`workout-exercises/routes.ts:21-30`) and
`POST /workouts/:id/clone` (`workouts/routes.ts:85-95`) already enforce workout/plan ownership via
`assertOwnsWorkout`/`assertOwnsPlan` — this repo is already ahead of `vertice-api` itself on R18
and R19 (upstream has zero check for either, per the upstream assessment's F12/E19/E20 evidence).
What neither layer checks today is whether the `exerciseId` being attached in
`POST /workouts/:workoutId/exercises` belongs to the caller (R17).

`mapGrpcError` (`src/grpc/call.ts:11-42`) already maps every status code this feature is expected
to introduce: `PERMISSION_DENIED`→403 `FORBIDDEN` (already used by `ownership.ts`'s
`ForbiddenError`) and `FAILED_PRECONDITION`→409 `PRECONDITION_FAILED` (already used for the
"can't touch, something depends on it" case, e.g. `ReplaceWorkoutExercises`'s recorded-data
refusal). No new `HttpError` subclass is needed for anything this feature does.

## 4. Findings by dimension

### Upstream RPC readiness

**F1** [High] — Every RPC shape this feature needs beyond today's plain CRUD is unshipped on
`vertice-api`: `ListExercisesRequest` is still an empty message (no filter/search fields),
`ExerciseRequest.muscle_group` is still a single non-repeated enum, and no ownership/ordering
exists in `ListExercises`'s response at all (`vertice-api` assessment F1, F9, F10, F17). This BFF
work can be spec'd now but not implemented or tested against a real upstream until `vertice-api`
ships its spec.

**F2** [Nothing found] — Checked: whether this repo's local `protos/vertice/exercise/v1/exercise.proto`
is stale relative to `vertice-api`'s. `diff ../vertice-api/src/main/proto/vertice/exercise/v1/exercise.proto
protos/vertice/exercise/v1/exercise.proto` — identical, no drift today. Will need re-copying once
`vertice-api`'s spec changes the message shapes (expected, not a finding in itself).

### Route and schema design

**F3** [Medium] — The `exercises` module (`ls src/modules` confirms it exists) is the right home;
no new module needed. But the schema and type changes are substantial, not incremental:
`muscleGroupSchema` (`schemas.ts:3`, single 7-value enum) needs to become a non-empty array over
the new 14-value set, and every type built on it — `Exercise`, `ExerciseResponse`, `ExerciseInput`
(`service.ts:4-18,46-51`) — reshapes from `muscleGroup: MuscleGroup` to a list, plus gains the new
ownership/starter-set field (R28).

**F4** [Medium] — R45/R46 need new optional query params on the existing `GET /` route
(`muscleGroupId`, `q` or similar) — consistent with this repo's existing idiom for filtered lists
(`GET /training-plans?clientId=`, `docs/api-contract.md:64`). No new endpoint needed.

### Auth, roles, and ownership

**F5** [High] — `GET /` and `GET /:id` (`routes.ts:8,11`) have no `requireRole` gate today — only
`app.authenticate`. Any authenticated CLIENT can already browse the entire catalog and fetch any
exercise by id, which is exactly what R21/R22/E16 says must be refused. This is an **existing gap
the feature must close**, not new behavior being added from a blank slate — `docs/api-contract.md`
confirms the doc matches the code (no role listed for either route). *Recommendation:* add
`app.requireRole('TRAINER', 'ADMIN')` (or an explicit CLIENT-membership check for `GET /:id`,
since R20 still requires a client to reach exercises inside their own workouts through the session
endpoints, just not through this route directly).

**F6** [High] — `assertOwnsPlan`/`assertOwnsWorkout`/`assertOwnsWorkoutExercise` all bypass the
check entirely for `role === 'ADMIN'` (`ownership.ts:8-13`) — this codebase's established
convention is "ADMIN sees and touches everything." R25 requires the opposite specifically for
exercises: *"The platform team ... has no ability to see a trainer's private exercises."* If a
new `assertOwnsExercise` is written by copying the existing `assertOwns*` shape, it silently
violates R25 the moment an ADMIN account calls `GET /exercises/:id` or
`POST /workouts/:workoutId/exercises` with another trainer's private exercise id.
*Recommendation:* the spec must call this out explicitly as a deliberate deviation from the
existing ownership-check convention, not an oversight for a future reader to "fix" back to match
the pattern.

**F7** [High] — `POST /workouts/:workoutId/exercises` (`workout-exercises/routes.ts:21-30`) checks
`assertOwnsWorkout(req.user!, workoutId)` but never validates `body.exerciseId`
(`workout-exercises/schemas.ts:3`, caller-supplied, unchecked) against the caller's own
exercises/the starter set. A trainer who knows another trainer's private exercise id can attach it
to their own (owned) workout today, and nothing in this feature's coverage map above closes that
specifically — it's a gap in *this* route, not just in `vertice-api`'s `WorkoutExerciseService`
(R17/E18). *Recommendation:* extend this route with the same kind of exercise-ownership check
`GET /exercises/:id` needs, not just add it there.

**F8** [Nothing found] — Checked: R18/E19 (workout ownership when adding an exercise) and R19/E20
(both-sides ownership on clone). Both already fully enforced: `assertOwnsWorkout` on
`POST /workouts/:workoutId/exercises` (`workout-exercises/routes.ts:24`), and
`assertOwnsWorkout` + `assertOwnsPlan` on `POST /workouts/:id/clone`
(`workouts/routes.ts:89,92`) — this repo is already ahead of `vertice-api` itself here. Re-verify
these still pass once `vertice-api`'s own ownership checks land underneath (nothing should change
at this layer).

**F9** [Nothing found] — Checked: R23/R24/E17 (CLIENT refused from create/update/delete). Already
enforced via `requireRole('TRAINER', 'ADMIN')` on `POST /`, `PATCH /:id`, `DELETE /:id`
(`routes.ts:23,31,39`). Nothing to add.

### Error mapping

**F10** [Nothing found] — Checked: whether `mapGrpcError` (`call.ts:11-42`) already covers the
status codes this feature introduces. It does: `PERMISSION_DENIED`→403 `FORBIDDEN` and
`FAILED_PRECONDITION`→409 `PRECONDITION_FAILED` both exist today, and `ForbiddenError` is already
the exception `ownership.ts`'s checks throw. This is evidence worth feeding back into the
upstream assessment's still-open question (its F13, the `NOT_FOUND` vs. `PERMISSION_DENIED`
choice for cross-trainer refusals) — this repo already expects and cleanly maps
`PERMISSION_DENIED`, which favors that choice over folding ownership refusals into `NOT_FOUND`.

### Backward compatibility

**F11** [High] — No API versioning exists (`grep -rn "api/v" src` — no hits): a breaking response
shape hits every deployed web client at once. `Exercise`'s shape (single `muscleGroup` string →
multiple groups, plus a new ownership/starter-set field for R28) is exactly that kind of change,
same underlying break as the upstream assessment's F9 one layer up. Practical blast radius today
is zero — `vertice-web-react` is currently a skeleton with no features wired up yet, per this
repo's own `CLAUDE.md` — but that should be stated as a currently-true fact, not assumed.

### Composed/aggregate endpoint impact

**F12** [Medium] — `GET /workouts/:workoutId/session` already embeds each exercise's data inline
as part of `FullWorkoutExercise` (`docs/api-contract.md:115-117`) for the client
workout-execution screen. Once `Exercise`'s shape changes (F11), this composed endpoint's response
changes too, even though this feature doesn't touch `workout-sessions` code directly.
*Recommendation:* audit every composed endpoint that embeds `Exercise` (session, and check
`workouts/:id/full`) for the same shape change, not just this module's own routes.

### Performance

**F13** [Nothing found] — Checked: N+1 risk from adding `muscleGroupId`/`q` query params to
`GET /`. Still one upstream call with request fields added (`service.ts:29-35`), not a loop. No
pagination exists upstream or here (`grep -rn "page_size\|page_token\|Pageable" protos/ src/` — no
hits), unchanged by this feature.

### Security and privacy

**F14** [Nothing found] — Checked: this feature doesn't add new sanitization surface. This repo
forwards whatever `vertice-api` returns and doesn't sanitize `videoUrl`/`description` itself
(unchanged baseline); `exerciseInputSchema`'s existing `.url()` check (`schemas.ts:6`) is the only
validation here, matching what `vertice-api` already validates independently.

**F15** [Medium] — This session found a more precise version of the upstream assessment's F12/F29:
`src/grpc/clients.ts`'s insecure-credentials comment is specifically about **transport** (no TLS,
documented as an intentional local-only choice) — a narrower, separate fact from the real gap,
which is that **no call anywhere in this codebase attaches the caller's identity as gRPC
metadata**: `grpcCall`'s `metadata` parameter defaults to an empty `Metadata()` and nothing
overrides it (`grep -rln "Metadata" src/modules` — zero hits). Whatever mechanism the upstream
spec picks for identity to cross this boundary has to be implemented at this repo's call sites (or
as a shared interceptor around `grpcCall`), not assumed to already exist here.

### Testing

**F16** [High] — `find src -name "*.test.ts"` returns exactly two files in this entire repo
(`src/grpc/call.test.ts`, `src/modules/workouts/schemas.test.ts`) — `exercises` has zero tests
today. This feature is the first to need coverage for this module: the new multi-group schema's
edge cases, the two new query params, the two closed role gaps (F5), and the new ownership check
(F7).

### Documentation

**F17** [Medium] — `docs/api-contract.md:52-61` (Exercises section) needs a full rewrite: new
query params, new request/response shape, the role restrictions this feature adds to `GET /`/
`GET /:id`, and any new error codes. If F12's audit finds the session/full-workout composed
endpoints' embedded `Exercise` shape changes too, their sections need the same update.

## 5. Options

No materially different implementation paths were found — the feature extends the existing
`exercises` module and two existing routes (`workout-exercises`, `workouts` clone) in place;
nothing here is a genuine "new module vs. extend" or "new endpoint vs. extend" choice the way
`create-workout-with-exercises` had.

## 6. Testing strategy

- **Zod schema tests** (`exercises/schemas.test.ts`, new file): the multi-group array — empty
  rejected (R40/E13), single group accepted, multiple accepted (R43); `videoUrl` optional-or-blank
  behavior unchanged (R42) as a regression check while the schema is being reshaped.
- **`mapGrpcError` branch check**: no new branch needed (F10), but add a case to
  `call.test.ts`'s existing suite asserting `PERMISSION_DENIED` → 403 specifically for an exercise
  ownership refusal, once the upstream status-code decision (its F13) is confirmed.
- **Route-level tests for the two closed gaps (F5)**: CLIENT gets 403 from `GET /` and
  `GET /:id`; TRAINER/ADMIN still succeed.
- **Route-level test for F7**: a TRAINER adding another trainer's private `exerciseId` to their
  own (owned) workout via `POST /workouts/:workoutId/exercises` gets refused.
- **F6's ADMIN case**: an explicit test that ADMIN does *not* bypass the new exercise-ownership
  check, the one place in this repo an `assertOwns*`-shaped check must NOT follow the existing
  ADMIN-bypass convention — worth a named regression test precisely because it's the exception.

## 7. Rollout

Fully gated on `vertice-api` (F1): this repo's routes cannot be implemented against a real
upstream, and cannot be meaningfully tested end-to-end, until `vertice-api`'s spec ships its new
RPC shapes. Once it has: no old-BFF-vs-new-API coexistence is possible for the changed fields
(F11) since there's no versioning; the two role gaps (F5) and the identity-forwarding mechanism
(F15) should land in the same deploy as the upstream ownership enforcement, or the BFF is either
newly broken (calls start failing once vertice-api requires identity it never receives) or still
silently under-enforcing (R21/R22 stay open) depending on deploy order.
`docs/api-contract.md`/`CLAUDE.md` updates (F17) should land in the same PR as the code, per this
repo's own convention.

## 8. Effort and risk

**Size: L.** Smaller than the upstream `vertice-api` work (no data model or migration of its own
here), but touches three modules (`exercises`, `workout-exercises`, `workouts`), closes two
pre-existing security gaps unrelated to the new feature (F5), and needs the first test coverage
this module has ever had (F16). Entirely gated on `vertice-api` shipping its spec first (F1) — realistic
sequencing is: land the two role-gap fixes (F5) and the exercise-ownership check on
`POST /workouts/:workoutId/exercises` (F7) independently and early (they're valid fixes regardless
of this feature and don't need the upstream spec), then the rest once `vertice-api`'s new RPC
shapes exist.

## 9. Questions and assumptions

- **Q1: does the web need a way to list/enumerate the 14 muscle groups for a filter/picker UI**,
  or is a static client-side list (matching the PRD's fixed launch set, PRD §10) sufficient,
  making a `GET /muscle-groups` route unnecessary? Assumption until answered: no new route —
  ship the 14 names as a static list in the web app, since the PRD frames the group list as fixed
  at launch (R8) and only changeable by direct platform-team action (R38, no route exists for it
  either).

None of the questions the upstream assessment already resolved (identity-resolution direction,
pre-starter data safety) need re-asking here — this assessment assumes both as that document
recorded them.

## 10. Inputs to the spec

- [ ] Whether `GET /muscle-groups` ships or the web hardcodes the 14 names (Q1)
- [ ] How `assertOwnsExercise` is written as a deliberate exception to the ADMIN-bypass convention, not a copy of it (F6)
- [ ] The exercise-ownership check added to `POST /workouts/:workoutId/exercises`, closing F7/R17/E18
- [ ] The response field carrying the ownership/starter-set indicator for R28 (F3)
- [ ] The new `Exercise`/`ExerciseInput`/`ExerciseResponse` shapes for multi-group (F3, ties to upstream F9)
- [ ] The query-param names and forwarding for R45/R46 (F4)
- [ ] Deploy-ordering plan for the two closed role gaps (F5) relative to `vertice-api`'s own rollout (F1, §7)
- [ ] Whether `docs/api-contract.md`'s session/full-workout sections need the same `Exercise`-shape update (F12)
