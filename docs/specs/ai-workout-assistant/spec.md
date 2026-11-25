# Spec (vertice-bff): AI Workout Assistant

**Status:** Accepted · **Date:** 2026-11-20 · **Owner:** hebertpdl@gmail.com
**PRD:** [vertice-web-react `docs/prds/ai-workout-assistant/prd.md`](https://github.com/herbertpdl/vertice-web-react/blob/main/docs/prds/ai-workout-assistant/prd.md) (rules `R#`, edge cases `E#`)
**Assessment:** [`docs/assessments/ai-workout-assistant/assessment.md`](https://github.com/herbertpdl/vertice-bff/blob/main/docs/assessments/ai-workout-assistant/assessment.md) (findings `F#`)
**Upstream contract:** [vertice-ai `docs/specs/ai-workout-assistant/spec.md`](https://github.com/herbertpdl/vertice-ai/blob/main/docs/specs/ai-workout-assistant/spec.md). It is the source of truth for the BFF ↔ vertice-ai call; `src/ai/contract.ts` mirrors it.
**Web:** [vertice-web-react assessment](https://github.com/herbertpdl/vertice-web-react/blob/main/docs/assessments/ai-workout-assistant/assessment.md)
**Ticket:** Notion VRT-35

One trainer-only, stateless, streamed endpoint. The web sends the conversation, the new message
and the workout on screen; the BFF adds the plan, its other workouts and the trainer's catalog,
calls vertice-ai with its own service token, and relays stages, text and a validated, enriched
proposal as server-sent events. Nothing changes in vertice-api.

## 1. Routes

| Method | Path | Roles | |
|---|---|---|---|
| GET | `/api/assistant/status` | TRAINER | `{ enabled }`: whether the web shows the AI icon. No upstream call (Q2 of the assessments: a dedicated route rather than a `GET /auth/me` field, so `Me`, which mobile also generates types from, does not change) |
| POST | `/api/assistant/workout-chat` | TRAINER | `text/event-stream` |

Both sit in `modules/assistant`, behind `app.authenticate` and `app.requireRole('TRAINER')`:
CLIENT and ADMIN get 403 by role before anything else (R1).

## 2. Request

```jsonc
{
  "trainingPlanId": 100,                 // required; the trainer's plan (403 otherwise)
  "workoutId": 200,                      // optional: absent on a workout not created yet (R2)
  "workout": {                           // the workout on screen, a proposal in review included (R12, R36)
    "exercises": [                       // 0–20
      { "key": "e1", "exerciseId": 1, "restSecondsBetweenSets": 90, "notes": "", "sets": [ /* 0–10 ExerciseSetEntry */ ] }
    ]
  },
  "history": [ { "role": "user" | "assistant", "text": "..." } ],   // 0–20 turns, 1–40,000 chars each, ≤ 40,000 in total (R56)
  "message": "..."                       // 1–2,000 UTF-16 units, not blank (R10)
}
```

- An entry is `WorkoutExerciseEntry` (`PUT /workouts/:id/exercises`) with the same bounds, plus
  `key`: the editor's opaque key, `^[A-Za-z0-9_-]{1,64}$`, unique (web F5).
- History (vertice-ai spec §3): a turn that produced a proposal is an `assistant` turn with the
  text "Proposta pronta para revisão no editor." (plus the R51 line when there was one); the
  `user` turn of a stopped, failed or retried message is not sent ("Tentar novamente" sends the
  same text as the new `message`); empty turns are never sent. The BFF forwards turns as given.
- A `name` or `dayOfWeek` on `workout` is stripped (R28); other unknown fields are stripped too.
- Order of checks, so no answer leaks more than the one before it: 401 → 403 role → 503 switched
  off → 400 body → 403/404 plan → 403 workout of another trainer → 400 workout of another of the
  trainer's plans → 413 catalog too large → 400 an on-screen `exerciseId` outside the trainer's
  catalog (a missing id and another trainer's private one get the same 400).

## 3. What the BFF reads and sends upstream

All reads use the trainer's own token (`grpcCall`), so vertice-api applies its own visibility.

| Context | Upstream RPCs | Sent as |
|---|---|---|
| Plan (R12) | `GetTrainingPlan` | `plan`: name, description, level, start and end dates. Never `clientId` (R13) |
| Workout on screen | `GetWorkout` (only with `workoutId`) | `workout`: the body's entries, plus the stored name and weekday as context |
| Other workouts (F9) | `ListWorkouts`, `ListWorkoutExercises` each, `ListExerciseSets` per exercise, 4 workouts at a time | `otherWorkouts`: name, weekday, each exercise's name, muscle groups and number of sets; the first 50 |
| Catalog (F2, option (a)) | `ListExercises`, every page (50 a page) | `catalog`: id, name, muscle groups (the first 50) |

- A plan of 7 workouts × 10 exercises is 1 + 1 + 7 + 70 calls, plus about 5 catalog pages.
  Names come from the loaded catalog, so no `GetExercise` per exercise; an exercise the trainer
  can no longer see is left out of `otherWorkouts`.
- The catalog is capped at 1,000 exercises (vertice-ai's bound). Past it the message is refused
  with 413 `AI_CATALOG_TOO_LARGE` rather than sent with a partial catalog.
- Never sent: the client's id, name or e-mail, recorded weights, logs, feedback (R13).
- Amended by [`client-anamnese/spec.md`](../client-anamnese/spec.md) §3: the trainer's anamnese of
  the plan's client (`GetClientAnamnese`, per message, parallel with the catalog) is sent as
  `anamnese`, the only client-derived text; omitted when empty or refused to a former trainer.

The call: `POST {VERTICE_AI_URL}/v1/workout-chat`, `accept: text/event-stream`, `x-request-id`
(the BFF request id), and a token from `src/ai/token.ts`.

## 4. The vertice-ai token

`signAiServiceToken(user)`: HS256 with `SERVICE_JWT_SECRET`; `iss: "vertice-bff"`,
`aud: "vertice-ai"`, `sub: "service:bff"`, `exp` 60 seconds after `iat`, `uid` (the trainer's id)
and `role` for vertice-ai's logs only. Minted per request, never cached. It is a separate signer:
`serviceToken()` and `JWT_SECRET` are never used for vertice-ai, so the service most exposed to
untrusted text never holds a vertice-api credential (F7). `verifyToken` refuses it (other secret,
other audience), and so does vertice-api.

## 5. The stream

Response headers: `content-type: text/event-stream; charset=utf-8`, `cache-control: no-store`
(the security-headers hook), `x-accel-buffering: no`. Each event is `event: <type>` and one
`data: <json>` line, then a blank line. A comment line `: keep-alive` is sent every 10 seconds;
it carries nothing and is not progress.

| `event` | `data` | |
|---|---|---|
| `stage` | `{ "stage": "analyzing" \| "choosing_exercises" \| "building_sets" \| "checking", "exercise"?: n }` | A change is being built (R18), keys in this order, later ones may be skipped. `building_sets` repeats once per exercise being written, with `exercise` its 1-based position (only there). The web shows its own label per key. Unknown keys from vertice-ai are dropped |
| `text` | `{ "delta": "...", "line"?: "left_out" \| "anamnese_conflict" }` | The next piece of the answer (R17); with `line`, one whole line: R51's (`left_out`) or the anamnese conflict (client-anamnese spec §4) |
| `proposal` | `{ "exercises": [AssistantProposalEntry] }` | At most once (R25) |
| `done` | `{}` | Success |
| `error` | `{ "code", "message" }` | Failure; `message` is English for logs |

`AssistantProposalEntry` is a `WorkoutExerciseEntry` plus `key` (`string`, a key the request
sent, or `null` when the exercise is new) and `exercise` (the catalog `Exercise`, to render the
card). The list is the whole new exercise list in order; an on-screen key missing from it means
that exercise is removed (R33). Strip `key` and `exercise` and it is a body for
`PUT /workouts/:workoutId/exercises` or the nested create (R38, R40).

Order (vertice-ai §4, as amended by client-anamnese spec §4): a question is
`text+ [anamnese_conflict] done`; a change is `stage+ proposal [left_out] [anamnese_conflict] done`;
anything can be cut short by one `error`. Exactly one `done` or `error` ends the stream, except
when the client is gone (nothing is written then).

The OpenAPI document publishes each payload under `components.schemas` (`AssistantStageEvent`,
`AssistantTextEvent`, `AssistantProposalEvent`, `AssistantDoneEvent`, `AssistantErrorEvent`)
and the stream as `AssistantStreamEvent`, a union of `{ event, data }`, under the route's
`text/event-stream` response (F8).

## 6. Proposal validation (F5; R27–R32)

The model's proposal is untrusted. It becomes `AI_INVALID_PROPOSAL` (and no `proposal` event)
when it:
- has any field outside the entry and set shapes, a `name` or `dayOfWeek` included (strict
  objects; R28);
- breaks a field bound or the 20/10 caps (R31);
- names an `exerciseId` outside the catalog sent for this message (R29);
- echoes a key that was not sent, or one key twice, or a key on a different `exerciseId` than it
  was sent with (a swap is `key: null`, so the web shows "Removido" + "Novo", R33);
- has a `null` optional field (vertice-ai leaves unset fields out);
- is a second proposal.

The reason logged names field paths, never values.

## 7. Errors

**Before the stream** (JSON `{ error: { code, message } }`): 400 `VALIDATION_ERROR`, 401, 403
`FORBIDDEN`, 404 `NOT_FOUND`, 413 `AI_CATALOG_TOO_LARGE`, 503 `AI_UNAVAILABLE` (switched off), and
the usual 502/503 when vertice-api fails.

**In the stream** (`error` event):

| Code | When |
|---|---|
| `AI_UNAVAILABLE` | vertice-ai unreachable, 404 (its flag off), 401 (secret mismatch, logged as an error), 5xx, or its `UPSTREAM_UNAVAILABLE` |
| `AI_TIMEOUT` | No `stage`, `text` or `proposal` for 60 seconds (R21). Heartbeats, either side's, don't count |
| `AI_INVALID_PROPOSAL` | §6, or vertice-ai's `INVALID_PROPOSAL` (R32) |
| `AI_ERROR` | vertice-ai's 400, `UPSTREAM_BAD_RESPONSE`, `INTERNAL_ERROR` or an unknown code; a stream that ends without `done`; an event that is not JSON |
| `AI_SUPERSEDED` | A newer message from the same trainer took over (F10) |

## 8. Abort and supersede (F6, F10; R14, R16, R50)

- The response's `close` before it finished (the web's "Parar", leaving, a closed tab) aborts
  the outbound `fetch`; vertice-ai then cancels the model call. A client gone while the context
  is still being read never reaches vertice-ai.
- Every end the BFF decides itself (`AI_TIMEOUT`, `AI_INVALID_PROPOSAL`, `AI_ERROR`, `done`) also
  closes the upstream request.
- At most one running message per trainer, per BFF task (an in-memory map, so it bounds each task,
  not the service): a new message aborts the running one, which ends with `AI_SUPERSEDED`. A slot
  is released only by the handle that holds it.

## 9. Switch and configuration (F7)

| Variable | Default | |
|---|---|---|
| `AI_ASSISTANT_ENABLED` | `false` | **Superseded by [feature-flags](../feature-flags/spec.md) FF2/FF4:** the env switch is gone; the assistant is the per-trainer `AI_ASSISTANT_ENABLED` flag, and the two below are checked whenever `VERTICE_AI_URL` is set. Off: the chat answers 503 `AI_UNAVAILABLE`, status says `enabled: false`, nothing is called, and the two below are not needed. Stays off until PRD §7's launch condition (data inventory and privacy text name Anthropic) is met |
| `VERTICE_AI_URL` | none | Required when on. Absolute http(s), no query, fragment or credentials. Deployed: `http://vertice-ai:8000` (ECS Service Connect) |
| `SERVICE_JWT_SECRET` | dev: vertice-ai's dev default | Required when on outside development/test, with `JWT_SECRET`'s guards (≥ 32 bytes, no padding, no placeholder) and never equal to `JWT_SECRET`. Deployed from Secrets Manager `vertice/prod/ai-service-jwt-secret` |

Logs: one `Assistant message finished` line per message with the trainer id, outcome,
duration, counts and vertice-ai's model, prompt version and token usage. Never the message,
history, workout, catalog or proposal.

## 10. Infrastructure notes (F3)

- BFF → vertice-ai: Service Connect, 300-second timeouts.
- Web → BFF: the Service Connect hop still has a 15-second per-request timeout, which would cut
  any stream longer than that whatever the heartbeats do. Raising it is the owner's call
  (prepared separately) and must happen before the flag goes on.
- CloudFront and the ALB are not on the web → BFF path (the web calls the BFF server-side).

## 11. Tests

`src/ai/sse.test.ts`, `src/ai/token.test.ts`, `src/config/env.test.ts` (flag, URL, secret
guards), `modules/assistant/{schemas,proposal,session,routes}.test.ts` (the last over real HTTP
with a stub vertice-ai: headers, token claims, the body sent and what it never holds, client
abort, supersede, upstream 404/400/unreachable, timeout despite keep-alives, flag off), and
two rows in `src/test/route-authorization.test.ts`.

## 12. Merge and deploy order

1. vertice-ai: this contract (#37), the endpoint (#38), the deploy (#34). Not needed for this
   BFF merge: with `AI_ASSISTANT_ENABLED=false` the BFF never calls vertice-ai and boots without it.
2. vertice-bff (this), flag off.
3. vertice-web-react (#36), which hides the icon while `GET /api/assistant/status` says off.
   (Steps 3–4 are superseded by [feature-flags](../feature-flags/spec.md) FF2/FF4: the switch is
   now the per-trainer `AI_ASSISTANT_ENABLED` flag on the admin page.)
4. The owner turns `AI_ASSISTANT_ENABLED` on after PRD §7's condition and the web → BFF timeout.

Rollback: switch the BFF flag off first (the route answers 503, nothing is stored), then
vertice-ai's.
