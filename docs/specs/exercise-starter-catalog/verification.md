# Verification: Starter exercise catalog (vertice-bff)

Spec: `docs/specs/exercise-starter-catalog/spec.md`
PRD: https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/exercise-starter-catalog/prd.md
Status: Draft — update the checklist marks as PRs are verified

## How to use this document

You are verifying an implementation against the spec above. Run the section for the PR you were
asked about (§1.<n>), or all of §1 plus §2 for the whole feature. For every check record PASS,
FAIL, or NOT CHECKED with the evidence (command output, response body, screenshot description).
A FAIL on a "must not change" check is as serious as one on a "must change" check. Report in the
format of §3.

Every `curl` below is against `http://localhost:3000/api`. `$T1`, `$T2`, `$C1`, `$A1` are the
bearer tokens from §0. Response bodies are shown as the JSON the check expects; extra fields are
a FAIL when the check says "exactly", otherwise only the shown fields are asserted. `jq` is
assumed for extracting ids; substitute by hand if it is missing.

## 0. Preconditions

- **Branch/PR under test:** the PR's branch checked out in `/Users/herbertlago/Workspace/vertice-bff`;
  base: `main`, which must already contain the `feat/create-workout-with-exercises` merge (check:
  `git log main --oneline | grep -i "create-workout-with-exercises"` is non-empty and
  `src/grpc/call.test.ts` exists on `main`). If it does not, stop: the spec's base-branch decision
  (§0) is unmet and every check below is NOT CHECKED.
- **Environment (from CLAUDE.md):**
  - `cd /Users/herbertlago/Workspace/vertice-api && docker compose up -d && ./gradlew bootRun --args='--spring.profiles.active=local'`
    (gRPC on `:9090`, reflection on). Which `vertice-api` version each section needs is stated
    at the top of that section: "vertice-api Increment 0 on main" (shared-secret decoder,
    `CallerIdentity` resolver, no RPC requires identity yet), "vertice-api Increment 1 on main"
    (`ListMuscleGroups` and the changed `ExerciseService` RPCs, starter set seeded, pre-starter
    cleanup run), "vertice-api Increment 2 on main" (R17–R19 guards on the workout-side RPCs).
  - `cd /Users/herbertlago/Workspace/vertice-bff && cp .env.example .env && npm install && npm run dev`
    (REST on `:3000`). `.env` must have `JWT_SECRET=dev-secret-change-me`, the same value
    `vertice-api` uses (its default). Check: `grep JWT_SECRET .env`.
- **Tokens.** `POST /auth/login` accepts **any non-empty password for an existing email**
  (CLAUDE.md, "Known MVP limitation"), so a token for any user is one call away once the user
  exists. CPFs must be 11 digits with valid check digits and unique; the ones below are valid.
  - **TRAINER T1** — create (once):
    `curl -s -X POST localhost:3000/api/auth/register -H 'content-type: application/json' -d '{"name":"Trainer One","email":"t1@vertice.test","password":"secret1","role":"TRAINER","cpf":"52998224725"}'`
    → `201 {"token":"...","user":{...,"role":"TRAINER"}}`. Afterwards (or if it already exists,
    `409 CONFLICT`): `T1=$(curl -s -X POST localhost:3000/api/auth/login -H 'content-type: application/json' -d '{"email":"t1@vertice.test","password":"x"}' | jq -r .token)`.
    `T1_ID` = `user.id` from the same response.
  - **TRAINER T2** — same with `"email":"t2@vertice.test","cpf":"11144477735"` → `$T2`.
  - **CLIENT C1** (a client of T1) — created by T1:
    `curl -s -X POST localhost:3000/api/clients -H "authorization: Bearer $T1" -H 'content-type: application/json' -d '{"name":"Client One","email":"c1@vertice.test","cpf":"12345678909"}'`
    → `201`, note `id` as `C1_ID`. Then
    `C1=$(curl -s -X POST localhost:3000/api/auth/login -H 'content-type: application/json' -d '{"email":"c1@vertice.test","password":"x"}' | jq -r .token)`.
  - **ADMIN A1** — `POST /auth/register` only accepts `TRAINER`/`CLIENT`, so create the user
    directly on `vertice-api` (local profile, reflection on):
    `grpcurl -plaintext -d '{"name":"Admin One","email":"a1@vertice.test","password":"secret1","cpf":"98765432100","role":"ADMIN"}' localhost:9090 vertice.user.v1.UserService/CreateUser`
    then `A1=$(curl -s -X POST localhost:3000/api/auth/login -H 'content-type: application/json' -d '{"email":"a1@vertice.test","password":"x"}' | jq -r .token)`.
- **Data** (needed from §1.2 on; a fresh database plus the four users is enough for §1.1):
  - Starter set: present once vertice-api Increment 1 is on main (its migration seeds 14 groups
    and 199 exercises). Find one starter id:
    `S1=$(curl -s "localhost:3000/api/exercises?q=Supino%20reto%20com%20barra" -H "authorization: Bearer $T1" | jq '.[] | select(.isStarter) | .id' | head -1)`.
  - `X1` — T1's private exercise:
    `X1=$(curl -s -X POST localhost:3000/api/exercises -H "authorization: Bearer $T1" -H 'content-type: application/json' -d '{"name":"Remada do T1","muscleGroupIds":[2,12]}' | jq .id)`.
  - `X2` — T2's private exercise: same with `$T2` and `"name":"Remada do T2"` → `X2`.
  - `P1` — T1's plan for C1:
    `P1=$(curl -s -X POST localhost:3000/api/training-plans -H "authorization: Bearer $T1" -H 'content-type: application/json' -d "{\"name\":\"Plano C1\",\"clientId\":$C1_ID,\"startDate\":\"2026-09-21\",\"endDate\":\"2026-12-21\",\"level\":\"BEGINNER\"}" | jq .id)`.
  - `W1` — a workout in P1 using X1 and S1:
    `W1=$(curl -s -X POST localhost:3000/api/training-plans/$P1/workouts -H "authorization: Bearer $T1" -H 'content-type: application/json' -d "{\"name\":\"Treino A\",\"dayOfWeek\":\"MONDAY\",\"exercises\":[{\"exerciseId\":$X1},{\"exerciseId\":$S1}]}" | jq .id)`.
  - `P2` — T2's plan for a client of T2 (create `c2@vertice.test`, cpf `39053344705`, as T2 the
    way C1 was created, then a plan as above with `$T2`) → `P2`. Needed by §1.3 only.
- **Tooling:** `curl`, `jq`, `grpcurl` (ADMIN creation only), `git`, `npm`.

## 1. Per-PR checks

### 1.1 PR1 — Forward the caller's JWT as gRPC metadata on every upstream call

Needs: any `vertice-api` for B1–B2 (today's main or Increment 0); **vertice-api Increment 1 on
main** for B3–B4 (the first RPCs that require identity — if it is not available yet, mark B3–B4
NOT CHECKED and rely on the automated checks, which are the primary proof for this PR).

**Automated**
- [ ] `npm test` passes and `src/grpc/call.test.ts` contains, by name:
      `grpcCall attaches "authorization: Bearer <token>" metadata when the request context holds a token`,
      `grpcCall sends no authorization metadata outside a request context`,
      `grpcCall keeps caller-supplied metadata and adds the bearer to it`,
      `mapGrpcError maps PERMISSION_DENIED to 403 FORBIDDEN with the upstream message verbatim`,
      and still contains the three pre-existing `mapGrpcError` cases (`FAILED_PRECONDITION`,
      `INVALID_ARGUMENT`, `NOT_FOUND`). Evidence: `npx vitest run src/grpc/call.test.ts` output lists all seven.
- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes.

**Behavior** (each one: preconditions → action → expected)
- [ ] B1: BFF up against any vertice-api; `$T1` valid.
      `curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/auth/me -H "authorization: Bearer $T1"` → `200`
      and `curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/exercises -H "authorization: Bearer $T1"` → `200`.
      Covers: Increment 0 is harmless to an API that ignores the metadata (spec §6).
- [ ] B2: unauthenticated routes still work with no token to forward.
      `curl -s -o /dev/null -w '%{http_code}' localhost:3000/health` → `200`;
      `curl -s -X POST localhost:3000/api/auth/login -H 'content-type: application/json' -d '{"email":"t1@vertice.test","password":"x"}'` → `200` with a `token`;
      the same login with an extra stale header `-H 'authorization: Bearer not.a.jwt'` → still `200`
      (the unverified header is not relayed). Covers: spec §0 "only a verified token is forwarded".
- [ ] B3: **vertice-api Increment 1 on main** (so `ListExercises` requires identity), same
      `JWT_SECRET` on both sides. `curl -s localhost:3000/api/exercises -H "authorization: Bearer $T1" -w '\n%{http_code}'`
      → `200` and a JSON array (not `401 {"error":{"code":"UNAUTHENTICATED",...}}`). Covers: D1 end to end.
- [ ] B4: same setup; restart the BFF with `JWT_SECRET=some-other-secret npm run dev`, mint a new
      `$T1` from it, and repeat B3 → `401` with `error.code` `UNAUTHENTICATED` (upstream rejected
      the forwarded token: proof the token is actually sent and verified). Restore `.env` and
      restart afterwards. Covers: D1 mechanics.

**Scope decisions honored**
- [ ] S1: "an AsyncLocalStorage request context, not an explicit parameter — `src/modules/**` and
      `src/lib/ownership.ts` untouched". Evidence: `git diff main --stat -- src/modules src/lib/ownership.ts` → empty.
- [ ] S2: "only a token `app.authenticate` has verified is forwarded". Evidence: code read of
      `src/plugins/authenticate.ts` — the store's `bearerToken` is assigned only after
      `verifyToken` returns; `src/plugins/request-context.ts` creates the store empty with
      `requestContext.run({}, done)` in an `onRequest` hook (callback style, not `async`).
- [ ] S3: "`.env.example` gets `JWT_SECRET=dev-secret-change-me`". Evidence: `grep -n JWT_SECRET .env.example` → that value with a comment naming vertice-api.
- [ ] S4: "no new dependency". Evidence: `git diff main -- package.json` → empty.
- [ ] S5: `withCallerIdentity` does not overwrite a caller-supplied `authorization`. Evidence: the third `call.test.ts` case above passes.

**Must not change**
- [ ] N1: `grpcCall`'s signature. Evidence: `grep -n "export function grpcCall" -A 5 src/grpc/call.ts` → still `(client, method, request, metadata: grpc.Metadata = new grpc.Metadata())`.
- [ ] N2: `mapGrpcError` mapping table. Evidence: `git diff main -- src/grpc/call.ts` shows no changed `case` lines.
- [ ] N3: no proto changed. Evidence: `git diff main --stat -- protos` → empty.
- [ ] N4: `docs/api-contract.md` endpoint sections unchanged (this PR changes no REST behavior). Evidence: `git diff main --stat -- docs/api-contract.md` → empty.
- [ ] N5: CLAUDE.md gained the identity-metadata sentence and nothing else was removed. Evidence: `git diff main -- CLAUDE.md` shows only additions in the gRPC-bridge and Auth paragraphs.

### 1.2 PR2 — Exercises module on the starter-catalog `ExerciseService` contract

Needs: **vertice-api Increment 1 on main** (all six `ExerciseService` RPCs per the spec's §1
proto block, starter set seeded, pre-starter cleanup run), vertice-api Increment 0 on main, PR1
merged, the §0 data (`S1`, `X1`, `X2`, `P1`, `W1`).

**Automated**
- [ ] `npm test` passes and includes, in `src/modules/exercises/schemas.test.ts`:
      `rejects an empty muscleGroupIds`,
      `rejects a body without muscleGroupIds even when it carries the retired muscleGroup field`,
      `accepts a single muscle group`,
      `accepts several muscle groups and de-duplicates them keeping first occurrence`,
      `rejects a non-integer or non-positive muscle group id`,
      `keeps videoUrl optional-or-blank and rejects a non-URL`,
      `rejects name longer than 255, description longer than 255, videoUrl longer than 500`,
      `defaults description to ''`,
      `treats empty muscleGroupId and q as absent`,
      `coerces muscleGroupId to a positive integer`,
      `trims q and rejects more than 100 characters`;
      in `src/modules/exercises/service.test.ts`:
      `toExercise converts int64 strings to numbers, keeps muscleGroups in upstream order and passes isStarter through`,
      `toExercise yields an empty muscleGroups array when upstream sends none`;
      in `src/modules/exercises/routes.test.ts`:
      `GET /api/exercises with a CLIENT token is refused with 403 FORBIDDEN before any upstream call`,
      `GET /api/exercises without a token is 401 UNAUTHORIZED`,
      `GET /api/exercises?muscleGroupId=abc with a TRAINER token is 400 VALIDATION_ERROR`,
      `GET /api/muscle-groups without a token is 401 UNAUTHORIZED`,
      `POST /api/exercises with an ADMIN token is 403 FORBIDDEN`,
      `POST /api/exercises with a CLIENT token is 403 FORBIDDEN`,
      `PATCH and DELETE /api/exercises/:id with a CLIENT token are 403 FORBIDDEN`,
      `POST /api/exercises with a TRAINER token and muscleGroupIds: [] is 400 VALIDATION_ERROR with a details.fieldErrors.muscleGroupIds entry`,
      `GET /api/exercises/:id has no role gate`.
      Evidence: `npx vitest run src/modules/exercises` output lists every name.
- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes.
- [ ] `diff /Users/herbertlago/Workspace/vertice-api/src/main/proto/vertice/exercise/v1/exercise.proto protos/vertice/exercise/v1/exercise.proto` → empty (proto sync, spec §1), and the BFF copy contains `rpc ListMuscleGroups`, `reserved 5;`, `repeated MuscleGroupResponse muscle_groups = 6;`, `bool is_starter = 7;`, `repeated int64 muscle_group_ids = 5;`, `int64 muscle_group_id = 1;`, `string search = 2;` and no `enum MuscleGroup`.

**Behavior**
- [ ] B1: `curl -s localhost:3000/api/muscle-groups -H "authorization: Bearer $C1"` → `200`, exactly 14
      objects, each `{"id":<n>,"name":"<str>"}` and nothing else, ids `1..14` ascending, names in order:
      Peito, Costas, Ombros, Bíceps, Tríceps, Antebraço, Quadríceps, Posteriores de coxa, Glúteos,
      Panturrilhas, Abdômen, Lombar, Trapézio, Cardio. (A CLIENT token is used on purpose: any role.)
      Covers: R8, D6, spec §2.1.
- [ ] B2: `curl -s localhost:3000/api/muscle-groups -w '\n%{http_code}'` (no token) →
      `401 {"error":{"code":"UNAUTHORIZED","message":"Missing bearer token"}}`. Covers: spec §2.1.
- [ ] B3: `curl -s localhost:3000/api/exercises -H "authorization: Bearer $T1"` → `200`; every
      element has keys `id, name, description, videoUrl, muscleGroups, isStarter` and **no
      `muscleGroup` key**; the first element is `{"id":<X1>,"name":"Remada do T1",...,"muscleGroups":[{"id":2,"name":"Costas"},{"id":12,"name":"Lombar"}],"isStarter":false}`
      (own first); every later element has `isStarter: true`; the array contains no element named
      `Remada do T2`; length is `1 + 199`. Covers: R1, R13, R14, R15, R48, D5, spec §2.2.
- [ ] B4: `curl -s localhost:3000/api/exercises -H "authorization: Bearer $C1" -w '\n%{http_code}'` →
      `403 {"error":{"code":"FORBIDDEN","message":"Requires role: TRAINER or ADMIN"}}`. Covers: R21/E16 (assessment F5).
- [ ] B5: `curl -s localhost:3000/api/exercises -H "authorization: Bearer $A1"` → `200`, every element
      `isStarter: true`, none named `Remada do T1` or `Remada do T2`, length 199. Covers: R25, D5.
- [ ] B6: `curl -s "localhost:3000/api/exercises?muscleGroupId=12" -H "authorization: Bearer $T1"` → `200`;
      element 0 is `Remada do T1` (own first); the first starter element is
      `Hiperextensão lombar no banco romano`, followed by `Hiperextensão lombar na máquina`,
      `Superman no solo` (PRD §10 Lombar order); the array also contains `Levantamento terra com barra`
      (secondary group, E8) somewhere after the seven primary-Lombar rows; no element lacks a
      `muscleGroups` entry with `id: 12`. Covers: R45, R47, R49, R50, E8; "not re-sorted" (spec §0).
- [ ] B7: `curl -s "localhost:3000/api/exercises?q=supino%20RETO" -H "authorization: Bearer $T1"` → `200`,
      every `name` contains `Supino reto` case-insensitively, and `Supino reto com barra` is present.
      `curl -s "localhost:3000/api/exercises?muscleGroupId=&q=" -H "authorization: Bearer $T1"` → `200`
      with the same length as B3 (empty = absent). Covers: R46, E15, spec §0/§2.2.
- [ ] B8: `curl -s "localhost:3000/api/exercises?q=x" -H "authorization: Bearer $T2"` → `200` and no
      element named `Remada do T1` (a search cannot reach another trainer's exercise). Covers: E14.
- [ ] B9: bad query values, `$T1`:
      `?muscleGroupId=999` → `404 {"error":{"code":"NOT_FOUND","message":"MuscleGroup with id 999 not found"}}`;
      `?muscleGroupId=abc` → `400`, `error.code` `VALIDATION_ERROR`, `details.fieldErrors.muscleGroupId` present;
      `?muscleGroupId=0` → `400 VALIDATION_ERROR`;
      `?q=$(printf 'a%.0s' {1..101})` → `400 VALIDATION_ERROR` with `details.fieldErrors.q`. Covers: spec §2.2/§3.
- [ ] B10: `curl -s localhost:3000/api/exercises/$X2 -H "authorization: Bearer $T1" -w '\n%{http_code}'` →
      `403 {"error":{"code":"FORBIDDEN","message":"You do not have access to exercise <X2>"}}`;
      `curl -s localhost:3000/api/exercises/999999 -H "authorization: Bearer $T1"` → `404`, `error.code` `NOT_FOUND`;
      `curl -s localhost:3000/api/exercises/$X1 -H "authorization: Bearer $T1"` → `200` with `"id":<X1>,"isStarter":false`;
      `curl -s localhost:3000/api/exercises/$S1 -H "authorization: Bearer $T1"` → `200` with `"isStarter":true`.
      Covers: R16/E18, D2, spec §2.3.
- [ ] B11: `curl -s localhost:3000/api/exercises/$X1 -H "authorization: Bearer $A1"` → `403 FORBIDDEN`;
      `curl -s localhost:3000/api/exercises/$S1 -H "authorization: Bearer $A1"` → `200`. Covers: R25, D5.
- [ ] B12: CLIENT and exercises inside/outside own workouts:
      `curl -s localhost:3000/api/exercises/$X1 -H "authorization: Bearer $C1"` → `200` (X1 is in W1, a workout of C1's plan P1);
      `curl -s localhost:3000/api/exercises/$X2 -H "authorization: Bearer $C1"` → `403 FORBIDDEN`. Covers: R20, R22, E7, E16.
- [ ] B13: `curl -s -X POST localhost:3000/api/exercises -H "authorization: Bearer $T1" -H 'content-type: application/json' -d '{"name":"Rosca do T1","description":"d","videoUrl":"https://v.test/1","muscleGroupIds":[4,4,6]}' -w '\n%{http_code}'`
      → `201` and body `{"id":<new>,"name":"Rosca do T1","description":"d","videoUrl":"https://v.test/1","muscleGroups":[{"id":4,"name":"Bíceps"},{"id":6,"name":"Antebraço"}],"isStarter":false}`
      (duplicate `4` collapsed, order kept). Record the id as `X3`. Covers: R39, R41, R42, R43, spec §2.4, de-dup decision.
- [ ] B14: `POST /api/exercises` as `$T1` with each body → expected:
      `{"name":"Sem grupo","muscleGroupIds":[]}` → `400 VALIDATION_ERROR`, `details.fieldErrors.muscleGroupIds` present (Zod, never reaches upstream);
      `{"name":"Grupo velho","muscleGroup":"CHEST"}` → `400 VALIDATION_ERROR` (`muscleGroupIds` missing);
      `{"name":"Grupo inexistente","muscleGroupIds":[999]}` → `400 {"error":{"code":"VALIDATION_ERROR","message":"muscleGroupIds: unknown muscle group 999"}}` (upstream);
      `{"name":"   ","muscleGroupIds":[1]}` → `400`, message `name: must not be blank` (upstream);
      `{"name":"Supino reto com barra","muscleGroupIds":[1]}` → `201` (duplicate name allowed; delete it afterwards with `DELETE /exercises/<id>` → `204`).
      Covers: R40/E13, R44/E3, D9, spec §3.
- [ ] B15: role gate on writes:
      `curl -s -X POST localhost:3000/api/exercises -H "authorization: Bearer $C1" -H 'content-type: application/json' -d '{"name":"x","muscleGroupIds":[1]}' -w '\n%{http_code}'` → `403 {"error":{"code":"FORBIDDEN","message":"Requires role: TRAINER"}}`;
      same with `$A1` → `403`, same body;
      `curl -s -X PATCH localhost:3000/api/exercises/$X1 -H "authorization: Bearer $C1" ... -d '{"name":"x","muscleGroupIds":[1]}'` → `403`;
      `curl -s -X DELETE localhost:3000/api/exercises/$X1 -H "authorization: Bearer $C1"` → `403`. Covers: R23, R24, E17, D5.
- [ ] B16: `curl -s -X PATCH localhost:3000/api/exercises/$S1 -H "authorization: Bearer $T1" -H 'content-type: application/json' -d '{"name":"Supino renomeado","muscleGroupIds":[1]}' -w '\n%{http_code}'`
      → `403 {"error":{"code":"FORBIDDEN","message":"Exercise <S1> belongs to the shared starter set and cannot be changed"}}`;
      `GET /exercises/$S1` afterwards still has the original name. Covers: R26/E1, D3.
- [ ] B17: `curl -s -X PATCH localhost:3000/api/exercises/$X2 -H "authorization: Bearer $T1" ... -d '{"name":"x","muscleGroupIds":[1]}'`
      → `403 {"error":{"code":"FORBIDDEN","message":"You do not have access to exercise <X2>"}}`;
      `PATCH /exercises/999999` as `$T1` → `404 NOT_FOUND`. Covers: R32/E21, D2.
- [ ] B18: `curl -s -X PATCH localhost:3000/api/exercises/$X1 -H "authorization: Bearer $T1" ... -d '{"name":"Remada do T1 v2","description":"nova","videoUrl":"https://v.test/2","muscleGroupIds":[2]}'`
      → `200 {"id":<X1>,"name":"Remada do T1 v2","description":"nova","videoUrl":"https://v.test/2","muscleGroups":[{"id":2,"name":"Costas"}],"isStarter":false}`
      (Lombar removed — full replacement);
      then `PATCH` with `"muscleGroupIds":[]` → `400 VALIDATION_ERROR` and `GET /exercises/$X1` still shows `[{"id":2,...}]`. Covers: R29, R30, R31/E22, D11, spec §2.5.
- [ ] B19: `curl -s -X DELETE localhost:3000/api/exercises/$S1 -H "authorization: Bearer $T1" -w '\n%{http_code}'`
      → `403 {"error":{"code":"FORBIDDEN","message":"Exercise <S1> belongs to the shared starter set and cannot be deleted"}}`;
      `DELETE /exercises/$X2` as `$T1` → `403 ... "You do not have access to exercise <X2>"`;
      `DELETE /exercises/999999` as `$T1` → `404`. Covers: R27/E2, R36/E21, D2, D3.
- [ ] B20: `curl -s -X DELETE localhost:3000/api/exercises/$X1 -H "authorization: Bearer $T1" -w '\n%{http_code}'`
      (X1 is used by W1) → `409 {"error":{"code":"PRECONDITION_FAILED","message":"Exercise <X1> is used by a workout and cannot be deleted"}}`;
      then `curl -s -X DELETE localhost:3000/api/exercises/$X3 -H "authorization: Bearer $T1" -w '%{http_code}'` (unused) → `204` with empty body;
      `DELETE /exercises/$X3` again → `404`. Covers: R34/E5, R35, D4, spec §2.6.
- [ ] B21: composed shape. `curl -s localhost:3000/api/workouts/$W1/full -H "authorization: Bearer $T1"` → `200`;
      `exercises[0].exercise` is `{"id":<X1>,...,"muscleGroups":[{"id":2,"name":"Costas"}],"isStarter":false}` and
      `exercises[1].exercise` has `"isStarter":true`; no `exercise.muscleGroup` key anywhere.
      `curl -s "localhost:3000/api/workouts/$W1/session" -H "authorization: Bearer $C1"` → `200` with the same embedded shape under `exercises[].exercise`.
      `curl -s -X PUT localhost:3000/api/workouts/$W1/exercises -H "authorization: Bearer $T1" -H 'content-type: application/json' -d "{\"exercises\":[{\"exerciseId\":$X1},{\"exerciseId\":$S1}]}"` → `200`, same embedded shape.
      Covers: R20/E7, spec §2.8, assessment F12.
- [ ] B22: `curl -s localhost:3000/api/workouts/$W1/full -H "authorization: Bearer $A1" -w '\n%{http_code}'`
      → `403 {"error":{"code":"FORBIDDEN","message":"You do not have access to exercise <X1>"}}`
      (the accepted D5/D10 consequence: ADMIN passes `assertOwnsWorkout` and the embedded `GetExercise` refuses). Covers: spec §2.8, D10.

**Scope decisions honored**
- [ ] S1: "no `assertOwnsExercise` is written; `POST /workouts/:workoutId/exercises` gains no `exerciseId` check" (D10).
      Evidence: `grep -rn "assertOwnsExercise\|OwnsExercise" src` → no hits; `git diff main --stat -- src/lib/ownership.ts src/modules/workout-exercises` → empty.
- [ ] S2: "`GET /exercises/:id` stays authenticate-only" (D5). Evidence: `grep -n "requireRole" src/modules/exercises/routes.ts`
      shows the gate on `GET /` (`'TRAINER', 'ADMIN'`), `POST /`, `PATCH /:id`, `DELETE /:id` (`'TRAINER'` only) and nowhere on `/:id` or `/:id/progress`; B12's `200` for a CLIENT.
- [ ] S3: "`/muscle-groups` is a second plugin in the exercises module, not a new module". Evidence:
      `ls src/modules` shows no `muscle-groups`; `grep -n "muscleGroupRoutes" src/app.ts src/modules/exercises/routes.ts` shows the export and the `{ prefix: '/muscle-groups' }` registration; `listMuscleGroups` lives in `src/modules/exercises/service.ts`.
- [ ] S4: "response in upstream order, not re-sorted or re-filtered". Evidence: code read of `listExercises` in `src/modules/exercises/service.ts` — `res.exercises.map(toExercise)` with no `sort`/`filter`; B6's order.
- [ ] S5: "duplicates in `muscleGroupIds` are de-duplicated, first occurrence kept". Evidence: B13 and the schema test.
- [ ] S6: "empty `muscleGroupId`/`q` treated as absent". Evidence: B7's second request.
- [ ] S7: "composed endpoints change shape without code change". Evidence: `git diff main --stat -- src/modules/workouts src/modules/workout-sessions` → empty.
- [ ] S8: "no new `HttpError` subclass, no new `mapGrpcError` branch". Evidence: `git diff main --stat -- src/lib/errors.ts src/grpc/call.ts` → empty (PR1's `call.ts` change is already on main).
- [ ] S9: the retired `MuscleGroup` string union and `muscleGroupSchema` are gone. Evidence: `grep -rn "CHEST\|muscleGroupSchema" src` → no hits.

**Must not change**
- [ ] N1: `GET /api/exercises/:id/progress`. Evidence: `git diff main -- src/modules/exercises/routes.ts` shows the `/:id/progress` handler unchanged, and
      `curl -s "localhost:3000/api/exercises/$S1/progress?clientId=$C1_ID" -H "authorization: Bearer $T1"` → `200` and a JSON array (empty is fine).
- [ ] N2: every other route family untouched. Evidence: `git diff main --stat -- src/modules` lists only files under `src/modules/exercises/`.
- [ ] N3: `POST /api/exercises` still returns `201` and `DELETE` `204` (status codes as today). Evidence: B13, B20.
- [ ] N4: `videoUrl` optional-or-blank behavior (R42). Evidence: `POST` as `$T1` with `{"name":"Sem vídeo","muscleGroupIds":[1]}` → `201` with `"videoUrl":""`; with `"videoUrl":""` → `201`; with `"videoUrl":"nope"` → `400 VALIDATION_ERROR`. Delete the created rows afterwards.
- [ ] N5: `GET /api/workouts?recent=true` as `$T1` → `200` (no embedded `Exercise`, unaffected).

**Contract doc**
- [ ] C1: `docs/api-contract.md` Exercises section states: `GET /muscle-groups` (any role) → `MuscleGroup[]`; `GET /exercises?muscleGroupId=&q=` (TRAINER/ADMIN) → `Exercise[]` in upstream order; `GET /exercises/:id` (auth only, upstream decides); `POST` (TRAINER, 201), `PATCH` (TRAINER), `DELETE` (TRAINER, 204); the `Exercise = {id, name, description, videoUrl, muscleGroups: MuscleGroup[], isStarter}` and `MuscleGroup = {id, name}` shapes; the body `{name, description?, videoUrl?, muscleGroupIds}`; the errors 400/403/404/409 with the three verbatim messages (`belongs to the shared starter set and cannot be changed` / `cannot be deleted`, `is used by a workout and cannot be deleted`); "Shared across all trainers" is gone. The top `PRECONDITION_FAILED` paragraph names `DELETE /exercises/:id`.
- [ ] C2: the `GET /workouts/:id/full`, `POST /training-plans/:planId/workouts`, `PUT /workouts/:workoutId/exercises` and `GET /workouts/:workoutId/session` lines each say `FullWorkoutExercise.exercise` is the new `Exercise` shape; `/full` notes the ADMIN 403.
- [ ] C3: CLAUDE.md module layout mentions `/muscle-groups` under `exercises`.

### 1.3 PR3 — Document the Increment 2 workout-side 403s

Needs: **vertice-api Increment 2 on main** (R17–R19 guards), PR2 merged, §0 data including `P2`.

**Automated**
- [ ] `npm test`, `npm run typecheck`, `npm run lint` pass (unchanged code; sanity).

**Behavior** (these prove the documented rows are true; the BFF code is unchanged)
- [ ] B1: `curl -s -X POST localhost:3000/api/workouts/$W1/exercises -H "authorization: Bearer $T1" -H 'content-type: application/json' -d "{\"exerciseId\":$X2,\"order\":5}" -w '\n%{http_code}'`
      → `403 {"error":{"code":"FORBIDDEN","message":"You do not have access to exercise <X2>"}}`; `GET /workouts/$W1/full` still has two exercises. Covers: R17/E18.
- [ ] B2: `curl -s -X PUT localhost:3000/api/workouts/$W1/exercises -H "authorization: Bearer $T1" ... -d "{\"exercises\":[{\"exerciseId\":$X2}]}"` → `403`, same message; the tree is unchanged. Covers: R17.
- [ ] B3: `curl -s -X POST localhost:3000/api/training-plans/$P1/workouts -H "authorization: Bearer $T1" ... -d "{\"name\":\"Treino B\",\"dayOfWeek\":\"TUESDAY\",\"exercises\":[{\"exerciseId\":$X2}]}"` → `403`, same message; `GET /training-plans/$P1/workouts` has no `Treino B`. Covers: R17.
- [ ] B4: `curl -s -X POST localhost:3000/api/workouts/$W1/exercises -H "authorization: Bearer $T2" ... -d "{\"exerciseId\":$S1,\"order\":5}"` → `403 {"error":{"code":"FORBIDDEN","message":"You do not have access to this training plan"}}` (the BFF's `assertOwnsWorkout` refuses first; same status/code as the documented upstream refusal). Covers: R18/E19.
- [ ] B5: `curl -s -X POST localhost:3000/api/workouts/$W1/exercises -H "authorization: Bearer $A1" ... -d "{\"exerciseId\":$S1,\"order\":5}"` → `403 {"error":{"code":"FORBIDDEN","message":"You do not have access to workout <W1>"}}` (ADMIN bypasses the BFF check and is refused upstream — the accepted D10 consequence). Covers: R18, D10.
- [ ] B6: `curl -s -X POST localhost:3000/api/workouts/$W1/clone -H "authorization: Bearer $T1" ... -d "{\"targetTrainingPlanId\":$P2,\"name\":\"Clone\",\"dayOfWeek\":\"FRIDAY\"}"` → `403 FORBIDDEN` (BFF `assertOwnsPlan` on the target); as `$A1` → `403 {"error":{"code":"FORBIDDEN","message":"You do not have access to workout <W1>"}}` from upstream. Covers: R19/E20.

**Scope decisions honored**
- [ ] S1: docs-only. Evidence: `git diff main --stat -- src protos` → empty.
- [ ] S2: still no `assertOwnsExercise`. Evidence: `grep -rn "OwnsExercise" src` → no hits.

**Contract doc**
- [ ] C1: `docs/api-contract.md` has a `403 FORBIDDEN` line under `POST /workouts/:workoutId/exercises`, `PUT /workouts/:workoutId/exercises`, `POST /training-plans/:planId/workouts` and `POST /workouts/:id/clone` naming the two upstream messages (`You do not have access to exercise <id>`, `You do not have access to workout <id>` / `... training plan <id>`) and stating that exercise visibility is enforced upstream only and that ADMIN is refused on these.

## 2. Whole-feature checks (after the last PR)

- [ ] Every PR's §1 section passes on the final `main`, against vertice-api with Increments 0, 1 and 2 on main.
- [ ] End-to-end, as the web will drive it (T1): `GET /muscle-groups` → pick `12`; `GET /exercises?muscleGroupId=12&q=terra` → contains `Levantamento terra com barra` and, if T1 still owns a Lombar exercise, it comes first; `POST /exercises {"name":"Meu exercício","muscleGroupIds":[12,2]}` → `201`; `GET /exercises?muscleGroupId=12` → `Meu exercício` is element 0; `POST /training-plans/$P1/workouts` with that id and `$S1` → `201 FullWorkout` whose `exercises[].exercise.muscleGroups` are populated; `DELETE /exercises/<Meu exercício>` → `409 PRECONDITION_FAILED`; `PUT /workouts/<new>/exercises {"exercises":[]}` → `200`; `DELETE /exercises/<Meu exercício>` → `204`.
- [ ] End-to-end refusals: `$C1` `GET /exercises` → `403`; `$T2` `GET /exercises/$X1` → `403`; `$T1` `PATCH /exercises/$S1` → `403` with the starter-set message; `$T1` `POST /workouts/$W1/exercises {"exerciseId":$X2}` → `403`.

Traceability — one row per PRD rule and edge case:

| Rule | Spec § | Check | Result |
|---|---|---|---|
| R1 | §2.2 | 1.2 B3 | |
| R2 | not this repo (vertice-api) | — | — |
| R3 | not this repo (vertice-api) | — | — |
| R4 | not this repo (vertice-api) | — | — |
| R5 | not this repo (vertice-api) | — | — |
| R6 | not this repo (vertice-api) | — | — |
| R7 | not this repo (vertice-api) | — | — |
| R8 | §2.1 | 1.2 B1 | |
| R9 | not this repo (vertice-api) | — | — |
| R10 | not this repo (vertice-api) | — | — |
| R11 | §2 (shape) | 1.2 B3, B6 | |
| R12 | not this repo (vertice-api) | — | — |
| R13 | §2.2 | 1.2 B3 | |
| R14 | §2.2 | 1.2 B3, B8 | |
| R15 | §2.2 | 1.2 B3, B5, B8 | |
| R16 | §2.3, §3 | 1.2 B10 | |
| R17 | §2.7 (upstream, Increment 2) | 1.3 B1–B3 | |
| R18 | §2.7 | 1.3 B4, B5 | |
| R19 | §2.7 | 1.3 B6 | |
| R20 | §2.3, §2.8 | 1.2 B12, B21 | |
| R21 | §2.2, §3 | 1.2 B4; routes.test | |
| R22 | §2.3 | 1.2 B12 | |
| R23 | §2.4 | 1.2 B15; routes.test | |
| R24 | §2.5, §2.6 | 1.2 B15; routes.test | |
| R25 | §2.2, §2.3 | 1.2 B5, B11 | |
| R26 | §3 | 1.2 B16 | |
| R27 | §3 | 1.2 B19 | |
| R28 | not this repo (vertice-web-react; `isStarter` provided) | 1.2 B3 | |
| R29 | §2.5 | 1.2 B18 | |
| R30 | §2.5 | 1.2 B18 | |
| R31 | §2.5, §5 | 1.2 B18; schemas.test | |
| R32 | §3 | 1.2 B17 | |
| R33 | not this repo (vertice-api) | — | — |
| R34 | §3 | 1.2 B20 | |
| R35 | §2.6 | 1.2 B20 | |
| R36 | §3 | 1.2 B19 | |
| R37 | not exposed (PRD §6) | — | — |
| R38 | not exposed (PRD §6) | — | — |
| R39 | §2.4 | 1.2 B13 | |
| R40 | §2.4, §5 | 1.2 B14; schemas.test | |
| R41 | §2.4 | 1.2 B13 | |
| R42 | §2.4 | 1.2 B13, N4 | |
| R43 | §2.4 | 1.2 B13 | |
| R44 | passthrough | 1.2 B14 | |
| R45 | §2.2 | 1.2 B6 | |
| R46 | §2.2 | 1.2 B7 | |
| R47 | upstream; §2.2 forwards | 1.2 B6 | |
| R48 | upstream; §2.2 not re-sorted | 1.2 B3, B6 | |
| R49 | upstream; §2.2 not re-sorted | 1.2 B6 | |
| R50 | upstream; §2.2 not re-sorted | 1.2 B6 | |
| R51–R59 | not this repo (vertice-api migration) | — | — |
| E1 | §3 | 1.2 B16 | |
| E2 | §3 | 1.2 B19 | |
| E3 | passthrough | 1.2 B14 | |
| E4 | passthrough | 1.2 B8 | |
| E5 | §3 | 1.2 B20 | |
| E6 | not this repo (vertice-api) | — | — |
| E7 | §2.8 | 1.2 B21 | |
| E8 | §2.2 | 1.2 B6 | |
| E9 | not this repo | — | — |
| E10 | not this repo | — | — |
| E11 | not this repo | — | — |
| E12 | not this repo (vertice-api migration) | — | — |
| E13 | §2.4, §5 | 1.2 B14; schemas.test | |
| E14 | §2.2 | 1.2 B8 | |
| E15 | §2.2 | 1.2 B7 | |
| E16 | §2.2, §2.3 | 1.2 B4, B12 | |
| E17 | §2.4–2.6 | 1.2 B15 | |
| E18 | §2.3, §2.7 | 1.2 B10; 1.3 B1 | |
| E19 | §2.7 | 1.3 B4, B5 | |
| E20 | §2.7 | 1.3 B6 | |
| E21 | §3 | 1.2 B17, B19 | |
| E22 | §2.5 | 1.2 B18 | |
| E23 | not this repo (vertice-api migration) | — | — |

## 3. Report format

```
Verification of vertice-bff exercise-starter-catalog — PR<n> (<branch/commit>)
PASS <count> · FAIL <count> · NOT CHECKED <count>

FAIL 1.2 B20: expected 409 PRECONDITION_FAILED, got 400 VALIDATION_ERROR. Evidence: <body>.
NOT CHECKED 1.1 B3: vertice-api Increment 1 not on main; identity forwarding proven by call.test.ts only.
...
Verdict: <matches spec | does not match spec — <one line>>
```
