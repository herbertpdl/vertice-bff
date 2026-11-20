# Spec (BFF): Feature flags

Status: Draft
Owner: hebertpdl@gmail.com
Related: [vertice-api PRD](https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/feature-flags/prd.md)
(Approved 2026-11-20; R1–R29, E1–E15, not restated here),
[vertice-api spec](https://github.com/herbertpdl/vertice-api/blob/main/docs/specs/feature-flags/spec.md)
(D1–D19, the gRPC contract this bridges; it wins over this document on any RPC detail),
this repo's [assessment](../../assessments/feature-flags/assessment.md) (F1–F10, A1–A5, resolved in §0),
[vertice-web-react assessment](https://github.com/herbertpdl/vertice-web-react/blob/main/docs/assessments/feature-flags/assessment.md)
(the consumer: W2, W4, W6, W8, W11, its A1). Touched: `docs/specs/ai-workout-assistant/spec.md`
(its `AI_ASSISTANT_ENABLED` switch and boot guards), `docs/specs/admin-panel/spec.md` (four routes
join the `/api/admin` plugin; the history is unchanged). Ticket: VRT-53.

The BFF owns no flag data and evaluates nothing itself. What it owns here is: which routes call the
two new services, with whose token, how a failed evaluation reads (off), how the vertice-ai boot
checks survive the removal of the env switch, and the REST shape the admin page builds against.

## 0. Scope decisions

Each row resolves a finding of this repo's assessment (§10 inputs) and traces to the PRD and the
API spec's decisions.

| # | Decision | Why |
|---|---|---|
| FF1 | **Bridge exactly the API's two new services (F1, Blocker).** `protos/.api-ref` ← the vertice-api merge SHA of its feature-flags PR, then `npm run sync:protos`. `PROTO_FILES` gains `vertice/featureflag/v1/feature_flag.proto` and `vertice/admin/v1/admin_feature_flags.proto`; `clients.ts` gains `featureFlagClient` (`vertice.featureflag.v1.FeatureFlagService`) and `adminFeatureFlagClient` (`vertice.admin.v1.AdminFeatureFlagService`). Evaluation lives where a TRAINER token is allowed (API D10), so A1 holds. Nothing is built before the API merge: the BFF PR's CI (`sync:protos --check`) needs the pinned files to exist. | F1; API D10, D11, §3.1–§3.2, §7. |
| FF2 | **The vertice-ai checks key on `VERTICE_AI_URL` being set (F2, High; Option A).** `AI_ASSISTANT_ENABLED` is deleted from `env.ts`. The `superRefine` block runs whenever `VERTICE_AI_URL` is set (in any `NODE_ENV`): `SERVICE_JWT_SECRET` must differ from `JWT_SECRET`, and outside development/test it must pass `secretProblem` (present, ≥ 32 bytes, no padding, not in `PLACEHOLDER_SERVICE_JWT_SECRETS`). The "URL required" check is gone: an unset URL is a valid "the assistant can't run here" state (A4). The vertice-ai client is built at boot whenever the URL is set. `signAiServiceToken`'s dev-secret refusal (`token.ts:22-26`) stays as the backstop, comment updated. | F2; R27; owner decision. A flag can turn on at runtime, so a boot check keyed to it is impossible; the URL is the only boot-time fact left about whether the assistant can run. |
| FF3 | **Flag on, no client: off, with a distinct warning (F2).** Status answers `{enabled:false}` without evaluating when no client exists (nothing it could say is useful, and the status polls every 30 s). Chat evaluates first; on + no client → 503 `AI_UNAVAILABLE` plus one WARN `{assistant: 'unavailable', reason: 'no_client', userId}`. At boot, outside development/test, an unset `VERTICE_AI_URL` logs one WARN "VERTICE_AI_URL is not set: the AI assistant is off for everyone". | F2: the admin sees the flag on and nobody sees the icon; these two lines make that visible in CloudWatch. |
| FF4 | **Per-trainer evaluation, no cache, 20 s deadline, any failure = off (F4, F6).** `GET /api/assistant/status` and `POST /api/assistant/workout-chat` call `EvaluateFeatureFlag { key: "AI_ASSISTANT_ENABLED" }` once per request with the trainer's own token (`grpcCall`'s default; never `asService`, never in `SERVICE_TOKEN_RPCS`). `GrpcCallOptions` gains `deadlineMs`, passed to grpc-js as `{ deadline: Date.now() + deadlineMs }`; the evaluation uses 20 000. Any rejection (`UNAVAILABLE`, `UNIMPLEMENTED`, `DEADLINE_EXCEEDED`, a mapped `HttpError`, anything thrown) is off: status 200 `{enabled:false}`, chat 503 `AI_UNAVAILABLE`, each with one WARN `{flag, outcome: 'evaluation_failed', code}` (no user data). | R7, R19–R22, E10, E11; API D9; owner decision. 20 s sits above Aurora's ~15 s resume, so the first trainer after a pause isn't told "off" for a slow database. |
| FF5 | **The chat gate stays first and a running stream is not cut (F4, E10).** The evaluation runs before body parsing and before `buildChatContext`, as today's `enabled` check does, so an off trainer triggers no catalog read and no vertice-ai call. A stream already running when the flag turns off finishes; the next message is refused. | E10, R21 ("within about a minute"). |
| FF6 | **`AssistantSettings.enabled: boolean` becomes `isEnabledFor(user, log): Promise<boolean>` (F6).** The default is `isFlagOn('AI_ASSISTANT_ENABLED', log)` from a new `src/modules/feature-flags/service.ts`, which never rejects (FF4's catch lives there). `buildApp({ assistant: { isEnabledFor } })` overrides it in tests. The key is one constant, `AI_ASSISTANT_FLAG`, there. | F6; keeps today's test injection without a fake RPC where a test doesn't need one. |
| FF7 | **Four admin routes in the `admin` plugin (F5).** `GET /api/admin/feature-flags` (settings inline), `PUT /api/admin/feature-flags/:key/everyone {enabled}`, `PUT /api/admin/feature-flags/:key/users/:userId {enabled}`, `DELETE /api/admin/feature-flags/:key/users/:userId`. ADMIN and the second factor come from the plugin hooks (B7). Writes send the absolute state (`z.boolean()`, never a toggle; W4) and return the updated flag the API read back (200, also on the DELETE). No `reason` (R24): `adminReasonSchema` is not used. Unknown key: the global `NOT_FOUND` → 404 `NOT_FOUND`. §2. | R2–R6, R9, R11, R13–R18, R24, R25, E5, E6, E9, E12; API D11–D13; web A1. |
| FF8 | **`:key` and `:userId` are checked before any upstream call (F5, F7).** `:key` matches `^[A-Z][A-Z0-9_]*$`, 1–64 characters (API D4). `:userId` is digits only, no leading zero, and a safe integer (`≤ 2^53 − 1`); anything else, `0` and `1e3` included, is 400 `VALIDATION_ERROR`. `parseId` (`lib/net.ts`) is not changed here (§7). | R17, E3; F7: a 20-digit number would otherwise lose precision and land on another user. |
| FF9 | **`user_id` arrives as a string and leaves as a number.** `loadProto` uses `longs: String`, so `FeatureFlagUserSetting.user_id` is a decimal string. The mapper converts with `Number`; a value that isn't a positive safe integer (writable only by a direct gRPC call, never through FF8) is dropped from the response with one WARN `{flag, outcome: 'unsafe_user_id'}`, so the page never shows a number other than the stored one. | The REST contract keeps ids as numbers everywhere else; fail closed rather than render a rounded id. |
| FF10 | **One audit line per admin write (B15).** After the upstream call succeeds: `audit: 'admin.flag.everyone'` `{actorId, flag, enabled}`, `'admin.flag.user_set'` `{actorId, flag, userId, enabled}`, `'admin.flag.user_removed'` `{actorId, flag, userId}`. INFO, never a body. No history entry and no new `AdminAction` (R23 withdrawn, A3). | Owner decision; API D2, D14. |
| FF11 | **The unknown-`AdminAction` tolerance fix (F3, Low) is deferred.** This release adds no `AdminAction` value, so nothing triggers it. It ships with, and one BFF release before, the later flag-history change (PRD §6). | Optional per the owner; keeps this PR to the feature. |
| FF12 | **First access: no guard, one log level (F9).** `createClient` logs a `ForbiddenError` from `CreatePasswordSetupToken` (the flag is on for this trainer, API D16) at INFO "Client created; no setup link: first-access e-mail is on for this trainer", and any other failure at WARN as today. `reissueSetupToken`'s 403 is unchanged. The seed description (API §1.2) tells the admin about both. | F9, R29, owner decision (no per-flag guards). VRT-10/11 replace these routes later. |
| FF13 | **`ops:issue-setup-tokens` gets a note, not a guard (F10).** Header comment of `scripts/issue-setup-tokens.ts` and the README "Operations" entry: run it only while `FIRST_ACCESS_EMAIL_ENABLED` is off for everyone and has no user settings; with a trainer ON, each printed link rotates that client's token and voids the e-mailed one. | F10; owner decision. |
| FF14 | **The cut-over changes nothing for trainers.** Since vertice-bff#74 (deployed 2026-11-20) production runs with `AI_ASSISTANT_ENABLED=true`. The API seeds the `AI_ASSISTANT_ENABLED` flag **on** for everyone with no user settings (vertice-api#104, which corrects PRD R28 and the API spec), and `FIRST_ACCESS_EMAIL_ENABLED` off. So when this release replaces the env switch with the flag, every trainer keeps the assistant, and no admin step is needed after the deploy. | R27, R28 as corrected by vertice-api#104 ("both flags start as they are today"); assessment §7 assumed `false`, which is no longer the deployed value. |
| FF15 | **R21 budget, BFF share: nothing cached.** About 60 s end to end: API 30 s cache (API D8), BFF none, web status query `staleTime` 30 s + `refetchInterval` 30 s on visible tabs, retry once (web W11). The 20 s deadline bounds a hang and adds no staleness. | R21, E10; API D9. |

## 1. Proto sync

1. vertice-api's feature-flags PR (vertice-api#103's implementation) is merged **and deployed**.
2. `protos/.api-ref` ← that merge commit's full SHA; `npm run sync:protos` (locally
   `GITHUB_TOKEN=$(gh auth token)` or `-- --local`). The pin today is `863ef3b`. Review the whole
   diff: it may bring unrelated upstream drift as well as the two new files.
3. `PROTO_FILES` (`src/grpc/loadProto.ts`) gains `vertice/featureflag/v1/feature_flag.proto` and
   `vertice/admin/v1/admin_feature_flags.proto`.
4. `src/grpc/clients.ts` gains:
   - `featureFlagClient = new grpcProto.vertice.featureflag.v1.FeatureFlagService(...)`, used only
     by `modules/feature-flags/service.ts`, always with the caller's token;
   - `adminFeatureFlagClient = new grpcProto.vertice.admin.v1.AdminFeatureFlagService(...)`, used
     only by `modules/admin/service.ts`, always with the caller's admin token.

Messages used, as the API spec defines them (camelCase after `keepCase: false`):
`EvaluateFeatureFlagRequest {key}` → `{enabled}`; `FeatureFlag {key, description, enabled, users}`;
`FeatureFlagUserSetting {userId (string, FF9), enabled}`; `ListFeatureFlagsResponse {flags}`; the
three writes' `{flag}`. `defaults: true`, so an absent `enabled` reads `false` (the safe side, API §3.2).

## 2. Endpoints

All paths under `/api`. Every route gets a `routeDoc` (`roles` = its hook), a response schema in
`openapi/responses.ts` with the compile-time check against the service type, and a
`route-authorization.test.ts` entry.

### 2.1 Shapes

```ts
// openapi/responses.ts → adminFeatureFlagSchema, adminFeatureFlagListSchema
interface AdminFeatureFlag {
  key: string          // ^[A-Z][A-Z0-9_]*$, the flag's name on the page (API D4)
  description: string  // pt-BR, developer-written; render as text
  enabled: boolean     // the everyone state
  users: { userId: number; enabled: boolean }[]  // ordered by userId; users.length is R3's count
}
interface AdminFeatureFlagList { flags: AdminFeatureFlag[] }  // ordered by key, unpaginated
```

Built field by field from the upstream message, never spread. The OpenAPI component names are
pinned, since the web aliases them: `adminFeatureFlagSchema = named('AdminFeatureFlag', …)` and
`adminFeatureFlagListSchema = named('AdminFeatureFlagList', …)`. The user setting stays inline
(no component of its own).

### 2.2 Admin routes (`src/modules/admin/routes.ts`, ADMIN by the plugin hooks)

| Route | Params / body (`admin/schemas.ts`) | Upstream | 200 | Errors |
|---|---|---|---|---|
| `GET /admin/feature-flags` | none | `ListFeatureFlags {}` | `AdminFeatureFlagList` | 401, 403 |
| `PUT /admin/feature-flags/:key/everyone` | `featureFlagKeySchema`; body `featureFlagStateSchema = z.object({ enabled: z.boolean() }).strict()` | `SetFeatureFlagEveryone {key, enabled}` | `AdminFeatureFlag` | 400, 401, 403, 404 |
| `PUT /admin/feature-flags/:key/users/:userId` | key, `featureFlagUserIdSchema`; same body | `SetFeatureFlagUser {key, userId, enabled}` | `AdminFeatureFlag` | 400, 401, 403, 404 |
| `DELETE /admin/feature-flags/:key/users/:userId` | key, user id; no body | `RemoveFeatureFlagUser {key, userId}` | `AdminFeatureFlag` (idempotent: no setting → 200, flag unchanged) | 400, 401, 403, 404 |

- `featureFlagKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64)`.
- `featureFlagUserIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number).refine(Number.isSafeInteger)`.
  The REST value is a number; it goes upstream as that number (int64 accepts it).
- `.strict()` on the body: an unknown field (a `reason`, a `toggle`) is a 400, so a client can't
  believe it sent something the BFF dropped. `"true"` (a string) is a 400.
- Handler order: parse params → parse body → call → audit line (FF10) → return.
- Route descriptions say: absolute state, last save wins (R25), no history, a change reaches the
  product within about a minute (R21), a user number is not checked against any account (R17).

### 2.3 Assistant routes (`src/modules/assistant/routes.ts`, TRAINER)

**`GET /assistant/status`** → `{ enabled }` (shape unchanged):
`enabled = settings.client !== undefined && await settings.isEnabledFor(req.user!, req.log)`.
Never a 5xx for flag reasons. The description drops "No upstream call": one `EvaluateFeatureFlag`
with the trainer's token, 20 s deadline, any failure answers `false`; per trainer; may lag a change
by up to the API's 30 s.

**`POST /assistant/workout-chat`**, first lines of the handler:

```ts
const on = await settings.isEnabledFor(req.user!, req.log)
if (!on) throw new HttpError(503, 'The AI assistant is switched off', 'AI_UNAVAILABLE')
const client = settings.client
if (!client) {
  req.log.warn({ assistant: 'unavailable', reason: 'no_client', userId: req.user!.id }, 'AI flag on but VERTICE_AI_URL is not set')
  throw new HttpError(503, 'The AI assistant is unavailable', 'AI_UNAVAILABLE')
}
// then body parse, buildChatContext, … as today
```

Both 503s have the same code, so the web shows the same thing. The rest of the route is unchanged.

### 2.4 `src/modules/feature-flags/service.ts` (new, no routes)

```ts
export const AI_ASSISTANT_FLAG = 'AI_ASSISTANT_ENABLED'
export const FLAG_EVALUATION_DEADLINE_MS = 20_000

/** Whether `key` is on for the caller (their token). Never rejects: any failure is off (R22). */
export async function isFlagOn(key: string, log: FastifyBaseLogger): Promise<boolean> {
  try {
    const res = await grpcCall<{ key: string }, { enabled: boolean }>(
      featureFlagClient, 'EvaluateFeatureFlag', { key }, { deadlineMs: FLAG_EVALUATION_DEADLINE_MS })
    return res.enabled === true
  } catch (err) {
    log.warn({ flag: key, outcome: 'evaluation_failed', code: codeOf(err) }, 'Feature flag evaluation failed; treating it as off')
    return false
  }
}
```

`codeOf` gives the `HttpError` code or the error's name, never its message. `grpcCall` still logs
the upstream status as it does for every call. A `MissingCallerIdentityError` (no verified token,
a bug) is off too.

## 3. Config (`src/config/env.ts`)

- Delete `AI_ASSISTANT_ENABLED`. The schema strips unknown keys, so a stale value in an env file
  boots and does nothing (the task-definition entry is removed in the same PR anyway).
- `superRefine`: `if (value.VERTICE_AI_URL) { differs-from-JWT_SECRET; outside DEV_NODE_ENVS, secretProblem(SERVICE_JWT_SECRET, PLACEHOLDER_SERVICE_JWT_SECRETS, 'when VERTICE_AI_URL is set, unless NODE_ENV is development or test') }`.
  Messages never echo a value.
- The transform's dev-secret fallback stays, comment rewritten: outside development/test a set URL
  has passed the check, and with no URL nothing signs a vertice-ai token.
- `assistantSettingsFromEnv`: `client = overrides.client ?? (env.VERTICE_AI_URL ? httpAiClient(env.VERTICE_AI_URL) : undefined)`;
  `isEnabledFor = overrides.isEnabledFor ?? ((_user, log) => isFlagOn(AI_ASSISTANT_FLAG, log))`.
- FF3's boot warning is logged from `buildApp` (it has the logger), outside `DEV_NODE_ENVS` only.

## 4. Errors the web will see

No new error code. Admin page: 400 `VALIDATION_ERROR` (malformed key, user number or body), 401
`UNAUTHENTICATED` (session over), 403 `FORBIDDEN`, 404 `NOT_FOUND` (flag removed by a migration,
E9: refetch the list or show "Flag não encontrada"), 502/503 upstream. Assistant: status is always
200; chat is 503 `AI_UNAVAILABLE` when off, unreadable or without vertice-ai, then the existing
stream errors.

## 5. What the web can rely on

- The four routes and shapes of §2, under `/api/bff/admin/feature-flags/...` through its proxy
  (already allowed: `/admin/**`). Writes take the dialog's captured target state (W4) and each
  returns the saved flag (the web awaits a refetch of its one list key, web D4).
- User numbers are positive safe integers in and out; a number the BFF refuses is 400, so the
  web's own schema (W6) should match FF8.
- `GET /assistant/status` keeps its shape, varies per trainer, and changes within about a minute
  given the web's W11 timings. The query key needs no user: sign-out clears the cache.

## 6. Merge and deploy order

Default order, no deviation.

1. **vertice-api** (feature-flags spec): merged **and deployed**. Today's BFF calls nothing new.
2. **vertice-bff** (this spec), one release:
   - before merging, the pre-release check below;
   - the proto pin, the sync, the two clients, the assistant evaluation, `AI_ASSISTANT_ENABLED`
     removed from code, `.aws/task-definition.json`, `.env.example` and README, the four admin
     routes, docs regenerated.

   Not before step 1: `sync:protos --check` fails on a pin without the files, and against an older
   API the admin routes are 502 and the evaluation `UNIMPLEMENTED` (off).
3. **vertice-web-react**: the Feature flags page and the status-query timings, after its
   `.bff-ref` bump to step 2's merge.

**Pre-release check (FF2), before step 2 merges.** The new checks run on
`vertice/prod/ai-service-jwt-secret` at boot. The BFF already booted in production with
`AI_ASSISTANT_ENABLED=true` (vertice-bff#74), so the old guard ran on that secret and it most
likely passes. Check it anyway: at least 32 bytes, no leading or trailing whitespace, not in
`PLACEHOLDER_SERVICE_JWT_SECRETS`, not equal to `vertice/prod/jwt-secret`. Compare lengths and
hashes, never print the values. If it fails, rotate it in both the BFF and vertice-ai before the
release, since the two must stay equal. Otherwise the new task fails to boot and the ECS circuit
breaker rolls it back.

**No release step (FF14).** The seed matches today's production state (the assistant on for
everyone), so trainers see no change at the switch-over and no admin action is needed.

**After deploy:**
- `GET /api/admin/feature-flags` as the admin lists both flags: `AI_ASSISTANT_ENABLED` on, `FIRST_ACCESS_EMAIL_ENABLED` off, no user settings.
- `GET /api/assistant/status` as a trainer answers `{ enabled: true }`, as before the release.
- A per-user OFF on a test trainer turns the assistant off for only that trainer within about a
  minute. Remove the setting afterwards.
- The BFF log has one `admin.flag.*` line per write and no `evaluation_failed` lines in normal
  operation.

**Rollback**, in reverse order:
- **Web:** the page goes away. Nothing else changes.
- **BFF:** the previous task definition restores `AI_ASSISTANT_ENABLED=true`, which matches the
  seed. Only flag changes made since the release (for example a trainer set to OFF) stop
  applying, since the old BFF reads the env switch, not the flag.
- **API:** the evaluation answers `UNIMPLEMENTED`, so the assistant is off (FF4). The admin routes
  answer 502. This turns the assistant off for every trainer. Roll the BFF back first (it restores
  `AI_ASSISTANT_ENABLED=true`, by reverting the step-2 PR, which restores the task-definition
  entry) unless that outage is accepted.

## 7. Code changes (checklist)

- Proto pin and sync; `PROTO_FILES`; `featureFlagClient`, `adminFeatureFlagClient` (§1).
- `src/grpc/call.ts`: `GrpcCallOptions.deadlineMs` → grpc-js call options `{ deadline }`.
- `src/modules/feature-flags/service.ts` (§2.4).
- `src/modules/assistant/routes.ts`: `AssistantSettings.isEnabledFor`, the client built from the
  URL, status and chat (§2.3), the descriptions; `src/app.ts`: FF3's boot warning.
- `src/config/env.ts` (§3); `src/ai/token.ts` comment.
- `src/modules/admin/{routes,schemas,service}.ts`: four routes, three schemas, four service
  functions and the mapper (FF9); `openapi/responses.ts`: two schemas.
- `src/modules/clients/service.ts`: FF12's log level. `scripts/issue-setup-tokens.ts`: FF13's
  header note.
- `.aws/task-definition.json`: drop `AI_ASSISTANT_ENABLED`. `.env.example`: drop it, rewrite the
  "when off" / "once the assistant is on" comments. README env table: drop row 78; `VERTICE_AI_URL`
  becomes "unset: the assistant is off for everyone; when set, `SERVICE_JWT_SECRET` is checked";
  `SERVICE_JWT_SECRET` "checked whenever `VERTICE_AI_URL` is set". README "Operations": FF13.
- `src/openapi/docs.ts:38` (Assistant tag), `docs/api-contract.md` (§Assistant at :248 and :661:
  "per trainer, the `AI_ASSISTANT_ENABLED` flag on the admin page"; the admin-panel section: the
  flag routes and FF7–FF10), `npm run openapi`.
- CLAUDE.md: the AI assistant paragraph (the flag replaces the env switch; checks keyed on the
  URL), the gRPC bridge client list, the module layout's `admin` and new `feature-flags` entries.
- `docs/specs/ai-workout-assistant/spec.md`: a one-line "superseded by feature-flags FF2/FF4" note
  at its `AI_ASSISTANT_ENABLED` row and rollout steps 3–4.
- Not here: `parseId`'s missing safe-integer check on every other route (a follow-up, §9).

## 8. Tests

**`src/test/fakeUpstream.ts`:** an in-memory flag store seeded as the API is (`AI_ASSISTANT_ENABLED` on,
`FIRST_ACCESS_EMAIL_ENABLED` off, no user settings) and a reset
helper. `EvaluateFeatureFlag`: a user token only (service subject → `PERMISSION_DENIED`), answers
the caller's setting, else the everyone state, unknown key `false`. The four admin RPCs: ADMIN only
(D6 claims as for the other admin RPCs), unknown key `NOT_FOUND`, upsert and idempotent remove, each
write returning the flag. Switches to make the evaluation fail with a given status or delay its
answer. `fakeGrpcCall` (`fakeUpstream.ts:1220`, which replaces `grpcCall` in the route tests, so
they never reach grpc-js) honours `options.deadlineMs`: a delay of at least `deadlineMs` rejects with
`mapGrpcError({ code: DEADLINE_EXCEEDED })`, a shorter one resolves with the handler's answer.

**`src/test/route-authorization.test.ts`:** one entry per admin route (401 without a token, 403 for
TRAINER and CLIENT, the broken-ADMIN-token 401s, OK for ADMIN). The assistant entries run with the
default evaluator against the fake, with `AI_ASSISTANT_ENABLED` on for everyone (the seed), so
the real RPC path and the trainer's token are exercised. The `SERVICE_TOKEN_RPCS` pin is unchanged.

**`src/modules/admin/routes.test.ts`:**
- The list maps every field. Users are ordered as upstream sent them. A `userId` past 2^53 from
  upstream is dropped with the WARN (FF9).
- Each write sends the absolute state and returns the flag. DELETE with no setting is 200.
- `enabled: "true"`, a missing `enabled` and an extra `reason` are 400 with no upstream call.
- `:key` `ai_assistant`, `1FLAG`, 65 characters and `%20` are 400 with no upstream call.
- `:userId` `0`, `-1`, `01`, `1e3`, `abc` and `9007199254740992` are 400; `9007199254740991` passes.
- Upstream `NOT_FOUND` is 404 `NOT_FOUND`.
- One audit line per successful write, with the FF10 fields. A failed write logs none.

**`src/modules/assistant/routes.test.ts`:**
- Status is `true` only with a client and the evaluator on. Two trainers get different answers.
- With no client, status is `false` and the evaluator is not called.
- The evaluation failing with `UNAVAILABLE`, `UNIMPLEMENTED` or `DEADLINE_EXCEEDED`, or the fake
  delaying past `deadlineMs` (fake timers), answers 200 `{enabled:false}` with one
  `evaluation_failed` WARN.
- The fake delaying 15 s (inside the deadline) still answers `true`.
- Chat, flag off or evaluation failing: 503 `AI_UNAVAILABLE`, with no `ListExercises` and no
  vertice-ai call. Flag on with no client: 503 plus the `no_client` WARN.
- A stream running when the evaluator flips to off completes. The next message is 503.
- `isFlagOn` sends the trainer's bearer token and passes `deadlineMs: 20_000` (asserted on the
  fake's recorded caller and options).

**`src/config/env.test.ts`** (re-keyed from `on` at :201-252):
- With `VERTICE_AI_URL` set in production, these are refused: a missing, short, padded or
  placeholder secret, and one equal to `JWT_SECRET`.
- With the URL set in test, an equal secret is still refused.
- With no URL in production, any secret boots.
- `AI_ASSISTANT_ENABLED=yes` is ignored, not an error.

**`src/grpc/call.test.ts`:**
- The stub client takes grpc-js's 4-argument form `(request, metadata, callOptions, callback)`.
  With `deadlineMs`, `callOptions.deadline ≈ Date.now() + deadlineMs`; without it, no deadline is
  set.
- One real-channel test: an in-process `grpc.Server` (bound to `127.0.0.1:0`) whose handler never
  answers, called with `deadlineMs: 50` and real timers. The call rejects as 502 `UPSTREAM_ERROR`,
  and `grpcStatus` `DEADLINE_EXCEEDED` is logged. `isFlagOn` over the same client returns `false`.
  This is the only test that exercises grpc-js's own deadline.

**`src/modules/clients/service.test.ts`:** a `ForbiddenError` from `CreatePasswordSetupToken` is
logged at INFO and `setup: null`. Any other error is logged at WARN.

**Docs:** `openapi.test.ts` stays green after `npm run openapi`.

## 9. Follow-ups (not in this change)

- F3: make `toActionEntry` total (unknown `AdminAction` → `UNKNOWN`, one WARN). Ship it one BFF
  release before the API writes a new action value (the flag-history change, PRD §6).
- `parseId`: refuse integers above 2^53 and non-digit forms (`1e3`) on every route, with its own
  test sweep.
- Mobile is untouched (PRD §6). The mobile app has no assistant.
