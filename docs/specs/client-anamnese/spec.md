# Spec (BFF): Client Anamnese

Status: Draft
Owner: hebertpdl@gmail.com
Related: [vertice-api PRD](https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/client-anamnese/prd.md)
(Approved; R1–R42, E1–E25, not restated here; the AI assistant's rules are `AI-R#`),
[vertice-api spec](https://github.com/herbertpdl/vertice-api/blob/main/docs/specs/client-anamnese/spec.md)
(the gRPC contract this bridges; it wins over this document on any RPC detail),
[vertice-ai spec](https://github.com/herbertpdl/vertice-ai/blob/main/docs/specs/client-anamnese/spec.md)
(the `anamnese` request field and the `line` marker on `text` events; it wins on the wire shape),
this repo's [assessment](../../assessments/client-anamnese/assessment.md) (F1–F13, Q1–Q6, resolved
in §0). Touched: `docs/specs/ai-workout-assistant/spec.md` (§3 "Never sent" and §5's stream
order now point here). Ticket: VRT-59.

The BFF owns no anamnese data and decides nothing about it: vertice-api stores it and says what
"blank" is, vertice-ai decides how it is used. What the BFF owns is the REST shape, the
role/ownership checks before the upstream calls, the one read per chat message, what a refused
read means there, and how the stream's new `line` marker is relayed.

## 0. Scope decisions

| # | Decision | Why |
|---|---|---|
| A1 | **Bridge vertice-api's `ClientAnamneseService` (F1, Blocker).** `protos/.api-ref` ← `4f9bce152607a313fe7643cc6d79d3c28aa05813` (vertice-api#109's merge), `npm run sync:protos`. The service has its own file, `vertice/trainerclient/v1/client_anamnese.proto`: it joins `PROTO_FILES`, and `clients.ts` gains `clientAnamneseClient` (`vertice.trainerclient.v1.ClientAnamneseService`), used only by `clients/service.ts`, always with the trainer's own token. `UserResponse.has_anamnese = 15` arrives in `user.proto`. | F1; API spec. |
| A2 | **`GET` and `PUT /api/clients/:id/anamnese` on the `clients` module (F7).** TRAINER by the plugin hooks; `parseId` → `assertIsTrainersClient` → the RPC with `trainer_id` = the caller. `PUT` replaces (R13) and a blank text clears (R19), so there is no `DELETE` and no `PATCH`. `PUT` answers 200 with the saved state (Q5), so the tab shows "Atualizada em" (R14) without a second read. | F7, Q5; R1, R3, R4, R7, R13, R14, R19, R20. |
| A3 | **The body: `{ text }`, `.strict()`, `text: utf16String(ANAMNESE_MAX_LENGTH)` (F8).** `ANAMNESE_MAX_LENGTH = 5_000` is named once (`clients/schemas.ts`), mirroring the API's bound in UTF-16 units. Required, empty allowed, never trimmed. The BFF has **no** blank rule: it sends the text as written and returns what vertice-api answers (the API alone decides blank: JavaScript `trim()` semantics, U+00A0 included). | F8; R10, R11, R18, R19, E2, E4. |
| A4 | **Ownership check, then the body (repo order).** As `PATCH /clients/:id` does: a foreign/former client is 403 whatever the body, a bad body for one of your clients is 400. Either way no write RPC is reached (`IsTrainersClient` is the one read before a 400). | CLAUDE.md "schemas.ts": 403 before 400, no body-shape oracle on someone else's client. |
| A5 | **`hasAnamnese` on `GET /clients` (F9).** Read from `ListClientsForTrainer`'s `has_anamnese` exactly as `suspended` is: a set built from the raw roster answer. `toUser` never carries it (the field is `false` on every other RPC). | F9; R21, E5. |
| A6 | **`GET /api/assistant/anamnese-notice?trainingPlanId=` (F5, option C).** TRAINER; `GetTrainingPlan` → `assertOwnsPlan` → `ListClientsForTrainer`. `state`: `present` (on the roster, `has_anamnese`), `missing` (on the roster, none), `unavailable` (not on the roster: a former client, owner decision Q1) with `client: null`. Never reads the text. Not flag-gated (Q3): it carries no AI data and the web calls it only inside the panel. | F5, Q1, Q3; R25, R26, R28, E11, E12. |
| A7 | **Chat: one fresh read per message (F4).** `buildChatContext` adds `GetClientAnamnese {trainer_id: caller, client_id: plan.clientId}` to the existing `Promise.all` with the catalog and the plan's workouts, with the trainer's token (never `asService`), no cache of any kind (R29). | F4; R22, R29, E13, E14. |
| A8 | **Refused = omit; anything else fails (F4, Q1, Q2).** Only a `ForbiddenError` from that read (upstream PERMISSION_DENIED: a former trainer, who still passes `assertOwnsPlan`'s plan-tree check, R7) means "no anamnese": the field is omitted and the message goes on. Any other failure (503 UNAVAILABLE, 502, a deadline) rejects `buildChatContext`, so the message fails before the stream with the normal mapped status and vertice-ai is never called. An empty text is also omitted (the API's empty state). | F4, Q2: sending without it would break R22 while the panel says the AI uses it; refusing would break the former trainer's assistant. |
| A9 | **The text goes only into the vertice-ai body.** `AiWorkoutChatRequest.anamnese?: string` (`ai/contract.ts`), `AI_MAX_ANAMNESE = 5_000` code points beside `AI_MAX_CATALOG`. 5,000 UTF-16 units are never more than 5,000 code points, so anything the API stored passes (F2). Never in a header, a log field, an error message or the request id. The per-message log line gains `anamnese: "sent" \| "none" \| "refused"`, an enum, never the text, a prefix or a length. | F2, F4, F11; R24, R40, E17. |
| A10 | **Relay and validate `line` on `text` events (F6).** See §4. Plain answer text has no `line`; a valid line event is relayed as `{ delta, line }`. Anything about `line` the BFF can't vouch for drops the marker and keeps the `delta` (never lose text). | F6, Q4; R30, R31, E15, E25; vertice-ai spec §4. |
| A11 | **One audit line per save (F11, Q6).** After `SaveClientAnamnese` succeeds: INFO `{ audit: "client.anamnese.save", actorId, clientId, outcome: "saved" \| "cleared" }` (`cleared` when the answer's text is empty). No line for reads, never the text. vertice-api logs its own; both are kept (the BFF one carries the request id). | F11, Q6. |
| A12 | **Fake upstream and write detection (F13).** `isWriteRpc` gains `Save`; the fake gains both RPCs (active pair only, PERMISSION_DENIED otherwise with the API's message, INVALID_ARGUMENT over 5,000 units, blank clears) and `has_anamnese` on its roster. | F13. |
| A13 | **One PR.** vertice-api and vertice-ai are both merged and deployed, so the routes, the chat read and the `line` relay ship together; the split the assessment offered (F3) isn't needed. | F3. |

Not decided here: export and deletion pass through unchanged (`GET /auth/me/export`, `DELETE /auth/me`;
F12; R35–R38). R39 is `GET /assistant/status`, unchanged. The prompt and the conflict line's
generation are vertice-ai's; the UI is vertice-web-react's.

## 1. Proto sync

1. `protos/.api-ref` ← `4f9bce152607a313fe7643cc6d79d3c28aa05813`; `npm run sync:protos`
   (locally `GITHUB_TOKEN=$(gh auth token)`). Diff: one new file, `client_anamnese.proto`; two
   comment/field additions (`user.proto`'s `has_anamnese = 15`, `trainer_client.proto`'s roster
   comment). No other drift.
2. `PROTO_FILES` gains `vertice/trainerclient/v1/client_anamnese.proto`.
3. `clients.ts` gains `clientAnamneseClient`.

Messages (camelCase after `keepCase: false`, `longs: String`, `defaults: true`):
`GetClientAnamneseRequest {trainerId, clientId}` → `{text, updatedAt}`;
`SaveClientAnamneseRequest {trainerId, clientId, text}` → `{text, updatedAt}`. The empty state is
both empty strings, never NOT_FOUND. `updatedAt` is an ISO-8601 instant with `Z`.

Upstream errors: PERMISSION_DENIED (non-trainer caller, another `trainer_id`, a missing, foreign,
former or non-CLIENT client: "You do not have access to client <id>") → 403 `FORBIDDEN` with the
fixed message; INVALID_ARGUMENT (over 5,000 UTF-16 units) → 400 `VALIDATION_ERROR` relaying the
API's `field: message` text (it names the field, never the value).

## 2. Endpoints

All paths under `/api`. Each has a `routeDoc`, a response schema in `openapi/responses.ts` with
the compile-time check, and a `route-authorization.test.ts` entry.

### 2.1 Shapes

```ts
// clients/service.ts → openapi clientAnamneseSchema ('ClientAnamnese')
interface ClientAnamnese {
  text: string             // as stored, untrimmed; "" when there is none
  updatedAt: string | null // instant of the last save; null when text is ""
}

// assistant/service.ts → openapi anamneseNoticeSchema ('AnamneseNotice')
interface AnamneseNotice {
  state: 'present' | 'missing' | 'unavailable'
  client: { id: number; name: string } | null // null only when unavailable
}

// ClientSummary (GET /clients) gains:
hasAnamnese: boolean // you wrote an anamnese for this client (R21); independent of `suspended`
```

### 2.2 `clients` routes (TRAINER by the plugin hooks)

| Route | Flow | Answers |
|---|---|---|
| `GET /clients/:id/anamnese` | `parseId` → `assertIsTrainersClient` → `GetClientAnamnese {trainerId: caller, clientId}` | 200 `ClientAnamnese`; empty state `{ "text": "", "updatedAt": null }` (E1), never 404. 403 another trainer's, a former or a missing client (E7/E8: CLIENT and ADMIN are 403 by role). |
| `PUT /clients/:id/anamnese` `{ "text": string }` | `parseId` → `assertIsTrainersClient` → body (`.strict()`, A3) → `SaveClientAnamnese` → audit line (A11) | 200 `ClientAnamnese`, the saved state; a blank text clears it and answers the empty state (R19, E5). 400 `VALIDATION_ERROR` (missing/non-string `text`, an extra key, over 5,000 UTF-16 units: a non-BMP character counts two). 403 as above. |

`updatedAt` maps `''` → `null`. Last write wins (R20): no version or `If-Match`.

### 2.3 `assistant` route (TRAINER by the plugin hooks)

`GET /assistant/anamnese-notice?trainingPlanId=<id>` (query `.strict()`, `trainingPlanId`
required, a positive integer):
1. `GetTrainingPlan` → `assertOwnsPlan(user, plan)` (403 another trainer's plan, including the
   trainer's own client's plan written by another trainer; 404 a missing plan).
2. `ListClientsForTrainer {trainerId: caller}`; find `plan.clientId`.
3. Not there → `{ "state": "unavailable", "client": null }` (the former trainer, Q1: the web shows
   no strip and no link). There → `{ "state": "present" | "missing", "client": { "id", "name" } }`
   from `has_anamnese`.

Two gRPC calls, no text read. Not gated on `AI_ASSISTANT_ENABLED` (A6). The notice is read when the
panel opens; the message always reads the anamnese fresh (A7), so a save in another tab is in the
next message even if the notice is stale (F10; the web refetches on focus).

### 2.4 `POST /assistant/workout-chat` (changed)

`buildChatContext`:

```
plan = GetTrainingPlan; assertOwnsPlan; [GetWorkout]
[catalog, planWorkouts, anamnese] = Promise.all([loadCatalog(), listWorkouts(plan.id), readAnamnese(plan.clientId)])
```

`readAnamnese` returns `{ status: 'sent', text } | { status: 'none' } | { status: 'refused' }`:
`ForbiddenError` → `refused`; empty text → `none`; any other rejection propagates (A8). The request
gains `anamnese: text` only on `sent`. `ChatContext` gains `anamnese: 'sent' | 'none' | 'refused'`,
logged on the "Assistant message finished" line (A9).

Before-stream errors gain one case: the anamnese read fails for a reason other than a refusal → the
mapped status (503 `UPSTREAM_UNAVAILABLE`, 502 …), with nothing sent to vertice-ai.

## 3. What reaches vertice-ai (amends the AI spec §3)

The table gains one row:

| Context | Upstream RPC | Sent as |
|---|---|---|
| Anamnese (R22, R24) | `GetClientAnamnese` (per message, parallel with the catalog) | `anamnese`: the text as stored, only when non-empty and the read wasn't refused |

"Never sent" becomes: the client's id, name or e-mail, recorded weights, logs, feedback (R13);
the anamnese is the **only** client-derived text in the body, and it goes nowhere else (no header,
no log).

## 4. The stream's `line` marker (amends the AI spec §5)

vertice-ai's `text` event is `{ delta, line? }`, `line` absent on answer text,
`"left_out"` (AI-R51's line) or `"anamnese_conflict"` (R30's line). The web-facing `text` event is
the same shape:

| `data` | Meaning |
|---|---|
| `{ "delta": "..." }` | Answer text: append to the answer (unchanged) |
| `{ "delta": "...", "line": "left_out" }` | AI-R51's line, one complete event: its own line |
| `{ "delta": "...", "line": "anamnese_conflict" }` | R30/R31's conflict line, one complete event: its own line (with the warning style) |

Order (vertice-ai's grammar): question `text+ [anamnese_conflict] done`; change
`stage+ (proposal [left_out] [anamnese_conflict] done | error)`.

The BFF relays `line` only when it can vouch for it; otherwise it relays the `delta` without
`line` (the web then appends it to the answer: degraded, never lost):
- `line` is not a string, or is an unknown value → dropped (WARN `unknown_line`, the value cut to 40
  characters);
- a second event with the same `line` value → dropped marker (WARN `repeated_line`);
- a `left_out` after an `anamnese_conflict` (out of order) → dropped marker (WARN `line_order`);
- a line event whose `delta` is blank, has a line break, or is over 300 code points → dropped
  marker (WARN `line_shape`).

A `line` event with an empty `delta` is not relayed (as empty deltas aren't today). Answer text is
not checked against the grammar beyond this (the BFF stays as lenient as today: a proposal plus an
unmarked `text` still relays). An older web ignores `line` and shows the lines appended; the web
ships right after the BFF.

The OpenAPI `AssistantTextEvent` gains `line?: "left_out" | "anamnese_conflict"`.

## 5. Errors the web will see

No new codes. `GET`/`PUT /clients/:id/anamnese`: 400 `VALIDATION_ERROR`, 401, 403 `FORBIDDEN`,
503/502 as everywhere. The notice: 400 (bad query), 403, 404. The chat: one more before-stream
upstream failure (§2.4).

## 6. What the web can rely on

- `GET /clients/:id/anamnese` never 404s for one of your clients; `{ text: "", updatedAt: null }`
  is "none".
- `PUT` answers the stored state: render it, don't re-read. A blank text clears; the BFF doesn't
  trim.
- `GET /clients`' `hasAnamnese` is the "Sem anamnese" badge source.
- The notice's `unavailable` means "show nothing" (no strip, no link); `client` is non-null exactly
  when the state is `present` or `missing`; `client.id` is the R28 link target.
- A `text` event with `line` is a whole line, rendered on its own; at most one per value; `left_out`
  before `anamnese_conflict`.

## 7. Merge and deploy order

1. **vertice-api** (vertice-api#109, merged at `4f9bce1`, deployed): the RPCs and `has_anamnese`.
   Without it the routes are UNIMPLEMENTED (502) and every roster row reads "Sem anamnese".
2. **vertice-web-react privacy text** (VRT-57, R33) merged and deployed: this BFF deploy is the
   launch, since `AI_ASSISTANT_ENABLED` is already on and the first message with an anamnese sends
   health data to Anthropic (F3).
3. **vertice-ai** (vertice-ai#14, merged at `a335cff`, deployed): accepts `anamnese` (its request
   model forbids unknown keys, F2) and marks `line`.
4. **vertice-bff** (this PR): merging deploys.
5. **vertice-web-react tab, badge and panel**, pinning this PR's merge SHA in `.bff-ref`.

Rollback in reverse. Reverting the BFF alone stops sending the anamnese and hides the routes; stored
data is untouched, and an old BFF drops `line` (the web falls back to appended text).

## 8. Code changes (checklist)

- `protos/**`, `.api-ref`; `grpc/loadProto.ts`; `grpc/clients.ts` (`clientAnamneseClient`).
- `clients/schemas.ts` (`ANAMNESE_MAX_LENGTH`, `clientAnamneseSaveSchema`), `clients/service.ts`
  (`ClientAnamnese`, `getClientAnamnese`, `saveClientAnamnese`, `ClientSummary.hasAnamnese`),
  `clients/routes.ts` (two routes, the audit line).
- `ai/contract.ts` (`anamnese?`, `AI_MAX_ANAMNESE`, `line` in `aiTextEventSchema`, `ASSISTANT_LINES`).
- `assistant/service.ts` (the read, `ChatContext.anamnese`, `getAnamneseNotice`),
  `assistant/routes.ts` (the notice route), `assistant/schemas.ts` (its query),
  `assistant/session.ts` (`line` relay and validation, log field).
- `openapi/responses.ts` (`ClientAnamnese`, `AnamneseNotice`, `hasAnamnese`, `line`), then
  `npm run openapi`.
- `test/fakeUpstream.ts` (handlers, `has_anamnese`, `Save` in `isWriteRpc`, a failure switch).
- Docs: `docs/api-contract.md` prose (the three routes, `hasAnamnese`, the stream's `text` row and
  order, "What reaches vertice-ai"), the AI spec §3/§5 pointers, CLAUDE.md (client list, AI
  paragraph, module layout).

## 9. Tests

- `clients/schemas.test.ts`: 0, 5,000 and 5,001 units; 2,500 non-BMP characters pass, one more unit
  fails; whitespace-only and padded text kept as written; missing `text`, non-string and an extra key
  refused.
- `clients/service.test.ts`: `hasAnamnese` true/false independent of `suspended`; `GET` maps the empty
  state to `updatedAt: null`; `PUT` returns what upstream answers.
- `route-authorization.test.ts`: one entry per new route (401, CLIENT/ADMIN 403 by role, ok for
  trainer A on client A); `GET`/`PUT` on client B are 403 with no write RPC; `PUT` with an oversized
  body is 400 with no write RPC; the notice for plan B and `planBForClientA` 403;
  `isWriteRpc('SaveClientAnamnese')`.
- `clients/routes.test.ts` (or the assistant routes suite): save, read, clear round trip; the audit
  line has ids and outcome, no text.
- `assistant/routes.test.ts`: the body carries `anamnese` when there is one and omits it when empty;
  `planAForFormerClientB` streams normally with no field and logs `refused`; an UNAVAILABLE read fails
  before the stream (vertice-ai never called); two messages around a save carry the old then the new
  text; the R13 test: the anamnese is the only client-derived text and no log line contains it; the
  notice answers `present`, `missing`, `unavailable`.
- `assistant/session.test.ts`: `left_out` then `anamnese_conflict` relayed in order; an unknown or
  non-string `line` keeps `delta`; a repeat, an out-of-order `left_out` and a line over 300 code points
  or with a line break lose the marker.
