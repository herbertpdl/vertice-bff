# Technical assessment (BFF): Feature flags

Status: Draft
Owner: hebertpdl@gmail.com
Related: `vertice-api` PRD
[`docs/prds/feature-flags/prd.md`](https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/feature-flags/prd.md),
`vertice-api` assessment
[`docs/assessments/feature-flags/assessment.md`](https://github.com/herbertpdl/vertice-api/blob/main/docs/assessments/feature-flags/assessment.md)
(cited below as "API F*n*", "API A*n*"), `docs/specs/ai-workout-assistant/spec.md` (touched: its
`AI_ASSISTANT_ENABLED` switch and boot guards), `docs/specs/admin-panel/spec.md` (touched: admin
routes; the action history is not, R23 withdrawn)
Spec: not yet written (will be `docs/specs/feature-flags/spec.md`)

## 1. Summary

Overall risk: **Medium.** On the REST surface the feature is:
- four new ADMIN routes under the existing `/api/admin` plugin (list, set everyone, set user,
  remove user);
- `GET /api/assistant/status` and `POST /api/assistant/workout-chat` reading a per-trainer flag
  through a new evaluation RPC instead of the process-wide `AI_ASSISTANT_ENABLED`.

Flag changes are not recorded in the admin action history in this version (R23 withdrawn
2026-11-20; PRD §6 defers it), so the history routes don't change.

The routes are small. The risk is in two places:
- removing `AI_ASSISTANT_ENABLED` also removes the only trigger of the boot guards on
  `VERTICE_AI_URL` and `SERVICE_JWT_SECRET` (F2);
- every RPC the BFF needs is new on vertice-api (F1).

Recommended approach: follow the API's Option A (API A2). The BFF caches nothing and asks the
evaluation RPC once per assistant request, as the caller (the trainer's own token). Any
evaluation failure means "off" (R22). The vertice-ai client is built at boot whenever
`VERTICE_AI_URL` is set, independent of the flag.

| Id | Severity | One line |
|---|---|---|
| F1 | Blocker (dependency) | The evaluation RPC and the four admin flag RPCs don't exist on vertice-api yet; the BFF can be spec'd now but not built or tested against a real upstream |
| F2 | High | `env.ts:206-221` runs the `VERTICE_AI_URL` and `SERVICE_JWT_SECRET` guards only `if (value.AI_ASSISTANT_ENABLED)`; removing the variable silently removes the guards, and "flag on, URL missing" needs a defined answer |

## 2. PRD coverage map

| Rule | Lands on | Notes |
|---|---|---|
| R1 | not exposed (web) | Menu entry |
| R2 | new route: `GET /api/admin/feature-flags` | All flags, unpaginated (API F8) |
| R3 | new route: `GET /api/admin/feature-flags` | Key, description, everyone state, user settings (count derived or sent) |
| R4 | not exposed (web filters client-side) | API F8; no `q` query |
| R5 | new routes, `admin/routes.ts:61-62` hooks | ADMIN by the plugin's hooks; second factor re-checked upstream (API `AdminTokenPolicy`) |
| R6 | existing: `requireRole('ADMIN')` | No new role |
| R7 | change: `assistant/routes.ts:55` (status) and `:84` (chat) | The trainer only learns on/off for themself (F4) |
| R8 | not exposed | Migrations upstream (API F9) |
| R9 | no create/delete route | Intentional; the plugin has none |
| R10 | new route: description passes through | Text owned by the API migration |
| R11 | new route: `PUT /api/admin/feature-flags/:key/everyone` | |
| R12 | not exposed (web) | Confirmation dialog |
| R13 | new route: `PUT /api/admin/feature-flags/:key/users/:userId` | |
| R14 | not exposed (web) | |
| R15 | new route: same PUT, idempotent upsert | PUT fits "replace" |
| R16 | new route: `DELETE /api/admin/feature-flags/:key/users/:userId` | |
| R17 | new route: `:userId` is any positive integer, no lookup | F7: bound it to a safe integer |
| R18 | new route: no cap | |
| R19 | not exposed | Evaluation is upstream |
| R20 | not exposed | Evaluation is upstream |
| R21 | change: assistant routes ask per request, no BFF cache | API caches at most 30 s (API F2, A2); the BFF adds nothing. vertice-web-react: the status query's staleTime must fit R21 with the API cache (30 s + 30 s), refetch on editor mount, retry once (`WorkoutEditor.tsx:100-105` has 5 min, no retry today) |
| R22 | change: assistant routes treat any evaluation failure as off | F4 |
| R23 | withdrawn (2026-11-20) | No history entries for flag changes; `ListActions` mapping unchanged. F3 (Low) is latent for the future flag-history change |
| R24 | new routes take no `reason` | Unlike suspend (`adminReasonSchema`) |
| R25 | not exposed | Last save wins upstream; no `If-Match` |
| R26 | not exposed | Seed migration upstream |
| R27 | change: remove `AI_ASSISTANT_ENABLED` (`env.ts:194`, `assistant/routes.ts:26`, task definition, README, `.env.example`, `docs/api-contract.md`) | F2, F8 |
| R28 | not exposed | Seed off: the status route answers `enabled: false` for everyone on day one |
| R29 | nothing to build | Owner: no per-flag guard; description text only |
| E1 | not exposed | Evaluation upstream |
| E2 | not exposed | Evaluation upstream |
| E3 | new route: number accepted, no lookup | R17 |
| E4 | new route: same | |
| E5 | new PUT then PUT | One setting, now OFF (upsert) |
| E6 | new DELETE | |
| E7 | not exposed (web) | |
| E8 | not exposed | |
| E9 | `GET /api/admin/feature-flags` | A removed flag and its settings vanish from the list |
| E10 | change: assistant routes | A running chat stream is not cut when the flag turns off (F4). vertice-web-react: the status query's staleTime must fit R21 with the API cache (30 s + 30 s), refetch on editor mount, retry once |
| E11 | change: assistant routes | Off on evaluation failure (F4) |
| E12 | not exposed | Last save wins upstream |
| E13 | not exposed (web) | |
| E14 | nothing to build | |
| E15 | not exposed | The code evaluates the trainer (API A1) |

## 3. Current state

**AI switch.** `AI_ASSISTANT_ENABLED` (`src/config/env.ts:194`, `envBoolean(false)`) is read once at
boot by `assistantSettingsFromEnv` (`src/modules/assistant/routes.ts:25-29`), called from
`src/app.ts:140`:
- `enabled = env.AI_ASSISTANT_ENABLED`;
- the vertice-ai client is built only when `enabled && env.VERTICE_AI_URL`.

The status route (`routes.ts:55`) answers `enabled && client !== undefined` with no upstream call.
The chat route (`routes.ts:84`) answers 503 `AI_UNAVAILABLE` when either is missing, before parsing
the body.

The env schema's `superRefine` (`env.ts:205-221`) runs three checks only when the switch is true:
- `VERTICE_AI_URL` required;
- `SERVICE_JWT_SECRET` must differ from `JWT_SECRET`;
- outside development/test, `SERVICE_JWT_SECRET` must pass `secretProblem` (present, ≥ 32 bytes,
  no padding, not a placeholder).

The transform (`env.ts:239`) falls back to `DEV_SERVICE_JWT_SECRET` when the secret is unset.
`signAiServiceToken` (`src/ai/token.ts:22-26`) refuses that dev value outside development/test at
runtime, a backstop written for "the guard only runs when the assistant is on".

Deployed (`.aws/task-definition.json:55-72`):
- `AI_ASSISTANT_ENABLED=false`;
- `VERTICE_AI_URL=http://vertice-ai:8000`;
- `SERVICE_JWT_SECRET` from Secrets Manager.

vertice-ai itself is not deployed yet.

**Admin plugin.** `src/modules/admin/routes.ts:60-62`: every route under `/api/admin` gets
`app.authenticate` and `requireRole('ADMIN')` as plugin hooks. The admin token carries
`amr`/`auth_time` (`src/lib/jwt.ts:121,140-152`), re-checked by vertice-api on every call. Write
routes log `audit: "admin.<thing>.<action>"` with actor and target ids (`routes.ts:206`,
`routes.ts:238`).

**History mapping.**
- `ADMIN_ACTIONS` (`admin/schemas.ts:49-63`) lists 13 values and backs the `?action=` filter
  (`schemas.ts:69`, a `z.enum`).
- `toActionEntry` (`admin/service.ts:336-349`) strips `ADMIN_ACTION_` with `e.action.replace(...)`
  and casts.
- `ActionEntryResponse` (`service.ts:116-128`) has no flag key or user-number field.

**First access.**
- `createClient` (`clients/service.ts:63-87`) calls `CreatePasswordSetupToken` after
  `CreateClientForTrainer`, catches any failure, logs a warning and returns `setup: null`.
- `reissueSetupToken` (`service.ts:96-102`) checks `ListUsersWithoutPassword`, then calls
  `CreatePasswordSetupToken`, uncaught.
- The admin's `sendFirstAccessEmail` / `sendPasswordResetEmail` (`admin/service.ts:459-470`) map
  FAILED_PRECONDITION ("switched off") to 409.
- The BFF never calls `SendFirstAccessEmail` for trainers yet (VRT-10, BFF client-first-access-email
  assessment F1).

**Ops.** `npm run ops:issue-setup-tokens` (`scripts/issue-setup-tokens.ts`,
`src/ops/issue-setup-tokens.ts:38-56`) lists every CLIENT as `service:ops` and calls
`CreatePasswordSetupToken` for each, writing the CSV header first.

**Protos.** `protos/vertice/**` matches `../vertice-api/src/main/proto/vertice/**` file for file
(diffed this session against vertice-api `863ef3b`). Nothing for flags exists on either side.
`PROTO_FILES` (`src/grpc/loadProto.ts:9-23`) loads with `enums: String, defaults: true`.

**Drift.** `docs/api-contract.md:661-663` says `GET /assistant/status` makes "No upstream call",
and the route description (`routes.ts:49`) says the same. Both become false. Both API-contract
mentions (`:248`, `:661`) and `src/openapi/docs.ts:38` name `AI_ASSISTANT_ENABLED`.

The web already reads the status. On vertice-web-react `origin/main` (`9a386d8`),
`src/components/domain/WorkoutEditor/WorkoutEditor.tsx:100-105` queries it with
`staleTime: 5 * 60_000, retry: false` and hides the AI button on any failure. Two web comments
name `AI_ASSISTANT_ENABLED`: `WorkoutEditor.tsx:98-99` and `src/lib/api/assistant.ts:8`. The
query key `["assistantStatus"]` is not per user, which is fine: sign-out clears the whole cache
(`src/lib/auth/useSignOut.ts:15`, `queryClient.clear()`), so a per-trainer answer never carries
over to the next user in the same browser.

## 4. Findings by dimension

### 1. Upstream RPC readiness

**F1 (Blocker, dependency). Every RPC this feature calls is new.**
- **What:** The BFF needs an evaluation RPC ("is flag K on for me", API F5) and four ADMIN RPCs:
  list flags, set everyone, set user, remove user. None exist on vertice-api; no flag proto exists
  on either side.
- **Where:** API assessment F5, §7 step 1; `protos/vertice/**`; `src/grpc/clients.ts:8-39`.
- **Why it matters:** The routes can be designed now but not implemented or tested against a
  real upstream until vertice-api ships them. If the RPCs live in a new service (for example
  `vertice.featureflag.v1.FeatureFlagService`), the BFF also needs a new entry in `PROTO_FILES`
  and a new client in `clients.ts`. If they join `AdminService`, it needs neither.
- **Recommendation:**
  - Spec the BFF against the API spec's proto.
  - Sync with `npm run sync:protos` after the API merges.
  - Ask the API spec to put evaluation where a TRAINER token is allowed. `AdminService` is ADMIN
    only (`AdminRefusalCoverageTest`), so evaluation can't sit there.

### 2. Route and schema design

**F5 (Medium). The admin flag routes' shape.**
- **What:** Four routes in the existing `admin` module, under the plugin's hooks so ADMIN and the
  second factor come for free:
  - `GET /api/admin/feature-flags` → `{ flags: [{ key, description, enabled, users: [{ userId, enabled }] }] }`.
    The web needs each flag's settings for the per-flag user list, and their count for the row
    (R3). With no users yet (API F8), inline beats a second route per flag.
  - `PUT /api/admin/feature-flags/:key/everyone` with body `{ enabled: boolean }` → 200 with the
    flag.
  - `PUT /api/admin/feature-flags/:key/users/:userId` with body `{ enabled: boolean }` → 200 with
    the flag. An upsert, so PUT (R15).
  - `DELETE /api/admin/feature-flags/:key/users/:userId` → 200 with the flag.
- **Where:** new routes in `src/modules/admin/routes.ts`; schemas in `admin/schemas.ts`; R2, R3,
  R11, R13, R15, R16, R24.
- **Why it matters:**
  - Returning the updated flag from every write saves the web a refetch, as the suspend routes
    return the directory row (`routes.ts:197`).
  - No body carries a `reason` (R24). Using `adminReasonSchema` by habit would make the page
    demand one.
  - `:key` needs a strict pattern (uppercase snake case, API A3, with a length bound) so a
    malformed key is a 400 with no upstream call.
- **Recommendation:**
  - Put the flag key in the path, not a numeric flag id. Keys are stable across environments, and
    flags are created by migrations.
  - Send `enabled` as a JSON boolean, `z.boolean()`, not a string.
  - Write one `audit: "admin.flag.<everyone|user_set|user_removed>"` line per write with
    `actorId`, `flag` and `userId`.

**F6 (Medium). The assistant routes: where the evaluation happens.**
- **What:** `assistantSettingsFromEnv` (`assistant/routes.ts:25-29`) computes `enabled` once at
  boot. Per-trainer means asking per request.
- **Where:** `routes.ts:26` (`enabled`), `:55` (status), `:84` (chat gate).
- **Why it matters:**
  - Status becomes per caller: `{ enabled: flagOnForMe && client !== undefined }`. The response
    shape stays the same, so the contract is unchanged.
  - In the chat route, the check stays first, before body parsing and before `buildChatContext`,
    so an off trainer still triggers no catalog reads.
  - `AssistantSettings.enabled` stops being a boolean. Tests inject it today
    (`assistant/routes.test.ts:62,248,259`; `route-authorization.test.ts:1266`). It becomes an
    injectable evaluator (`isEnabledFor(user)`) so tests keep switching it without a fake RPC.
- **Recommendation:** Replace `enabled: boolean` with an evaluator function, defaulting to the
  RPC call. Keep `client` built at boot (F2).

### 3. Auth, roles, and ownership

Nothing found beyond F4's scoping. Checked:
- The admin routes inherit `authenticate` + `requireRole('ADMIN')` from the plugin hooks
  (`admin/routes.ts:61-62`). `route-authorization.test.ts` fails for any route without a table
  entry, so the four routes must be added there (403 for TRAINER/CLIENT, 401 with no token).
- R17 has no ownership: `:userId` is not checked against the directory, on purpose. Upstream it
  has no foreign key (API F10).
- The evaluation is sent with the trainer's own token: `grpcCall`'s default
  (`grpc/call.ts:89-95`). Never `asService`, and it must not go into `SERVICE_TOKEN_RPCS`
  (`call.ts:23-30`).

### 4. Error mapping

**F4 (Medium). An evaluation failure must mean off, and must not hang.**
- **What:** R22 and E11: if the flags can't be read, the feature is off. The status route has
  never failed for upstream reasons (no upstream call today). With an RPC it can get the global
  mapping (`call.ts:138-174`): 503 `UPSTREAM_UNAVAILABLE`, or 502 `UPSTREAM_ERROR` (including
  UNIMPLEMENTED, against an API release without the RPC).
- **Where:** `assistant/routes.ts:55`, `:84`; `grpc/call.ts:61-78` (no deadline on any
  `grpcCall`); R22, E11.
- **Why it matters:**
  - A 5xx on status turns "AI off" into an error state on the workout editor.
  - With no deadline, a hung upstream holds the status call indefinitely. The first request
    after Aurora resumes legitimately takes about 15 s (API §3).
  - For the chat route, "off" is already 503 `AI_UNAVAILABLE`, the right answer here too.
- **Recommendation:**
  - Status: catch any evaluation failure, answer `{ enabled: false }`, and log one warning
    (`rpc`, no user data).
  - Chat: on failure, the same 503 `AI_UNAVAILABLE` as "switched off".
  - Give the evaluation call a deadline above Aurora's resume time, for example 20 s, through
    `GrpcCallOptions`. The first evaluation after an idle pause waits for the database (about
    15 s, API §3, vertice-api#89). A deadline of a few seconds would answer "off" to the first
    trainer after every pause, and that "off" would then sit in the web's 30 s cache. The deadline
    is there to stop a hang, not to hide a slow database. Today `GrpcCallOptions` has no deadline,
    so this is a small addition to `call.ts`.
  - E10: a chat stream already running when the flag turns off is not cut. The next message is
    refused. That fits "within about a minute".
  - Admin routes keep the global mapping: unknown key NOT_FOUND → 404; non-positive number
    INVALID_ARGUMENT → 400 (caught by the BFF first).

### 5. Backward compatibility

**F3 (Low). Latent: an unknown `AdminAction` breaks the whole history page.**
- **What:** `loadProto.ts` decodes with `enums: String`. protobufjs 7.6.5's converter
  (`node_modules/protobufjs/src/converter.js:176`) keeps an enum number the local proto doesn't
  know as a number. Reproduced this session: an `AdminAction` of 99 decodes to `{"action":99}`.
  `toActionEntry` (`admin/service.ts:340`) then calls `e.action.replace(...)` on a number, a
  TypeError, so `GET /api/admin/actions` answers 500 for any page containing one such entry.
- **Where:** `admin/service.ts:336-349`; `admin/schemas.ts:49-63`; `grpc/loadProto.ts`.
- **Why it matters:** This feature no longer triggers it: R23 is withdrawn and the API emits no
  new `AdminAction` values. It is a latent bug for whichever later change adds an action,
  including the deferred flag-history change (PRD §6). There, a BFF rollback after the first new
  entry would make the history a 500 until it is redeployed forward, because V39's rows are
  permanent.
- **Recommendation:** Fix it whenever a change adds an action, and ship the fix one BFF release
  before the API starts writing the new value, or take it now while in the admin module. Make
  `toActionEntry` total: a non-string, or a value not in `ADMIN_ACTIONS`, maps to a fixed `UNKNOWN`
  with one warning, never a throw. Add `UNKNOWN` to `adminActionSchema`
  (`openapi/responses.ts:317`). The `?action=` filter stays a closed `z.enum`. Not required for
  this feature's release.

**F8 (Medium). Removing `AI_ASSISTANT_ENABLED` and the status contract.**
- **What:** R27 removes the env variable. `GET /api/assistant/status` keeps its shape
  (`{ enabled }`) but now varies per trainer.
- **Where:** `env.ts:186-194`; `assistant/routes.ts:17-29,49`; `.aws/task-definition.json:55-57`;
  `README.md:78`; `.env.example:58`; `docs/api-contract.md:248,661-663`; `src/openapi/docs.ts:38`.
- **Why it matters:**
  - The web reads status (`WorkoutEditor.tsx:100-105`) and only uses `enabled`, so the shape is
    unchanged for it. Its 5-minute `staleTime` breaks R21's minute once the answer can change at
    runtime: with the API's 30 s cache and no BFF cache, the web's `staleTime` must be 30 s, with a
    refetch on editor mount and one retry (§7 step 3).
  - The env schema is a plain `z.object` (it strips unknown keys), so a task definition that still
    sets `AI_ASSISTANT_ENABLED` boots fine and the variable does nothing. That is harmless, but it
    misleads an operator.
  - Seeded off (R28) matches today's `false`, so the cut-over changes nothing that anyone can see.
- **Recommendation:**
  - Remove the variable, its task-definition entry, README row and `.env.example` line in the
    same PR.
  - Regenerate `docs/openapi.json` and `docs/api-contract.md` (`openapi.test.ts:27` fails
    otherwise).
  - Fix "No upstream call" in the status description.

### 6. Composed/aggregate endpoint impact

Nothing found. Checked:
- `GET /dashboard`, `GET /clients`, `GET /clients/:id/overview`, `GET /workouts/:id/full`. None
  carries assistant state. The web reads `/assistant/status` on its own.
- Folding the AI state into a composed endpoint would add an RPC to every dashboard load, for one
  screen's icon.

### 7. Performance

Nothing found beyond F4's deadline. Checked:
- One extra unary RPC per status call and per chat message. The API answers from its cache
  (API F2), and a chat takes seconds, so the RPC is negligible (API Option A).
- No BFF cache, so no second window adds to R21's minute and no BFF timer exists (API F2's Aurora
  concern doesn't arise here).
- The flag list is unpaginated: few flags, few settings (API F8).
- `grep -rn "page_size\|page_token" protos/` shows paging only on `ListUsers` and the admin lists,
  none needed here.

### 8. Security and privacy

**F2 (High). The vertice-ai boot guards hang on the variable being removed.**
- **What:** `env.ts:206` wraps three checks in `if (value.AI_ASSISTANT_ENABLED)`. With the
  variable gone they never run:
  - the `SERVICE_JWT_SECRET` strength check;
  - the "must differ from `JWT_SECRET`" check;
  - the `VERTICE_AI_URL` presence check.

  The transform (`env.ts:239`) then defaults the secret to the public `DEV_SERVICE_JWT_SECRET`.
  The flag can now turn on at runtime, long after boot, so a boot guard keyed to it is impossible.
- **Where:** `src/config/env.ts:205-221,239`; `src/ai/token.ts:22-26`;
  `assistant/routes.ts:25-29`; R27.
- **Why it matters:**
  - A weak secret, or `SERVICE_JWT_SECRET == JWT_SECRET`, would boot without complaint. The equal
    secret is the case the BFF's own assessment F7 called out: a vertice-ai token that is a live
    vertice-api credential.
  - `token.ts:24` only catches the unset or dev case, and only at the first chat.
  - **Flag on, URL missing.** If the client stays "built only when enabled", it can't be built
    once enabled is per request. If it is built when `VERTICE_AI_URL` is set, a missing URL means
    no client. Status then answers `enabled: false` (the `&& client !== undefined` at `:55`
    already does this), and chat answers 503 `AI_UNAVAILABLE` (`:84`). That is consistent with
    R22, but silent: the admin sees the flag on and no trainer sees the icon.
  - Prod has both values set (`task-definition.json:59-72`), so nothing breaks on day one.
- **Recommendation:**
  - Key the guards on `VERTICE_AI_URL` being set, not on a switch. When the URL is set, apply the
    secret's strength check (outside development/test) and the "differs from `JWT_SECRET`" check.
    An unset URL means "the assistant can't run in this deployment".
  - Build the client at boot whenever the URL is set.
  - Log one warning at boot when `VERTICE_AI_URL` is unset outside development/test.
  - On a chat refused for a missing client while the flag is on, log a warning (no user data)
    distinct from "flag off", so the silent case shows up in CloudWatch.
  - Keep `token.ts:24` as the backstop. This is a deployment invariant, not page logic, so it
    respects the owner's no-per-flag-guards decision.

**F7 (Low). `:userId` accepts integers past 2^53.**
- **What:** `parseId` (`src/lib/net.ts:3-9`) checks `Number.isInteger(id) && id > 0`. A 20-digit
  number passes but loses precision before it reaches the int64 field, so the setting lands on a
  different number than typed.
- **Where:** `src/lib/net.ts:4-5`; R17, E3.
- **Why it matters:** R17 allows any number, and the page can't show whose it is. A silently
  changed number is worse than a 400.
- **Recommendation:** Refuse anything above `Number.MAX_SAFE_INTEGER` on this route (or in
  `parseId` for every route).

Also checked, nothing found:
- No new PII: a user number with no name (R17, out-of-scope list).
- Flag descriptions are developer-written migration text, rendered by the web as text.
- The admin audit lines carry ids and the flag key only.

### 9. Testing

Covered in §6. The admin, assistant and env modules all have tests to extend
(`admin/routes.test.ts`, `assistant/routes.test.ts`, `config/env.test.ts`,
`test/route-authorization.test.ts`); 44 test files exist. The fake upstream
(`src/test/fakeUpstream.ts`) needs the five new RPCs.

### 10. Documentation

Covered in F8: regenerate `docs/openapi.json` and the route reference in `docs/api-contract.md`,
rewrite the assistant section's "off unless `AI_ASSISTANT_ENABLED`", and update the README env
table and `.env.example`. `CLAUDE.md:78` describes the assistant module and should say the switch
is the `AI_ASSISTANT_ENABLED` flag on the admin page. Add a line to the admin-panel section of the
contract for the flag routes. No new error code.

### 11. Effort, risk, and dependencies

See §8.

### First access (noted, no guard proposed)

**F9 (Medium). What a per-trainer first-access ON does to today's BFF routes.**
- **What:** With API A1 (the trainer is evaluated on create, resend and token request), a trainer
  set to ON gets `CreatePasswordSetupToken` refused with PERMISSION_DENIED. The API sends the
  e-mail itself after `CreateClientForTrainer` (API §3, `FirstAccessEmailService.java:71`).
  - `POST /api/clients` (`clients/service.ts:80-86`) still answers 201 with `setup: null`. It logs
    "issuing the password setup token failed" at WARN with the error on every create. The response
    tells the web "no link, re-issue it", while an e-mail went out.
  - `POST /api/clients/:id/setup-token` (`service.ts:96-102`) answers 403 `FORBIDDEN` "You do not
    have access to this resource" for the trainer's own client.
  - Everyone ON does the same for every trainer.
  - The admin's `first-access-email` and `password-reset-email` routes
    (`admin/routes.ts:210-245`) answer 409 `PRECONDITION_FAILED` unless the flag is on for that
    admin, or for everyone.
- **Where:** `clients/service.ts:63-102`; `admin/service.ts:459-470`; API F3, A1; R10, R19.
- **Why it matters:** Until VRT-10/11 replace these routes (BFF client-first-access-email
  assessment F1), turning the flag on for a trainer leaves their web showing a failed link plus a
  403 on retry. The client does get the e-mail, if SES is ready. The owner accepted this as the
  admin's call (R29, API F12).
- **Recommendation:** No guard. Put it in the flag's description text (R10): "turning this on for
  a trainer before the e-mail screens ship leaves their 'novo aluno' link empty; the client gets
  the e-mail". The spec may choose to log that refusal at INFO instead of WARN.

**F10 (Medium). `ops:issue-setup-tokens` follows the everyone state only.**
- **What:** The script calls `CreatePasswordSetupToken` as `service:ops`, which has no user, so it
  evaluates the everyone state (API A1).
  - Everyone ON: the first call is PERMISSION_DENIED. The script writes the CSV header, fails on
    the first client and exits 1 (`issue-setup-tokens.ts:44-55`, `scripts/issue-setup-tokens.ts:33`).
    That is clean.
  - Everyone OFF with some trainers ON: the script still prints raw links for those trainers'
    clients, and each one rotates the client's token. That invalidates the link the client was
    e-mailed (only the newest token works, `service.ts:91`).
- **Where:** `src/ops/issue-setup-tokens.ts:38-56`; API A1; client-first-access-email PRD.
- **Why it matters:** A one-off migration script run in mixed mode quietly undoes an e-mail.
- **Recommendation:**
  - No code guard (owner decision).
  - Note in the script's header comment and the README "Operations" section: run it only while
    the first-access flag is off for everyone with no user settings, or replace it with the
    `SendFirstAccessEmail` path (API F12).
  - The flag's description should mention it too.

## 5. Options

Evaluation caching was decided upstream (API Option A, A2): the BFF asks per request and caches
nothing. The one BFF-side choice is in F2, where the vertice-ai guards key on:
- **A. `VERTICE_AI_URL` being set.** Recommended: it is the only boot-time fact left about whether
  the assistant can run here.
- **B. Unconditional outside development/test.** Simpler, but every deployment without vertice-ai
  would need a dummy URL and secret.

## 6. Testing strategy

**Env (`config/env.test.ts`):**
- `AI_ASSISTANT_ENABLED` no longer exists. Setting it is ignored, not an error.
- With `VERTICE_AI_URL` set in production: a missing, short, padded, placeholder secret, or one
  equal to `JWT_SECRET`, is refused. These are today's cases, re-keyed from `on` to the URL
  (`env.test.ts:201-248`).
- With no URL in production: boots.

**Assistant (`assistant/routes.test.ts`):**
- Status is `true` only when the evaluator says on for this trainer and a client exists.
- Two trainers with different answers get different status.
- The evaluator throwing (each of UNAVAILABLE, UNIMPLEMENTED, a deadline) → `{ enabled: false }`,
  200.
- An evaluation slower than a few seconds but within the deadline (an Aurora resume) still
  answers `{ enabled: true }`.
- Chat with the flag off, or the evaluator throwing → 503 `AI_UNAVAILABLE`, and no
  `buildChatContext` call and no vertice-ai call.
- Flag on with no client → 503, with the distinct warning.
- The evaluation goes out with the trainer's token, never the service token.

**Admin (`admin/routes.test.ts`, `route-authorization.test.ts`):**
- The four routes: 401 without a token, 403 for TRAINER and CLIENT, OK for ADMIN.
- A body with a `reason` is not required.
- `enabled` must be a boolean (`"true"` is 400).
- `:key` outside the pattern → 400 with no upstream call.
- `:userId` of 0, -1, `abc` or above 2^53 → 400.
- Upstream NOT_FOUND → 404.
- Each write logs one audit line with actor, flag and user number.

**History:** nothing for this feature. If F3 is taken, an unknown enum number (99) and an unknown
string map to `UNKNOWN` and the page is 200.

**Protos:** the fake upstream implements the new RPCs. `openapi.test.ts` stays green after
`npm run openapi`.

## 7. Rollout

Order (API §7):
1. **vertice-api** ships the tables, the seeded flags (off), the RPCs, and the first-access reads
   moved onto the flag. Today's BFF keeps working: it calls nothing new, and its
   `AI_ASSISTANT_ENABLED=false` matches the seed.
2. **vertice-bff**, one release:
   - `sync:protos`;
   - the evaluation in the assistant routes;
   - `AI_ASSISTANT_ENABLED` removed and the guards re-keyed (F2);
   - the four admin routes.

   Can it ship before the API? Technically yes for the assistant: an UNIMPLEMENTED evaluation
   means off (F4). The admin routes would answer 502, though, so ship it after.
3. **vertice-web-react**:
   - the "Feature flags" page;
   - the assistant-status query in `WorkoutEditor.tsx:100-105`: `staleTime` 30 s (so 30 s API
     cache + 30 s web stays within R21), refetch on editor mount, retry once;
   - the comments naming `AI_ASSISTANT_ENABLED` (`WorkoutEditor.tsx:98-99`,
     `src/lib/api/assistant.ts:8`) updated to say the switch is the flag on the admin page.

   The query key needs no user in it: sign-out calls `queryClient.clear()`
   (`src/lib/auth/useSignOut.ts:15`).

**Rollback:**
- Rolling the BFF back restores the env switch at `false`. That is consistent with the seed, but
  any flag turned on in the meantime stops applying to the AI assistant.

**After deploy:**
- `GET /api/assistant/status` as a trainer answers `{ enabled: false }`.
- Turning the AI flag on for your own trainer test account flips it within a minute.
- With vertice-ai still not deployed, a chat then yields `AI_UNAVAILABLE` events. That is
  expected: description text.

**Docs to update:** `docs/api-contract.md` and `docs/openapi.json` (generated), the README env
table, `.env.example`, `CLAUDE.md:78`, and `.aws/task-definition.json` (drop the variable). In
vertice-web-react: the comments at `WorkoutEditor.tsx:98-99` and `src/lib/api/assistant.ts:8`.

## 8. Effort and risk

**Size M:**
- four thin admin routes with schemas;
- one evaluator wired into two assistant routes;
- an env-guard rework with its existing tests re-keyed;
- fake-upstream and route-authorization entries.

Most of the work is tests. The highest-risk part is F2: it moves security checks.

**Dependency:** blocked on vertice-api shipping the five RPCs (F1). Nothing in the BFF can be
tested against a real upstream before that.

## 9. Questions and assumptions

None asked of the owner. Assumptions the spec should use:
- **A1 (F1):** the evaluation RPC accepts a TRAINER token and answers for the caller only, taking
  a flag key and returning a boolean (API F5). The admin RPCs live in `vertice.admin.v1` (either
  `AdminService` or a new admin service), ADMIN only.
- **A2 (F5):** the list RPC returns each flag with its user settings inline. If the API spec
  returns only a count, the BFF adds `GET /api/admin/feature-flags/:key/users`.
- **A3:** the API writes no history entry for flag changes and adds no `AdminAction` value
  (R23 withdrawn); `ListActions` and its mapping are untouched.
- **A4 (F2):** a deployment without `VERTICE_AI_URL` is a valid "assistant can't run here" state,
  not a boot failure.
- **A5 (F9, F10):** the first-access flag evaluates the trainer for trainer calls, the admin for
  admin sends, and the everyone state for `service:ops` (API A1).

## 10. Inputs to the spec

- [ ] F1: proto sync step, the new client (if a new service), and where the evaluation RPC lives
  (TRAINER-callable).
- [ ] F2: key the vertice-ai guards on `VERTICE_AI_URL`; build the client at boot when the URL is
  set; the "flag on, no client" behaviour and its warning.
- [ ] F4: evaluation failure means off on both routes; a deadline on the evaluation call above
  Aurora's ~15 s resume (for example 20 s); a running stream isn't cut.
- [ ] F5: the four routes' paths, bodies (no `reason`), the key pattern, the response (the updated
  flag), and the audit lines.
- [ ] F6: `AssistantSettings.enabled` becomes an injectable per-user evaluator.
- [ ] F8: remove `AI_ASSISTANT_ENABLED` everywhere and regenerate the docs; status description
  no longer says "No upstream call".
- [ ] F9: description text for the first-access flag; no guard; the log level of the refusal.
- [ ] F10: the ops script's note (run only while the flag is off for everyone), or its replacement.
