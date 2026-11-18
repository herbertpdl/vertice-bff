# Spec (BFF): Admin panel

Status: Draft
Owner: hebertpdl@gmail.com
Related: [vertice-api PRD](https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/admin-panel/prd.md)
(Approved 2026-11-18; R1–R72, E1–E42, not restated here),
[vertice-api spec](https://github.com/herbertpdl/vertice-api/blob/main/docs/specs/admin-panel/spec.md)
(D1–D32, the gRPC contract this bridges; it wins over this document on any RPC detail),
[vertice-api assessment](https://github.com/herbertpdl/vertice-api/blob/main/docs/assessments/admin-panel/assessment.md),
this repo's [assessment](../../assessments/admin-panel/assessment.md) (F1–F16, resolved in §0),
[vertice-web-react assessment](https://github.com/herbertpdl/vertice-web-react/blob/main/docs/assessments/admin-panel/assessment.md)
(the consumer), `docs/specs/mobile-persistent-session/spec.md` (the renewal precedent),
`docs/specs/web-trainer-only-access/spec.md` (touched: R3). Tickets: VRT-17 (this spec), VRT-23,
VRT-24, VRT-28, VRT-31.

The BFF owns no admin data and no admin rule that vertice-api doesn't also enforce. What it owns
here is the admin's identity: the password step, the challenge, the second-factor step, the admin
token's claims and lifetime, and the role separation of the REST surface. Everything else is
"which route calls which `vertice.admin.v1` RPC, with which body, and which code the web sees".

## 0. Scope decisions

Each row resolves a finding of this repo's assessment (§10 inputs) and traces to the PRD and the
API spec's decisions.

| # | Decision | Why |
|---|---|---|
| B1 | **A separate admin login that returns only a challenge (F1).** `POST /api/admin/auth/login` checks the password with `VerifyCredentials { required_role: ADMIN }` (service token) and answers a **challenge token**, never a session. The session is signed only by `POST /api/admin/auth/verify`, after vertice-api's `VerifySecondFactor` accepts the code. First sign-in goes through `POST /api/admin/auth/enroll` (provisioning URI), then verify. The code check, replay protection and the 5-failure lock are the API's (D5, D8); the BFF relays the code and signs on success only. | R1, R8, R9, E1, E8, E9; API D5. A password alone never yields a token any route accepts. |
| B2 | **The challenge token can't be used as anything else (F1).** HS256 with `JWT_SECRET`, `iss: "vertice-bff"`, **`aud: "vertice-bff:admin-challenge"`** (not `vertice-api`), `sub` = the admin's id, `token_use: "admin_challenge"`, `amr: ["pwd"]`, no `role`, `exp` = 5 minutes. `verifyToken` (audience `vertice-api`) and vertice-api's `HmacJwtDecoder` (audience must contain `vertice-api`) both refuse it, so it authenticates no REST route and no RPC. It travels only in the body of enroll and verify, and is never forwarded upstream (those routes call `AdminAuthService` with the service token). It is reusable until it expires (stateless, any number of BFF tasks); a replayed challenge still needs a fresh code, which the API's `last_used_step` refuses to accept twice. | F1; assessment A3 (5 minutes). A distinct audience is the one claim both verifiers already check. |
| B3 | **The admin token (F1, F2): `role: "ADMIN"`, `amr: ["pwd", "otp"]`, `auth_time`, 30 minutes.** Signed at verify with `iat = auth_time = now` and `exp = iat + 1800`. Claims exactly as API D6 checks them: `amr` contains `"otp"`; `auth_time` (NumericDate) not after `iat`; `now ≤ auth_time + 12h`; `exp − iat ≤ 30 min`. No `session` claim. `verifyToken` applies the same four checks to every token with `role: ADMIN` and refuses any other (a password-only 8h ADMIN token from `/auth/login` included), so the BFF is a first layer that agrees with the API, not one that relies on it. `AuthUser` gains `authTime` for ADMIN. Non-ADMIN tokens never carry the claims and are unaffected. | R8, R11, R12, E11, E12; API D6. Mirroring D6 here means a BFF signing bug fails in BFF tests, not only upstream. |
| B4 | **Sliding renewal through `POST /api/admin/auth/renew` (F2).** ADMIN only, no body. First `GetUser` on self with the current admin token (vertice-api re-checks suspension, password change, role and the 12h cap, D7), then a new token: `iat = now − 1` (the mobile-renewal backdate, so a password change in the same second still voids it), same `auth_time`, **`exp = min(iat + 1800, auth_time + 43200)`** (computed from the backdated `iat`, so `exp − iat` never exceeds 1800). The old token stays valid until its own `exp`. A renewal at 11h50m expires at exactly `auth_time + 12h`; after that, `authenticate` refuses the token itself (expired) and only a new sign-in helps. Upstream `UNAUTHENTICATED` is the existing 401 `UNAUTHENTICATED` (logout path, R40). No "remember me", no session store. | R11, R12, E11, E12, E42; API D7; mobile-persistent-session precedent. |
| B5 | **Reviewed widening of `SERVICE_TOKEN_RPCS` (F1).** It becomes `VerifyCredentials`, `CreateUser`, `RedeemPasswordSetupToken`, `GetSecondFactorState`, `StartSecondFactorEnrollment`, `VerifySecondFactor`: the three `AdminAuthService` RPCs vertice-api allows `service:bff` (API §2). Both pins change on purpose in VRT-23: `SERVICE_TOKEN_RPCS` in `src/grpc/call.ts` and `API_SERVICE_SUBJECT_RPCS['service:bff']` in `src/test/fakeUpstream.ts`. Containment: only `src/modules/admin-auth/service.ts` may pass `{ asService: true }` to the three new RPCs, after a valid challenge; a source-scan test (like the `ERROR_CODES` one) fails on any other call site. vertice-api refuses a `user_id` that isn't a non-deleted ADMIN (`PERMISSION_DENIED`). | CLAUDE.md "Never widen either list for convenience"; this is the documented exception, not convenience. |
| B6 | **`OPS_TOKEN_RPCS` gains the `AdminOpsService` RPCs, used only by ops scripts (F10).** VRT-23: `CreateAdmin`, `IssueAdminSetupToken`, `ResetAdminSecondFactor`; VRT-28: `SuspendAdmin`, `ReactivateAdmin`. New scripts under `scripts/` → `src/ops/`, same pattern as `ops:issue-setup-tokens` (`service:ops` token minted in the script process only). The server never calls `AdminOpsService`: `adminOpsClient` is imported only under `src/ops/` (pinned by a test) and no route exists for it. | R10, R14, E10; API D9. Without scripts the first admin would be manual SQL. |
| B7 | **Role separation is structural and pinned (F4).** Two plugins: `admin-auth` at `/api/admin/auth` (login, enroll, verify public; renew ADMIN) and `admin` at `/api/admin`, whose plugin-level hooks are `app.authenticate` then `app.requireRole('ADMIN')`, so no admin route can be registered without them. Kept for ADMIN outside `/api/admin` (R16a): `GET /auth/me`, `POST /auth/password`, `POST /auth/me/consent`, `GET /muscle-groups` (the admin screens need the list). Dropped for ADMIN: `PATCH /auth/me`, `DELETE /auth/me`, `GET /auth/me/export` in VRT-23 (R16b, E41; the API already refuses them, D2); `GET /exercises` and `GET /exercises/:id` in VRT-31 (API §7 step 7; the API refuses them since VRT-20, D20). | R5–R7, R16a, R16b, E5–E7, E41. Owner's decision (A1 in the assessment). |
| B8 | **The admin login refuses non-admins exactly like a wrong password (F5).** `required_role: ADMIN` makes vertice-api answer a trainer's or client's correct password with the same `UNAUTHENTICATED` as a wrong one (D10), so the BFF's answer is today's 401 `UNAUTHORIZED` "Invalid email or password" in every case, from the same code path. `VerifyCredentials` runs on every attempt (the oversize-password shortcut answers the same 401, as today). The admin login has its own bucket, `admin-login` (IP + e-mail, failures only), so a non-admin's correct password counts as a failure. It never uses the `VERIFY_PASSWORDS=false` email-only path, in any environment. | R4, E3, E4, E19. |
| B9 | **R3 on www: 403 `ADMIN_LOGIN_ELSEWHERE` (VRT-28).** `POST /auth/login` answers an ADMIN's correct password with 403 `ADMIN_LOGIN_ELSEWHERE` and no token, whatever `X-Vertice-Client` says. Its message is the web's `APP_ONLY_MESSAGE` verbatim, "O acesso de alunos é feito somente pelo aplicativo Vertice.", the one Portuguese BFF message besides B10's, as a safety net for a client that shows `message`. A wrong password is still the shared 401, so the role is revealed only to the holder of the password, as today. The web maps the code to its `TRAINERS_ONLY` answer; that web build deploys first (§6). Until VRT-28, `/auth/login` still signs ADMIN an 8h token, which `verifyToken` (B3) and vertice-api (D6) both refuse, and which the web drops by role as today. | R3, E2; API D11; owner's decision. |
| B10 | **Suspension at login: 403 `ACCOUNT_SUSPENDED` (F6, VRT-28).** On `POST /auth/login` and `POST /api/admin/auth/login` only, `VerifyCredentials`' `FAILED_PRECONDITION` ("Account suspended", sent only after password and role matched, D10) becomes 403 `ACCOUNT_SUSPENDED` with the R41 text "Sua conta está suspensa. Entre em contato com o suporte.". Every other route keeps the global mapping. Renewal (mobile and admin) calls `GetUser` and so sees `UNAUTHENTICATED`, the 401 logout path (R40, E17). A suspended admin at www with the right password also gets `ACCOUNT_SUSPENDED` (the API checks suspension before the BFF sees a role); that reveals nothing the password didn't. | R40–R42, E17–E19; API D10, D13, §5. |
| B11 | **Per-route codes for catalog and second factor (F6).** Admin catalog routes: `ALREADY_EXISTS` → 409 `NAME_TAKEN`; `DeleteStarterExercise`'s `FAILED_PRECONDITION` → 409 `EXERCISE_IN_USE`. Verify: `UNAUTHENTICATED` "Invalid second-factor code" → **400 `INVALID_SECOND_FACTOR_CODE`** (not 401: a 401 means "session over" to every client). Enroll/verify: an invalid or expired challenge, and `AdminAuthService`'s `PERMISSION_DENIED`, → 401 `CHALLENGE_INVALID` (start again). `RESOURCE_EXHAUSTED` on verify (the API's lock) and on the e-mail routes (send limits) → **429 `RATE_LIMITED`** with `Retry-After` = the N of the API's fixed text "retry after N seconds" (clamped to 1–86400, 60 when absent); globally it stays 413 `TOO_LARGE`. The e-mail routes' and suspend/reactivate's `FAILED_PRECONDITION` stay the generic 409 `PRECONDITION_FAILED`, with a per-route meaning (§3). Mechanism: the existing catch-by-class pattern (`deleteAccount`'s `ACTIVE_CLIENTS`); `mapGrpcError` additionally parses the retry seconds out of `RESOURCE_EXHAUSTED` text onto the error (never into the body), and `TooManyRequestsError` takes an optional `retryAfterSeconds` that the error handler writes as `Retry-After`. | R41, R55, R60, R64, R65, E28, E32–E34; API §5; CLAUDE.md "Clients key on the `code`". Fewer new codes: only where the web must say something different. |
| B12 | **One paging shape for every admin list (F7).** Query `limit` ∈ {10, 25, 50} (absent = 25; anything else 400, no upstream call), `cursor` (opaque, ≤ 512 characters; `nextCursor` of the previous page); response `nextCursor: string \| null`. The names match `GET /exercises` (`limit`/`cursor`/`nextCursor`); the values map to `page_size`/`page_token`/`next_page_token` (D26). No page numbers. A malformed cursor is vertice-api's `INVALID_ARGUMENT`, relayed as 400. | R25, R28, R71; API D26. |
| B13 | **Profiles: a discriminated union on `role`, CPF masked by the API and checked here (F8).** `GET /api/admin/users/:id` relays `GetUserProfile` field by field into `AdminTrainerProfile` or `AdminClientProfile` (§2.2). No logs, weights, feedback, plan contents or full CPF exist upstream to leak (D18). `cpf` is `cpf_masked` only when it matches `***.***.***-NN`; anything else becomes `null` with a WARN line (fail closed, never a full CPF). `GetUserProfile` writes a `VIEW_USER_PROFILE` history entry per call (D17), so this GET has a side effect: the web must not refetch it on focus or poll it. | R33–R37, E38; API D17, D18; CLAUDE.md "Personal data". |
| B14 | **The enrolment secret leaves once (F9).** `POST /api/admin/auth/enroll` returns `provisioningUri` (the `otpauth://` URI, which contains the secret) only with a valid challenge; vertice-api refuses an already-enrolled admin. The response is `Cache-Control: no-store` (the `/api/*` default), never logged (Fastify logs no bodies; `logUpstreamError` sees only error text), never put in an error. Each call starts enrolment again with a new secret (API §3.1), so a lost QR is "call enroll again". Enrolment completes only when verify accepts a code from that secret (`enrolledNow: true` upstream). The web renders the QR in-process and never sends the URI to a third-party service. | R9, E9; API D8. |
| B15 | **Logging (F14).** Admin routes never log a body, password, code, challenge, token, provisioning URI, reason or search text. One structured line per admin sign-in attempt, for the VRT-19 alarm (§4). Admin write routes add an `audit: "admin.<action>"` line (actor id, target id), as `account.*` lines do. | R39, R68; API D31; assessment F14. |
| B16 | **Dashboard is one upstream call (F12).** `GET /api/admin/dashboard` relays `GetDashboard` reshaped; no BFF fan-out or cache. The most-used list is its own route and ships in slice 3 with curation (API D28), so the dashboard's most-used table arrives with VRT-31. | R17–R21, R27, E40; API D27, D28. |
| B17 | **Ending a relationship takes both ids: `DELETE /api/admin/relationships/:trainerId/:clientId`.** `EndTrainerClientRelationship` needs `trainer_id` and `client_id`, and an ADMIN has no side-effect-free read to look the trainer up (`GetClientTrainer` is CLIENT-only after D1; `GetUserProfile` writes history). The web has both ids from the profile it is showing. This replaces the indicative `/:clientId` path of the assessment and VRT-28. | R50, E25; API D1. |
| B18 | **Starter exercise update is `PUT` (full replace).** `UpdateStarterExercise` takes a whole `ExerciseRequest` and there is no admin read-by-id to fill omitted fields, so a `PATCH` would have to invent values. The body is the same shape as create. Muscle-group rename is `PATCH` with `{name}`, the only field. | R53, R61; API §3.3. |
| B19 | **Deferred, with reason:** a shared rate-limit store (the `AttemptLimiter` stays per process; the API's per-admin lock is the authoritative code limit, D8); recovery codes (PRD §6); host routing, cookies and the renewal trigger (the web spec's, see §5); the CloudWatch alarm itself (VRT-19, from the line in §4). | Assessment F1, F13; API D32. |

## 1. Proto sync

Each implementation ticket starts by syncing the protos at the vertice-api merge commit its API
ticket shipped (`protos/.api-ref` ← that commit's full SHA, then `npm run sync:protos`; locally
`GITHUB_TOKEN=$(gh auth token)` or `-- --local`). The pin today (`24d04f1`) predates the whole
feature, so the first sync also brings unrelated upstream drift (for example
`SendFirstAccessEmail` and `FirstAccessStatus` in `user.proto`): review the diff, don't assume it
is admin-only.

| Ticket | Pin at least | New files in `PROTO_FILES` (`src/grpc/loadProto.ts`) | New clients (`src/grpc/clients.ts`) |
|---|---|---|---|
| VRT-23 | VRT-22 merged (all of API slice 1, §6) | `vertice/admin/v1/admin_auth.proto`, `admin_ops.proto` | `adminAuthClient`, `adminOpsClient` (ops only, B6) |
| VRT-24 | same | `vertice/admin/v1/admin.proto` | `adminClient` |
| VRT-28 | VRT-27 merged | none (`admin.proto`, `admin_ops.proto` and `user.proto` gain RPCs/fields) | none |
| VRT-31 | VRT-30 merged | `vertice/admin/v1/admin_catalog.proto` (imports `admin.proto` and `exercise.proto`; resolves through `includeDirs`) | `adminCatalogClient` |

Fields this spec relies on: `VerifyCredentialsRequest.required_role = 3` (VRT-21),
`UserResponse.suspended = 14` (VRT-27, set on `ListClientsForTrainer` only), and the messages of
API §3.1–§3.5. Enum values arrive prefixed (`DIRECTORY_ROLE_TRAINER`, `ADMIN_ACTION_SUSPEND_USER`,
`SECOND_FACTOR_STATE_ENROLLED`); the BFF strips the prefix on the way out and adds it on the way
in, so the REST enums read `TRAINER`, `SUSPEND_USER`, `ENROLLED`.

## 2. Endpoints

All paths under `/api`. Zod schemas live in the module's `schemas.ts` and are parsed in the
handler (CLAUDE.md); text bounds use `utf16String`. "Public" means no bearer token. Every route
gets a `routeDoc` with `roles` matching its hook and its response schema in `openapi/responses.ts`.
Instants are ISO-8601 with `Z`; `lastActiveOn` and `weekStart` are business dates `yyyy-MM-dd`.

### 2.1 Slice 1, VRT-23: admin sign-in, sessions, role separation

**`POST /admin/auth/login`** (public, `admin-login` bucket: IP + e-mail, failures only)
- Body `adminLoginSchema` = the existing `loginSchema` (`email`, `password`).
- Calls `VerifyCredentials { email, password, required_role: ADMIN }` (service token), then
  `GetSecondFactorState { user_id }` (service token).
- 200 `AdminChallenge`: `challenge` (string), `challengeExpiresAt` (instant, 5 minutes out),
  `secondFactor`: `ENROLLED` | `NOT_ENROLLED` (tells the web whether to show enrolment or the code
  step).
- No user fields: name and e-mail come with the session at verify.

**`POST /admin/auth/enroll`** (public, `admin-enroll` bucket: IP + challenge user, every call counts, since each one mints a secret)
- Body `adminEnrollSchema`: `challenge` (string, 1–2048).
- Calls `StartSecondFactorEnrollment { user_id }` (service token).
- 200 `AdminEnrollment`: `provisioningUri` (string). Rules in B14.

**`POST /admin/auth/verify`** (public, `admin-verify` bucket: IP + challenge user, failures only;
the bucket keys decode the body's challenge, and an unverifiable one keys on the IP alone, as on
enroll)
- Body `adminVerifySchema`: `challenge` (string, 1–2048), `code` (exactly six ASCII digits,
  `^[0-9]{6}$`; anything else 400 with no upstream call).
- Calls `VerifySecondFactor { user_id, code }` (service token). On success signs the admin token
  (B3), then `GetUser` on self **with that new token** (sent as `authorization` metadata): this
  proves vertice-api accepts the token (D6) and gives the name and e-mail. A mismatch of id or role,
  or `UNAUTHENTICATED` there (suspended or reset in the meantime), is 401 `CHALLENGE_INVALID`.
- 200 `AdminSession`: `token`, `expiresAt` (its `exp`), `sessionEndsAt` (`auth_time + 12h`, the
  hard cap), `user` (`SessionUser`: id, name, email, role `ADMIN`).

**`POST /admin/auth/renew`** (ADMIN, `admin-renew` bucket: IP + user, refusals only, as `session-renew`)
- No body. B4. 200 `AdminSession` with the same `sessionEndsAt`.

**Changes to existing routes and code:**
- `PATCH /auth/me`, `DELETE /auth/me`, `GET /auth/me/export`: `requireRole('TRAINER', 'CLIENT')`
  (ADMIN 403 by role, E41).
- `src/lib/jwt.ts`: `ADMIN_SESSION_TTL_SECONDS = 1800`, `ADMIN_SESSION_MAX_SECONDS = 43200`,
  `ADMIN_CHALLENGE_TTL_SECONDS = 300`, `ADMIN_CHALLENGE_AUDIENCE = 'vertice-bff:admin-challenge'`
  (constants, not env: D6 fixes the bound); `signAdminToken({ id, authTime, issuedAt })`,
  `signAdminChallenge(id)`, `verifyAdminChallenge(token) → { id }`; `verifyToken` gains B3's ADMIN
  checks. `signAdminToken` is the only signer that adds `amr`/`auth_time`. Until VRT-28,
  `session()` still signs an ADMIN's `/auth/login` with `signToken`'s plain shape, only so the web
  can read the role and drop it (today's R3 path); `verifyToken` and vertice-api both refuse that
  token (B3, B9). VRT-28 removes the branch, and from then on `signToken` throws on `role: ADMIN`.
- `src/modules/auth/service.ts`: the "ADMIN has no defined product" comments go.
- Ops: `npm run ops:create-admin -- --name <name> --email <email>` (`CreateAdmin`, prints the
  user id and a `https://www.vertice.fit/definir-senha?token=…` link on stdout, nothing in logs),
  `npm run ops:issue-admin-setup-token -- --user-id <id>` (`IssueAdminSetupToken`, same output),
  `npm run ops:reset-admin-2fa -- --user-id <id>` (`ResetAdminSecondFactor`). Each refuses unknown
  arguments, as `ops:issue-setup-tokens` does, and writes tokens to stdout only. The setup link is the existing www
  "Definir senha" page (API D9); `POST /auth/password/setup` already answers `{role, email}`, so the
  web can send an ADMIN to admin.vertice.fit from its success screen (web spec).

### 2.2 Slice 1, VRT-24: admin read routes

All under the `admin` plugin (ADMIN, B7). A user that is missing, deleted or an admin is
vertice-api's `NOT_FOUND`, the global 404 `NOT_FOUND` (D4, no oracle).

**`GET /admin/dashboard`** → `GetDashboard`. 200 `AdminDashboard`:
- `totals`: `trainers`, `clients`;
- `active`: `trainers7d`, `clients7d`, `trainers30d`, `clients30d`;
- `completedWorkouts`: `last7d`, `last30d`;
- `weeklySignups`: 12 × `{ weekStart, trainers, clients }`, oldest first.

**`GET /admin/users`** → `ListDirectoryUsers`.
- Query `adminDirectoryQuerySchema`: `role` (`TRAINER` | `CLIENT`, absent = both; `ADMIN` is not a
  value, R16), `status` (`ACTIVE` | `SUSPENDED`, absent = both), `q` (trimmed, empty = absent,
  1–100 UTF-16), `limit`, `cursor` (B12).
- 200 `{ users: AdminDirectoryUser[], nextCursor }`. `AdminDirectoryUser`: `id`, `name`, `email`,
  `role`, `suspended`, `createdAt`, `lastActiveOn` (null if never), `currentTrainer` (`{id, name}`
  or null; clients only, R31), `currentClientCount` (number for trainers, null for clients, R32).
  Order is the API's (name, then id).

**`GET /admin/users/:id`** → `GetUserProfile { user_id }` (B13). 200 `AdminUserProfile`, a union on
`role`:
- common: `id`, `name`, `email`, `role`, `cpf` (masked or null), `suspended`, `suspendedAt`
  (null when active), `createdAt`, `lastActiveOn`;
- `TRAINER`: `cref` (null when empty), `whatsapp` and `instagram` (null unless shared, D18),
  `currentClients[]` and `formerClients[]` (`AdminRelationship`: `user {id, name, role}`,
  `startedAt`, `endedAt` (null when current), `suspended`), `planCount`, `workoutCount`,
  `privateExerciseCount`;
- `CLIENT`: `currentTrainer` (`AdminRelationship` or null), `pastTrainers[]`, `planCount`,
  `completedWorkoutCount`, `firstAccess` (`pending`, `lastSentAt` (null), `lastSendFailed`).

**`GET /admin/actions`** → `ListActions`.
- Query: `adminId`, `targetUserId` (positive ints, absent = any), `action` (the `AdminAction`
  enum without prefix, absent = any), `limit`, `cursor`.
- 200 `{ entries: AdminActionEntry[], nextCursor }`, newest first. `AdminActionEntry`: `id`,
  `admin` (`{id, name, role}`), `action`, `targetUser` and `relatedUser` (`{id, name, role}` or
  null; a deleted user reads "Usuário removido", R72), `targetExerciseId`, `targetMuscleGroupId`,
  `subjectLabel`, `reason` (null when empty, D16), `createdAt`.

**`GET /admin/actions/admins`** → `ListActionAdmins`. 200 `{ admins: {id, name, role}[] }` (the
history's admin filter, R71).

Also kept for ADMIN: `GET /muscle-groups` (filters and the exercise form).

### 2.3 Slice 2, VRT-28: suspension, account e-mails, login refusals

**`POST /admin/users/:id/suspend`** and **`POST /admin/users/:id/reactivate`**
- Body `adminReasonSchema`: `reason` (trimmed, 1–500 UTF-16 units; missing or blank is 400 with no
  upstream call, E20).
- Calls `SuspendUser` / `ReactivateUser { user_id, reason }`.
- 200 `{ user: AdminDirectoryUser }` (the row as it is now, so the web updates list and profile).
- Audit line `admin.user.suspend` / `admin.user.reactivate` (actor, target; never the reason).

**`POST /admin/users/:id/first-access-email`** → `SendFirstAccessEmail { user_id }` with the admin
token. **`POST /admin/users/:id/password-reset-email`** → `SendPasswordResetEmail { user_id }`.
- No body. 204 on an accepted send: no link, no token, no status beyond success (R49).
- Audit lines `admin.user.first_access_email` / `admin.user.password_reset_email`.

**`DELETE /admin/relationships/:trainerId/:clientId`** → `EndTrainerClientRelationship
{ trainer_id, client_id }` with the admin token (B17). 204. Audit line `admin.relationship.end`.

**Changes to existing routes:**
- `POST /auth/login`: ADMIN's correct password → 403 `ADMIN_LOGIN_ELSEWHERE` (B9); suspension → 403
  `ACCOUNT_SUSPENDED` (B10). The ADMIN branch of `session()` and `MOBILE_ROLES`'s ADMIN note go.
  `POST /auth/register` is untouched (TRAINER only).
- `POST /admin/auth/login`: suspension → 403 `ACCOUNT_SUSPENDED` (B10).
- `GET /clients`: `ClientSummary` gains `suspended: boolean` from `UserResponse.suspended`
  (additive, R46, E22).
- Ops: `npm run ops:suspend-admin -- --user-id <id>`, `npm run ops:reactivate-admin -- --user-id
  <id>` (`SuspendAdmin`, `ReactivateAdmin`; R14). This adds the two scripts to VRT-28's scope.

### 2.4 Slice 3, VRT-31: exercise curation

**`GET /admin/exercises`** → `ListCatalogExercises`.
- Query: `scope` (`STARTER` | `PRIVATE`, absent = both), `muscleGroupId`, `ownerId` (positive ints,
  absent = any), `q` (as in 2.2), `limit`, `cursor`.
- 200 `{ exercises: AdminCatalogExercise[], nextCursor }`. `AdminCatalogExercise` = the existing
  `Exercise` shape (`id`, `name`, `description`, `videoUrl`, `muscleGroups`, `isStarter`) plus
  `owner` (`{id, name}` for a private exercise, null for a starter one, R23, R56).

**`GET /admin/exercises/most-used`** → `ListMostUsedExercises`.
- Query: `muscleGroupId`, `limit`, `cursor`.
- 200 `{ exercises: { exercise: AdminCatalogExercise, workoutCount }[], nextCursor }` (R22–R25).

**`POST /admin/exercises`** → `CreateStarterExercise`. Body = the trainer's `exerciseInputSchema`
(same bounds and YouTube rule as vertice-api). 201 `AdminCatalogExercise`.

**`PUT /admin/exercises/:id`** → `UpdateStarterExercise` (B18). Same body. 200.

**`DELETE /admin/exercises/:id`** → `DeleteStarterExercise`. 204.

**`POST /admin/exercises/:id/promote`** → `PromoteExercise { source_exercise_id, exercise }`. Body
= the edited copy, same schema. 201 `AdminCatalogExercise` (the new starter row).

**`POST /admin/muscle-groups`** → `CreateMuscleGroup`; **`PATCH /admin/muscle-groups/:id`** →
`RenameMuscleGroup`. Body `muscleGroupNameSchema`: `name` (trimmed, 1–50 UTF-16). 201 / 200
`MuscleGroup` (`{id, name}`, the existing shape).

Each write logs `audit: "admin.catalog.<create|update|delete|promote|muscle_group_create|muscle_group_rename>"`
with actor and target ids.

**Changes to existing routes:** `GET /exercises` → `requireRole('TRAINER')`; `GET /exercises/:id`
→ `requireRole('TRAINER', 'CLIENT')` (B7).

## 3. Errors the web will see

Global mapping (`mapGrpcError`) unless a row says otherwise. Zod failures are 400
`VALIDATION_ERROR` with `details`, before any upstream call.

| Route(s) | Situation | Upstream | BFF status / `error.code` |
|---|---|---|---|
| `POST /admin/auth/login` | Wrong password, unknown e-mail, no password, **a trainer's or client's correct password** | `UNAUTHENTICATED` | 401 `UNAUTHORIZED` "Invalid email or password" (identical body, B8) |
| `POST /admin/auth/login`, `POST /auth/login` | Correct password, account suspended (VRT-28) | `FAILED_PRECONDITION` | 403 `ACCOUNT_SUSPENDED` (B10) |
| `POST /auth/login` | An ADMIN's correct password (VRT-28) | none (role in the response) | 403 `ADMIN_LOGIN_ELSEWHERE` (B9) |
| login, enroll, verify, renew | Bucket exhausted | none | 429 `RATE_LIMITED`, `Retry-After` |
| enroll, verify | Challenge missing, malformed, expired, wrong audience | none | 401 `CHALLENGE_INVALID` |
| enroll, verify | The challenge's user is no longer a non-deleted ADMIN | `PERMISSION_DENIED` | 401 `CHALLENGE_INVALID` |
| enroll | Already enrolled | `FAILED_PRECONDITION` | 409 `PRECONDITION_FAILED` (go to the code step) |
| verify | Wrong, reused or out-of-window code | `UNAUTHENTICATED` | 400 `INVALID_SECOND_FACTOR_CODE` |
| verify | No confirmed or pending secret (reset since login) | `FAILED_PRECONDITION` | 409 `PRECONDITION_FAILED` (start again) |
| verify | Locked after 5 failures | `RESOURCE_EXHAUSTED` | 429 `RATE_LIMITED`, `Retry-After` = API's N |
| verify | Token rejected by the post-sign `GetUser` | `UNAUTHENTICATED` | 401 `CHALLENGE_INVALID` |
| renew, every ADMIN route | Admin token expired, past 12h, without `amr`/`auth_time`, or the user suspended, re-roled, password changed | none / `UNAUTHENTICATED` | 401 `UNAUTHORIZED` (BFF verify) / 401 `UNAUTHENTICATED` (upstream): both mean "sign in again" |
| every `/admin/*` (not auth) | TRAINER or CLIENT token | none | 403 `FORBIDDEN` (by role, no upstream call) |
| `PATCH`/`DELETE /auth/me`, export | ADMIN token | none | 403 `FORBIDDEN` (E41) |
| `/admin/users/:id/**`, relationships | Target missing, deleted or an admin | `NOT_FOUND` | 404 `NOT_FOUND` |
| admin lists | `page_size`/cursor refused | `INVALID_ARGUMENT` | 400 `VALIDATION_ERROR` (upstream text relayed) |
| suspend / reactivate | Reason refused upstream | `INVALID_ARGUMENT` | 400 `VALIDATION_ERROR` |
| suspend / reactivate | Already suspended / not suspended | `FAILED_PRECONDITION` | 409 `PRECONDITION_FAILED` (refetch the profile) |
| e-mail routes | Over the per-user limit | `RESOURCE_EXHAUSTED` | 429 `RATE_LIMITED`, `Retry-After` = API's N |
| e-mail routes | E-mails switched off (`vertice.first-access-email.enabled`) | `FAILED_PRECONDITION` | 409 `PRECONDITION_FAILED` ("envio indisponível") |
| e-mail routes | Every try failed | `UNAVAILABLE` | 503 `UPSTREAM_UNAVAILABLE` (retry later) |
| relationships | No active relationship for the pair | `NOT_FOUND` / `PERMISSION_DENIED` | 404 `NOT_FOUND` / 403 `FORBIDDEN` (as the API answers) |
| catalog create / update / promote, muscle groups | Duplicate name ignoring case and accents | `ALREADY_EXISTS` | 409 `NAME_TAKEN` |
| `DELETE /admin/exercises/:id` | Used by a workout | `FAILED_PRECONDITION` | 409 `EXERCISE_IN_USE` |
| update / delete | A private exercise | `PERMISSION_DENIED` | 403 `FORBIDDEN` |
| promote | Source is already a starter exercise | `FAILED_PRECONDITION` | 409 `PRECONDITION_FAILED` |

New `ERROR_CODES`, per ticket: VRT-23 `CHALLENGE_INVALID`, `INVALID_SECOND_FACTOR_CODE`; VRT-28
`ADMIN_LOGIN_ELSEWHERE`, `ACCOUNT_SUSPENDED`; VRT-31 `NAME_TAKEN`, `EXERCISE_IN_USE`.

## 4. Admin sign-in log line (VRT-19 alarm)

One INFO line per request to `POST /admin/auth/login`, `/enroll` and `/verify`, written by a
single `onResponse` hook on those three routes (so a 429 from the bucket, which never reaches the
handler, is logged too). The handler sets the `reason` on the request; the hook derives
`outcome` from the status. pino JSON, in the `/ecs/vertice-bff` log group:

```json
{"level":30,"audit":"admin.signin","step":"password","outcome":"failure","reason":"invalid_credentials","msg":"Admin sign-in"}
```

| Field | Values |
|---|---|
| `audit` | always `"admin.signin"` |
| `step` | `"password"` (login), `"enroll"`, `"code"` (verify) |
| `outcome` | `"success"` (2xx), `"failure"` (4xx), `"error"` (5xx: upstream down, never counted as a failure) |
| `reason` | failures only: `invalid_credentials`, `suspended`, `invalid_request` (400 Zod), `invalid_challenge`, `invalid_code`, `locked` (API lock), `not_enrolled`, `already_enrolled`, `rate_limited` (BFF bucket) |
| `userId` | the admin's id once known (a valid challenge, or a matched password); **absent** on `invalid_credentials`, so a non-admin's correct password is indistinguishable in the log as on the wire |

Never in the line: e-mail, IP beyond what Fastify's own request line has, code, challenge, token,
URI. The alarm's metric filter is
`{ ($.audit = "admin.signin") && ($.outcome = "failure") }`; a narrower one for code guessing is
`{ ($.audit = "admin.signin") && ($.step = "code") && ($.outcome = "failure") }`. The field names
and values above are a contract with VRT-19: renaming one is a cross-repo change.

## 5. What the web can rely on (for the web spec)

- **Stateless tokens in JSON bodies.** The BFF sets no cookie. Login returns the challenge; verify
  and renew return the admin token. The web stores the admin token in its own host-only cookie on
  admin.vertice.fit (no "remember me", no `maxAge` past `expiresAt`) and the challenge in a
  separate short-lived cookie cleared after verify. It sends the admin token as the bearer only
  from the admin host, and never sends the challenge as a bearer (it would be a 401).
- **Renewal.** `POST /admin/auth/renew` while the token is valid gives a new one; `sessionEndsAt`
  never moves. Renew on the admin's own interactions, throttled, never on a timer (R11). Past
  `expiresAt` or `sessionEndsAt`, or on any 401 (`UNAUTHORIZED` or `UNAUTHENTICATED`), sign out to
  the admin login with the expiry notice.
- **Sign-in states.** `secondFactor: NOT_ENROLLED` → enroll then verify; `ENROLLED` → verify. 401
  `CHALLENGE_INVALID` or 409 `PRECONDITION_FAILED` at enroll/verify → start again from the
  password. 400 `INVALID_SECOND_FACTOR_CODE` → "código inválido", same challenge. 429 → wait
  `Retry-After`.
- **Codes to map before VRT-28 deploys:** `ADMIN_LOGIN_ELSEWHERE` on www's `/api/auth/login` →
  the existing `TRAINERS_ONLY` answer (R3), and `ACCOUNT_SUSPENDED` on both logins → the R41
  message. Later: `NAME_TAKEN`, `EXERCISE_IN_USE`.
- **Paging** is `limit`/`cursor`/`nextCursor` on every admin list (B12). **`GET
  /admin/users/:id` writes history** on every call (B13).
- **Proxy allow-list for the admin host:** `/admin/*`, `GET /auth/me`, `POST /auth/password`,
  `POST /auth/me/consent`, `GET /muscle-groups`. Anything else answers 403 to an admin token
  anyway.

## 6. Merge and deploy order

Every merge to `main` deploys (CD). Default order vertice-api → vertice-bff → vertice-web-react,
with one deviation (step 4).

1. **vertice-api slice 1, deployed:** VRT-20 → VRT-21 → VRT-22. The BFF must not mint admin tokens
   before the API enforces D6 (API §7 step 3), and VRT-23's sync needs `admin_auth.proto` and
   `required_role`.
2. **vertice-bff VRT-23** (sync, admin auth, renew, role drops, ops scripts), then **VRT-24** (read
   routes). Against an older API every new route is `UNIMPLEMENTED` (502), so the order is
   load-bearing. VRT-19 (host, alarm) can land in parallel; the alarm's filter matches nothing until
   VRT-23 is live.
3. **vertice-web-react slice 1** (VRT-25, VRT-26), after VRT-19's host exists.
4. **R3 exception: a web build that maps `ADMIN_LOGIN_ELSEWHERE` (and `ACCOUNT_SUSPENDED`) deploys
   before vertice-bff VRT-28.** The web's login route relays any non-OK answer and checks the role
   only after a 200, so the BFF first would show the BFF's text on www and break R3/E2. The web can
   map it with a route-local constant (as `TRAINERS_ONLY_CODE`), before the code is in its
   generated types; the natural carrier is VRT-25. Also check the mobile login's handling of the new
   403s (a generic error is acceptable until mobile maps them).
5. **Slice 2:** vertice-api VRT-27 deployed → (the step-4 web build live) → vertice-bff VRT-28 →
   vertice-web-react VRT-29 and the mobile login message. Between VRT-27 and VRT-28, a suspended
   user's correct password gets 409 `PRECONDITION_FAILED` and no token: safe, generic text.
6. **Slice 3:** vertice-api VRT-30 deployed → vertice-bff VRT-31 → vertice-web-react VRT-32.
   Dropping `GET /exercises` for ADMIN breaks nothing: the admin host never calls it and the API
   already refuses it.

**Rollback** is the previous task definition, in reverse order (web, then BFF, then API).
Rolling back VRT-23 just stops admin sign-in (no admin token is minted; the API still refuses old
ones). Rolling back VRT-28 restores the 200 for an ADMIN at `/auth/login`, which the web still
drops by role (R3 holds) and which both verifiers refuse. vertice-api VRT-21 is rolled back only
together with VRT-23 (or with admin login off), since without D6 an admin token would need no
second factor upstream (API §7).

## 7. Code changes per ticket (checklist)

**VRT-23**
- Proto sync (§1); `adminAuthClient`, `adminOpsClient`.
- `src/lib/jwt.ts` (B2, B3, B4), `src/plugins/authenticate.ts` (`AuthUser.authTime`).
- `src/modules/admin-auth/{routes,schemas,service}.ts`; registered in `src/app.ts` at
  `/api/admin/auth`; the `admin` plugin shell at `/api/admin` with its two hooks (B7).
- `src/grpc/call.ts`: `SERVICE_TOKEN_RPCS` (B5); `RESOURCE_EXHAUSTED` retry seconds on the error
  (B11). `src/lib/errors.ts`: `TooManyRequestsError(message, retryAfterSeconds?)`;
  `src/plugins/error-handler.ts` writes `Retry-After`.
- `src/modules/auth/routes.ts`: role hooks on the three R16b routes.
- `src/ops/` + `scripts/` + `package.json` scripts; `OPS_TOKEN_RPCS` (B6).
- `ERROR_CODES`, `docs/openapi.json`, `docs/api-contract.md` (admin auth section, ADMIN rules),
  CLAUDE.md (Auth paragraph: ADMIN now has a PRD; Trust model: the admin claims, the challenge,
  the widened service list; ops list), README "Operations".

**VRT-24**: `adminClient`; `src/modules/admin/{routes,schemas,service}.ts` read routes;
response schemas; `docs/api-contract.md` admin reads; `npm run openapi`.

**VRT-28**: sync; suspend/reactivate/e-mail/relationship routes; `auth/service.ts` login mapping
(B9, B10); `clients/service.ts` `suspended`; ops scripts; `ERROR_CODES`, OpenAPI, contract prose
(login 403s, roster field).

**VRT-31**: sync; `adminCatalogClient`; catalog and muscle-group routes; per-route `NAME_TAKEN` /
`EXERCISE_IN_USE`; `exercises/routes.ts` role hooks; `ERROR_CODES`, OpenAPI, contract prose.

## 8. Tests

**`src/test/route-authorization.test.ts` and `src/test/fakeUpstream.ts`** (every ticket):
- `SERVICE_TOKEN_RPCS` pin → the six RPCs of B5, still equal to
  `API_SERVICE_SUBJECT_RPCS['service:bff']`; the fake refuses `AdminAuthService` for a `user_id`
  that isn't an ADMIN. The `service:ops` list in the fake equals `OPS_TOKEN_RPCS` (B6).
- `ADMIN_ROUTES` is replaced by three pins:
  - `ADMIN_SELF_ROUTES` (ADMIN admitted outside `/api/admin`): after VRT-23 `GET /api/auth/me`,
    `POST /api/auth/me/consent`, `POST /api/auth/password`, `GET /api/exercises`,
    `GET /api/exercises/:id`, `GET /api/muscle-groups`; VRT-31 removes the two exercise reads;
  - `PUBLIC_ADMIN_AUTH_ROUTES`: `POST /api/admin/auth/{login,enroll,verify}`;
  - every other route under `/api/admin/` has `roles` exactly `['ADMIN']`, and no route outside it
    admits ADMIN unless it is in `ADMIN_SELF_ROUTES`.
- One table entry per new route: 401 without a token; 403 with TRAINER and CLIENT tokens; 401 with
  an ADMIN token signed without `amr`, without `auth_time`, with `auth_time` 12h + 1 s ago, and with
  `exp − iat` of 31 minutes; 401 with a challenge token as the bearer; for id routes, 404 for an
  ADMIN target id. The challenge-as-bearer check runs over **every** authenticated route in the
  table, not only admin ones.
- E41 rows: ADMIN gets 403 on `PATCH /auth/me`, `DELETE /auth/me`, `GET /auth/me/export`.
- The fake applies D6 to ADMIN tokens, so a BFF that signs a bad admin token fails here too.

**Admin auth** (`src/modules/admin-auth/routes.test.ts`, fake clock):
- login: admin password → challenge with `ENROLLED`/`NOT_ENROLLED`; trainer and client correct
  password, wrong password, unknown e-mail, oversize password → byte-identical 401 bodies;
  suspended admin → 403 `ACCOUNT_SUSPENDED` (VRT-28).
- challenge: refused by `verifyToken`; expired at 5 min + 1 s; wrong audience refused by
  `verifyAdminChallenge`.
- verify: right code → token with `amr` incl. `"otp"`, `auth_time = iat`, `exp − iat = 1800`;
  wrong code → 400 `INVALID_SECOND_FACTOR_CODE`; replayed code (fake refuses the step) → 400;
  locked → 429 with the API's `Retry-After`; malformed code → 400 with no upstream call.
- renew: extends to `iat + 1800`; at `auth_time + 11h50m` expires at exactly `auth_time + 12h`; a
  token past its `exp` → 401 without an upstream call; upstream `UNAUTHENTICATED` (suspended,
  password changed: E42) → 401; a TRAINER token → 403.
- log line: one `admin.signin` line per attempt with the §4 fields, including a bucket 429; no
  line contains the e-mail, code, challenge or URI.
- `asService` source scan (B5); `adminOpsClient` imported only under `src/ops/` (B6).

**Schemas:** `limit` 10/25/50 accepted, 0/11/100 refused; `role=ADMIN` refused on the directory;
reason blank/501 refused, 500 UTF-16 accepted; code `12345`, `1234567`, `12a456` refused.

**Mapping:** `src/grpc/call.test.ts`: `RESOURCE_EXHAUSTED` text "retry after 42 seconds" → 42 on
the error, absent → none; per-route 409 `NAME_TAKEN`, `EXERCISE_IN_USE`, 403 `ACCOUNT_SUSPENDED`,
403 `ADMIN_LOGIN_ELSEWHERE` with a wrong password still 401 (VRT-28); roster `suspended` parsed by
the response schema.

Upstream behaviour (code windows, locks, history writes, name keys) is vertice-api's to test
(API §8); the BFF tests only its own mapping and token rules.

## 9. Follow-ups (not in this change)

- A shared limiter store, if the BFF runs many tasks (B19).
- `docs/api-contract.md` drops its "ADMIN has no defined product" notes in VRT-23; anything left
  over is cleaned up in VRT-31 once the exercise reads drop.
