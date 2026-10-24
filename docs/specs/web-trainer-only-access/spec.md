# Spec (BFF): Web Access for Trainers Only

Status: Implemented
Owner: hebertpdl@gmail.com
Related: [vertice-api PRD](https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/web-trainer-only-access/prd.md),
[vertice-api assessment](https://github.com/herbertpdl/vertice-api/blob/main/docs/assessments/web-trainer-only-access/assessment.md),
[vertice-api spec](https://github.com/herbertpdl/vertice-api/blob/main/docs/specs/web-trainer-only-access/spec.md),
this repo's assessment for the same slug (F1–F8)

## 0. Scope decisions

- **`/auth/login` stays the same for every app (assessment F1, option A).** The mobile app logs
  clients in through it, and the BFF has no notion of which app is calling. A self-declared "web"
  flag would be omitted by anyone calling the BFF directly, so it would secure nothing the API
  matrix doesn't already. vertice-web-react refuses a non-TRAINER role before it creates its own
  session (R1–R7). `docs/api-contract.md` now says so.
- **`POST /auth/password/setup` answers `200 {role, email}` instead of `204` (F2, F4).** It calls
  vertice-api's new `RedeemPasswordSetupToken` and keeps only those two fields: nothing else from
  the contact view (no id, no name), and no token. The web needs the role to choose between the
  client and trainer success screens (R10, R11) and the e-mail for the app deep link (R10a). The
  e-mail is returned only after the token was used (F7). An invalid token keeps its
  `400 INVALID_SETUP_TOKEN`.
- **`RedeemPasswordSetupToken` replaces `SetPasswordWithToken` in `SERVICE_TOKEN_RPCS`** and in the
  fake upstream's `service:bff` list. Nothing calls the old RPC any more, so it is not left in the
  list (CLAUDE.md: never widen it).
- **`GET /workouts/:workoutId/session` is CLIENT-only (F3, R15).** It follows vertice-api, which
  now refuses `GetOrStartWorkoutLog` to a TRAINER. The `clientId` query parameter is gone from the
  docs. A CLIENT's `clientId` was already ignored, and still is. No app called the TRAINER branch.

## 1. Changes

- Protos synced to the vertice-api merge commit (`protos/.api-ref`, `npm run sync:protos`).
- `users/service.ts`: `redeemPasswordSetupToken(token, password) → {role, email}` (service token)
  replaces `setPasswordWithToken`.
- `auth/service.ts` `setupPassword` returns it; `auth/routes.ts` documents
  `200 PasswordSetupResult` (`openapi/responses.ts`, with the `SameShape` check).
- `grpc/call.ts` `SERVICE_TOKEN_RPCS`; `test/fakeUpstream.ts` (`RedeemPasswordSetupToken` answers
  the contact view; `API_SERVICE_SUBJECT_RPCS`).
- `workout-sessions/routes.ts`: `requireRole('CLIENT')` on the session route, the caller's own id.
- `docs/openapi.json` and the generated route reference regenerated (`npm run openapi`). The prose
  for the setup route, the session route and the shared login is updated in `docs/api-contract.md`,
  and the service-token list in CLAUDE.md.

## 2. Tests

- `auth/routes.test.ts`: a client's token returns `200 {role: 'CLIENT', email}` with no other key,
  a trainer's returns `TRAINER`, and a bad token gets the full `INVALID_SETUP_TOKEN` body.
- `route-authorization.test.ts`: the session route is `roles: ['CLIENT']`, so a TRAINER and an
  ADMIN are 403 by role with no upstream call. The CLIENT `clientId` scoping case stays.
- `validation-routes.test.ts`: the session route's `weekStartDate` parsing is exercised as a
  client.
- `grpc/call.test.ts`: the service-token list.

## 3. Merge and deploy order

1. **vertice-api** (`RedeemPasswordSetupToken`; `GetOrStartWorkoutLog` client-only), merged first.
   The proto pin in this PR is its merge commit.
2. **vertice-bff** (this change). The setup route needs the new RPC live on the target
   environment. The session route only narrows, so it could ship either way.
3. **vertice-web-react** reads the new setup response; **vertice-mobile** reads the e-mail from the
   deep link.

Rollback: web first (it would otherwise expect the 200 body), then the BFF. An old web build treats
any 2xx from setup as success, so it keeps working against this BFF.
