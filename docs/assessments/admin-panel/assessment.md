# Technical assessment (BFF): Admin Panel

Status: Draft
Owner: hebertpdl@gmail.com
Related: [vertice-api PRD](https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/admin-panel/prd.md),
[vertice-api assessment](https://github.com/herbertpdl/vertice-api/blob/main/docs/assessments/admin-panel/assessment.md),
`docs/specs/mobile-persistent-session/spec.md` (touched), `docs/specs/web-trainer-only-access/spec.md` (touched),
`docs/specs/password-lifecycle/spec.md` (touched), `docs/specs/exercise-starter-catalog/spec.md` (touched)
Spec: not yet written (will be `docs/specs/admin-panel/spec.md`)

## 1. Summary

Overall risk: **High.** The BFF is where the admin's identity is minted, so the security-critical
half of this feature is here:
- the second-factor sign-in (R8–R10);
- the 30-minute idle and 12-hour absolute admin session (R11, R12);
- the identical refusal of non-admins at the admin login (R4);
- the suspended message after a correct password (R41).

Today `POST /auth/login` signs a full 8h token for any role after the password alone
(`src/modules/auth/service.ts:37-43`), and an ADMIN token already authenticates every
any-role route (`/auth/me`, password, export, account deletion). The rest is a new `admin`
module of read routes plus a handful of writes over RPCs that don't exist yet on vertice-api
(API assessment F10). Those routes are blocked on the API slice by slice. Two existing
mappings need care: the fixed `ALREADY_EXISTS` message is about e-mail and CPF, so it would
mislabel a duplicate exercise name. `FAILED_PRECONDITION` is generic, so it can't carry
"suspended". The recommended approach is API assessment option A: the BFF runs the code check,
signs a short sliding admin token with a second-factor claim, and the API refuses ADMIN tokens
without it.

| Id | Severity | One line |
|---|---|---|
| F1 | High | Password-only login mints a usable ADMIN token today; the admin login must issue only a challenge until the code is checked |
| F2 | High | No idle limit exists and web tokens are fixed 8h; admin needs short sliding tokens capped at 12h from sign-in |
| F3 | High | Every admin route depends on vertice-api RPCs that don't exist yet; blocked per slice |
| F4 | High | `requireRole` is the only gate; ADMIN tokens must be refused on trainer/client routes and non-admin tokens on admin routes, proven by the route-authorization table |

## 2. PRD coverage map

"admin module" means a new `src/modules/admin/`. Route paths are indicative. The spec fixes them.

| Rule | Lands on | Notes |
|---|---|---|
| R1 | new route: `POST /api/admin/auth/login` (+ code step) | F1 |
| R2 | not exposed | Web navigation |
| R3 | `src/modules/auth/service.ts:37-43` | F1: trainer login should refuse ADMIN outright, not only the web |
| R4 | new admin login | F5: identical 401 |
| R5 | `requireRole('ADMIN')` on admin module | F4 |
| R6 | `requireRole` on trainer/client modules; any-role routes | F4 |
| R7 | route-authorization table (`src/test/route-authorization.test.ts:104`) | F4 |
| R8 | new route: `POST /api/admin/auth/verify` | F1 |
| R9 | new route: `POST /api/admin/auth/enroll` | F1, F9 |
| R10 | `src/ops/` | F10 |
| R11 | new route: `POST /api/admin/auth/renew` | F2 |
| R12 | admin token claims | F2 |
| R13 | not exposed | Web |
| R14 | not exposed | API refuses (`CreateUser` never ADMIN); ops F10 |
| R15 | not exposed | No BFF route changes roles; keep it so |
| R16 | admin module | API filters; BFF never accepts a role filter of ADMIN |
| R17 | new route: `GET /api/admin/dashboard` | F3 |
| R18 | same | F3 |
| R19 | not exposed | API defines activity (API F4) |
| R20 | same dashboard route | |
| R21 | same | |
| R22 | new route: `GET /api/admin/exercises/most-used` | Paged, 10/25/50 (F7) |
| R23 | same | Owner tag |
| R24 | same | `muscleGroupId` filter |
| R25 | same | F7 |
| R26 | promote route (R58) | |
| R27 | dashboard | |
| R28 | new route: `GET /api/admin/users` | F7 |
| R29 | same | `role`, `status` query |
| R30 | same | `q` |
| R31 | same | Current trainer per row |
| R32 | same | Client count per row |
| R33 | new route: `GET /api/admin/users/:id` | Client shape; F8 (CPF masked) |
| R34 | same | No logs/feedback in response |
| R35 | same | Trainer shape |
| R36 | same | Counts only |
| R37 | not exposed | Web links |
| R38 | none | No admin write route on profiles; F4 |
| R39 | new route: `POST /api/admin/users/:id/suspend` | Body: reason |
| R40 | `mapGrpcError` UNAUTHENTICATED→401 (`src/grpc/call.ts:140`) | Existing logout path |
| R41 | `POST /auth/login`, `POST /auth/session/renew` | F6 |
| R42 | same | F5 |
| R43 | not exposed | |
| R44 | new route: `POST /api/admin/users/:id/reactivate` | |
| R45 | not exposed | |
| R46 | `src/modules/clients` roster | Additive `suspended` field (F11) |
| R47 | new route: `POST /api/admin/users/:id/first-access-email` | `SendFirstAccessEmail` exists |
| R48 | new route: `POST /api/admin/users/:id/password-reset-email` | F3 |
| R49 | same | Response carries status only |
| R50 | new route: `DELETE /api/admin/relationships/:clientId` | `EndTrainerClientRelationship` exists |
| R51 | none | |
| R52 | new route: `POST /api/admin/exercises` | F3 |
| R53 | new route: `PATCH /api/admin/exercises/:id` | |
| R54 | not exposed | |
| R55 | new route: `DELETE /api/admin/exercises/:id` | 409 in use |
| R56 | new route: `GET /api/admin/exercises` | All rows, owner tag |
| R57 | none | No private-exercise write route for ADMIN |
| R58 | new route: `POST /api/admin/exercises/:id/promote` | Body: edited copy |
| R59 | not exposed | |
| R60 | promote route | F6 (duplicate code) |
| R61 | new routes: `POST /api/admin/muscle-groups`, `PATCH /api/admin/muscle-groups/:id` | |
| R62 | not exposed | |
| R63 | none | No delete route |
| R64 | exercise create/update/promote | F6 |
| R65 | muscle-group routes | F6 |
| R66 | not exposed | |
| R67 | not exposed (API writes history) | Except reading it (R71) |
| R68 | suspend/reactivate body | |
| R69 | none | No write route on history |
| R70 | not exposed | |
| R71 | new route: `GET /api/admin/audit` | Paged, filters |
| R72 | not exposed | |
| E1 | admin login + verify | |
| E2 | `src/modules/auth` | F1 |
| E3 | admin login | F5 |
| E4 | admin login | F5 |
| E5 | `requireRole('ADMIN')` | F4 |
| E6 | `requireRole` on trainer routes | F4 |
| E7 | route-authorization table | F4 |
| E8 | verify route | F1 |
| E9 | enroll route | F1 |
| E10 | `src/ops/` | F10 |
| E11 | renew route | F2 |
| E12 | renew route | F2 |
| E13 | not exposed | |
| E14 | users route | |
| E15 | users route | |
| E16 | none | |
| E17 | existing 401 path | |
| E18 | login/renew | F6 |
| E19 | login | F5 |
| E20 | suspend route schema | Reason required |
| E21 | not exposed | |
| E22 | clients roster | F11 |
| E23 | reactivate route | |
| E24 | reset-email route | |
| E25 | relationship route | |
| E26 | none | |
| E27 | not exposed | |
| E28 | delete exercise route | 409 |
| E29 | delete exercise route | |
| E30 | none | |
| E31 | promote route | |
| E32 | promote route | F6 |
| E33 | exercise create | F6 |
| E34 | muscle-group create | F6 |
| E35 | muscle-group rename | |
| E36 | none | |
| E37 | not exposed | |
| E38 | user detail route | |
| E39 | not exposed | |
| E40 | dashboard | |

## 3. Current state

The modules are: auth, clients, dashboard, exercise-sets, exercises, feedback, legal,
training-plans, users, workout-exercises, workout-sessions and workouts (`ls src/modules`).
There is no admin module.

- **Login and tokens.** `POST /auth/login` calls `VerifyCredentials` with the service token and
  signs `{ sub, role }`. ADMIN always gets the web lifetime `JWT_EXPIRES_IN`, default `8h`
  (`src/modules/auth/service.ts:32-43`, `src/config/env.ts:104`). Mobile sessions carry
  `session: "mobile"` and only they renew (`src/lib/jwt.ts:45-63`,
  `src/modules/auth/service.ts:82-97`). `verifyToken` accepts any of the three roles
  (`src/lib/jwt.ts:79-98`). The verified user token is forwarded upstream as is
  (`src/plugins/authenticate.ts:26-29`), so vertice-api sees exactly the claims the BFF signed.
- **Role gate.** `requireRole` is the only role check (`src/plugins/authenticate.ts:33-40`). Trainer
  and client modules use `requireRole('TRAINER')` or `requireRole('TRAINER', 'CLIENT')`. The
  exercise list admits ADMIN (`src/modules/exercises/routes.ts:28`). The auth routes `GET/PATCH
  /auth/me`, the password change, the export and `DELETE /auth/me` admit any role, ADMIN
  included (`src/modules/auth/routes.ts:125,246`).
- **Rate limiting.** Auth buckets are an in-memory fixed-window counter per process
  (`src/lib/attempt-limiter.ts:4-26`, "a shared store such as Redis is the follow-up").
- **Error mapping.** `mapGrpcError` gives fixed messages per status
  (`src/grpc/call.ts:107-155`): `ALREADY_EXISTS` → 409 "Email or CPF already in use",
  `FAILED_PRECONDITION` → 409 generic, `UNAUTHENTICATED` → 401 session invalid.
- **Tests.** About 365 Vitest cases. `src/test/route-authorization.test.ts:104` holds one entry per
  registered route (a route without one fails the suite).
- **Drift.** `docs/api-contract.md` (526 lines) still documents ADMIN as having "no defined
  product" through its echo in `service.ts:32`. That comment will be wrong once this ships.

## 4. Findings by dimension

### Upstream RPC readiness

**F3 (High). The admin routes have no upstream yet.**
- **What:** Only three admin operations exist on vertice-api: `SendFirstAccessEmail` (R47),
  `EndTrainerClientRelationship` (R50) and `GetUser` (partly R33/R35). Everything else needs new
  RPCs per the API assessment's F10:
  - directory, profile summaries, dashboard, most-used;
  - suspend and reactivate, the reset e-mail;
  - admin exercise list, create, update, delete and promote;
  - muscle-group writes;
  - history;
  - second-factor enrolment and verify.
- **Where:** `protos/vertice/**` (no `admin` package); API assessment F10, option A.
- **Why it matters:** None of these routes can be built or tested against a real upstream before
  the API ships them, and `npm run sync:protos` has to run after each API slice.
- **Recommendation:** Build each slice behind the API slice (API assessment §7) and sync protos
  per slice. Build the slice-1 routes against `fakeUpstream.ts` while the API is in review, but
  only merge after it.

### Route and schema design

**F7 (Medium). Pagination parameters differ from the existing lists.**
- **What:** R25 asks for a page size the admin picks (10, 25 or 50) on the most-used list. The
  directory and the history are also paged. Existing lists use an opaque `nextCursor` with a
  default and a cap (exercise list "30 by default, at most 50").
- **Where:** `src/modules/exercises/routes.ts`; R25, R28, R71.
- **Why it matters:** A different paging style per admin list costs the web three
  implementations. Free-form page sizes let a caller ask for huge pages.
- **Recommendation:** Use one paging shape for every admin list, with `limit` restricted to
  10, 25 or 50 and an opaque cursor. Page numbers aren't needed: the PRD only asks for paging,
  not jumping to page N.

**F8 (Medium). Admin profile response shapes.**
- **What:** R33 and R35 differ for clients and trainers, and both must omit logs, weights and
  feedback (R34, R36). `GET /auth/me` already masks CPF.
- **Where:** new admin user detail route; API assessment F14.
- **Why it matters:** Reusing `GetUser`'s detail view as is would put the full CPF in the
  response.
- **Recommendation:** Use a discriminated response on `role` with a fixed field set per role, and
  mask CPF with the same helper `GET /auth/me` uses (`src/lib/cpf.ts`).

### Auth, roles, and ownership

**F1 (High). The second factor must gate token signing.**
- **What:** `session()` signs a full token straight after `VerifyCredentials`
  (`src/modules/auth/service.ts:37-43`) for every role. For ADMIN, a password alone yields a token
  that the any-role routes accept now, and that every admin route would accept once built.
- **Where:** `src/modules/auth/service.ts:32-43`, `src/modules/auth/routes.ts:43-60`,
  `src/lib/jwt.ts:57-63`; R3, R8, R9, E2, E8, E9.
- **Why it matters:** If the code check lives only in the web, anyone with the password calls
  `POST https://api.vertice.fit/api/auth/login` and holds an admin session without the code.
- **Recommendation:**
  - The trainer/client login refuses ADMIN with the generic 401, so no admin token ever comes
    from it (R3).
  - A separate admin login returns only a short-lived challenge after the password: a distinct
    token type, minutes long, accepted by `verify`/`enroll` only.
  - `verifyToken` must reject the challenge everywhere else.
  - After a valid code, sign the admin token with a second-factor claim. The API refuses ADMIN
    tokens without it (API assessment option A), so an older token or a mis-signed one is useless
    upstream too.
  - Code attempts get their own attempt-limit bucket keyed by user and IP.

**F2 (High). There is no idle limit, and the fixed 8h lifetime doesn't match R11/R12.**
- **What:** Web tokens are fixed at 8h with no renewal (`src/lib/jwt.ts:63`, renewal is
  mobile-only at `src/modules/auth/service.ts:82-97`).
- **Where:** as cited; R11, R12, E11, E12.
- **Why it matters:** A stolen admin cookie works for up to 8h. The PRD wants 30 minutes idle, and
  12h absolute instead of 8.
- **Recommendation:**
  - Admin tokens live 30 minutes, carry the original sign-in time, and renew through an admin-only
    renew route while still valid.
  - Renewal is refused once 12h have passed since sign-in, and the renewed token keeps that time.
  - Renewal must go through vertice-api first, as mobile renewal does (so suspension and password
    changes stop it).
  - The web calls renew on activity.
  - The token stays stateless, so this works with any number of BFF tasks.

**F4 (High). Role separation has to be total and tested.**
- **What:** `requireRole` gates per route. The any-role auth routes admit ADMIN
  (`src/modules/auth/routes.ts:125,246`). R5 and R6 require admin routes to be ADMIN-only and
  trainer routes to refuse ADMIN.
- **Where:** `src/plugins/authenticate.ts:33-40`; `src/test/route-authorization.test.ts:88-104`; R5–R7, E5–E7.
- **Why it matters:** One admin route registered without the hook, or one trainer route opened to
  "any role", breaks the separation silently.
- **Recommendation:**
  - Register the admin module as a plugin whose `preHandler` hook is `requireRole('ADMIN')`,
    like the modules that hook roles today.
  - Decide per any-role route whether ADMIN keeps it. `/auth/me` stays (the panel shows who is
    signed in). Export and `DELETE /auth/me` arguably don't apply to admins.
  - Every new route gets a row in the route-authorization table with `roles: ['ADMIN']`, and the
    table asserts TRAINER and CLIENT get 403.

**F5 (Medium). The admin login must not reveal roles.**
- **What:** R4 requires a non-admin's correct password to get the same 401 as a wrong password.
  Today an unknown e-mail, a wrong password and no password share one 401
  (`src/modules/auth/routes.ts:50-52`).
- **Where:** new admin login; R4, E3, E4, E19.
- **Why it matters:** A different status, body or timing lets anyone find which e-mails are
  admins.
- **Recommendation:** Return the identical body and status. Count non-admin successes as failures
  in the login bucket. Run `VerifyCredentials` in every case so timing matches.

### Error mapping

**F6 (Medium). Suspension and duplicate names need their own codes.**
- **What:**
  - `ALREADY_EXISTS` always becomes "Email or CPF already in use" (`src/grpc/call.ts:134-135`),
    which is wrong for a duplicate exercise or muscle-group name.
  - `FAILED_PRECONDITION` is a generic 409 (`:130-131`), so the login can't tell "suspended"
    apart. "Exercise in use" also lands there.
- **Where:** `src/grpc/call.ts:107-155`; R41, R55, R60, R64, R65, E18, E28, E32–E34.
- **Why it matters:** The web would show the wrong text, or have to parse messages (forbidden:
  "Clients key on the `code`").
- **Recommendation:**
  - Map per route. Login and renew turn the suspended status into 403 `ACCOUNT_SUSPENDED` with the
    R41 text.
  - Admin exercise and muscle-group routes map `ALREADY_EXISTS` → 409 `NAME_TAKEN` and in-use →
    409 `EXERCISE_IN_USE`.
  - Keep the global mapping unchanged for every other route.

### Backward compatibility

**F11 (Low). Additive fields only.**
- **What:** The trainer roster gains a `suspended` flag (R46). The login gains a 403 for
  suspended users. Mobile and old web builds ignore unknown fields.
- **Where:** `src/modules/clients`; `src/modules/auth/routes.ts`; R41, R46.
- **Why it matters:** A mobile build without the new code shows its generic error for the 403
  instead of the R41 message.
- **Recommendation:** Document the new 403 in the contract. The mobile app maps the code in its
  own slice, and nothing breaks before it does.

### Composed/aggregate endpoint impact

**F12 (Info).** The dashboard is a candidate for a composed BFF endpoint (several figures in one
response). The API assessment recommends one SQL query per widget behind one admin RPC. Prefer a
single upstream call returning every figure over the BFF fanning out, so the panel loads in one
round trip and there is no composition logic here.

### Performance

**F13 (Low).** The admin traffic is a handful of users, so it adds negligible load. The only
hot-path change is the trainer and client login gaining a suspension branch, which costs no extra
call. Renewal adds one upstream call per renew, at most every few minutes per admin. Nothing to
cache.

### Security and privacy

**F9 (Medium). Enrolment shows the secret exactly once.**
- **What:** First sign-in shows a QR code for the authenticator (R9).
- **Where:** new enroll route; API assessment F9.
- **Why it matters:** The provisioning URI contains the secret. Logged, cached or returned twice,
  it gives away the factor.
- **Recommendation:**
  - Return it only from the enrol step, only with a valid challenge for a non-enrolled admin.
  - `Cache-Control: no-store`, and keep it out of `logUpstreamError`.
  - Enrolment completes only after a code from the new secret verifies.

**F14 (Medium). Logging redaction.**
- **What:** `logUpstreamError` already strips e-mails and CPFs (`src/grpc/call.ts:157-160`).
  Admin routes add suspension reasons and code submissions.
- **Where:** `src/grpc/call.ts`; R39, R68.
- **Why it matters:** A free-text reason could carry personal data into logs.
- **Recommendation:** Never log request bodies of admin routes, codes, challenges or reasons. Add
  one INFO line per admin login success or failure with user id and outcome, which is what the
  infra alarm (API assessment F24) needs.

### Testing

**F15 (Medium).**
- **What:** These need tests:
  - the route-authorization rows for every admin route;
  - the login matrix (admin at the trainer login, non-admin at the admin login, wrong password,
    suspended with right and wrong password);
  - challenge tokens refused by every other route;
  - code replay refused;
  - the renew cap at 12h and refusal after expiry;
  - per-route error codes.
- **Where:** `src/test/route-authorization.test.ts`, `src/modules/auth/routes.test.ts`, `src/grpc/call.test.ts`.
- **Why it matters:** The second-factor flow and the session limits are only safe if every
  branch is tested.
- **Recommendation:** Use a fake clock for the 30-minute and 12-hour boundaries, extend
  `fakeUpstream.ts` with the admin RPCs, and add schema tests for `limit` (10/25/50 only) and the
  reason.

### Documentation

**F16 (Low).**
- **What:** These need documenting:
  - CLAUDE.md's Auth section ("ADMIN has no defined product yet… Don't add `ADMIN` to a role list
    without a PRD"): this PRD is that PRD, and the pinned ADMIN route list in
    `route-authorization.test.ts` changes with it;
  - new error codes in `ERROR_CODES`;
  - the admin section and new error codes in `docs/api-contract.md`;
  - the comment at `src/modules/auth/service.ts:32-35` ("ADMIN has no defined product");
  - CLAUDE.md's trust-model note about the new second-factor claim, a cross-repo contract like
    the `session` claim;
  - the OpenAPI output, regenerated (the web types its calls from it).
- **Where:** as cited.
- **Why it matters:** Stale docs misdescribe the admin contract.
- **Recommendation:** Update them in each slice's PR.

### Ops

**F10 (Medium). Platform-team actions.**
- **What:** R10 and R14 (create an admin, reset their factor, suspend an admin) have no product
  path. `src/ops/` already has a `service:ops` script pattern (`issue-setup-tokens.ts`,
  `ops-token.ts`).
- **Where:** `src/ops/`; R10, R14, E10.
- **Why it matters:** Without a script, these get done as manual SQL in production.
- **Recommendation:** Add ops scripts over ops-only API RPCs. They run locally with the ops
  token, never as routes.

## 5. Options

The second factor's placement was decided upstream (API assessment option A: BFF checks the
code, the API stores the secret and checks the claim). No other material choice for the BFF.

## 6. Testing strategy

See F15. Key scenarios:
- **Trainer/client login:** ADMIN refused with the generic 401.
- **Admin login:**
  - with a TRAINER's correct password, identical 401;
  - with the right password, a challenge only, which `/api/admin/*` and `/api/auth/me` refuse;
  - wrong code refused, replayed code refused;
  - a valid code gives a token with the claim, which renews until 12h and fails after 30 minutes
    without renewal;
  - a suspended admin at renew gets 401.
- **Suspended trainer or client:** at the login with the right password 403
  `ACCOUNT_SUSPENDED`, with the wrong one 401.
- **Most-used `limit`:** 10, 25 and 50 accepted, anything else 400.
- **Duplicates:** a duplicate exercise name gives 409 `NAME_TAKEN`, not the e-mail/CPF message.
- **Route authorization:** every admin route refuses TRAINER and CLIENT tokens.

## 7. Rollout

Each slice deploys after the matching vertice-api slice (`npm run sync:protos` first) and before
the web.
- Slice 1 (admin login, 2FA, renew, directory, profiles, dashboard, history) can't ship before
  the API refuses ADMIN tokens without the claim. Otherwise the old password-only path still
  works against the API.
- Refusing ADMIN at the trainer login (R3) can ship first, on its own. The web already refuses
  admins.
- Old web builds keep working: no existing route changes shape, only additive fields and new
  routes.
- Update `docs/api-contract.md`, the OpenAPI output and CLAUDE.md per slice.

## 8. Effort and risk

**Size: L.** It adds a new module of about 20 routes, plus a new sign-in flow, token type and
renewal rules that are security-critical and need exhaustive tests. It depends on vertice-api
shipping the admin RPCs and second-factor storage first (F3). The biggest risk is the
second-factor and session design needing more than one review round.

## 9. Questions and assumptions

- A1: Admins keep `GET/PATCH /auth/me` and the password change, and lose `DELETE /auth/me` and
  the export (they are platform accounts, managed by the platform team). Confirm in the spec.
- A2: The admin token's lifetime is 30 minutes, renewed on activity, capped 12h after sign-in.
- A3: Challenge tokens last 5 minutes.

## 10. Inputs to the spec

- [ ] F1: Admin login flow (challenge, verify, enrol), refusing ADMIN at the trainer login, the second-factor claim, code attempt limits.
- [ ] F2: Admin token lifetime, renew route, 12h cap, upstream re-check on renew.
- [ ] F3: Which routes ship in which slice, gated on which API RPCs; proto sync per slice.
- [ ] F4: The admin module's role hook, which any-role routes ADMIN keeps, route-authorization rows.
- [ ] F5: Identical refusals at the admin login.
- [ ] F6: Per-route codes (`ACCOUNT_SUSPENDED`, `NAME_TAKEN`, `EXERCISE_IN_USE`).
- [ ] F7: One paging shape for admin lists, `limit` ∈ {10, 25, 50}.
- [ ] F8: Admin profile shapes per role, masked CPF.
- [ ] F9: Enrolment secret exposure rules.
- [ ] F10: Ops scripts for admin creation, 2FA reset, admin suspension.
- [ ] F14: What admin routes log.
- [ ] F15: Test matrix.
