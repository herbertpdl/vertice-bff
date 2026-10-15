# Data-subject rights (BFF)

Related: vertice-api [`docs/specs/data-subject-rights/spec.md`](https://github.com/herbertpdl/vertice-api/blob/main/docs/specs/data-subject-rights/spec.md)
(PRs #67, #68, #69); Vertice health audit 2026-10-09, plan item P1-05 step 2 (COMP-BFF-001,
PRIV-BFF-003). Request/response shapes are in [`docs/api-contract.md`](../../api-contract.md).

## Endpoints → upstream RPCs

| Endpoint | Auth | Upstream | Notes |
|---|---|---|---|
| `GET /auth/me` | any role | `GetUser` (self view) | `Me`, CPF masked (new), no reveal. |
| `PATCH /auth/me` | any role | `GetUser` (self) → `UpdateUser` | Omitted fields keep the stored value; stored role always sent. |
| `DELETE /auth/me` `{password}` | any role, rate-limited | `GetUser` → `VerifyCredentials` → `DeleteAccount` | 204. Wrong password → 400 `INVALID_CURRENT_PASSWORD`; trainer with active clients → 409 `ACTIVE_CLIENTS`. |
| `GET /auth/me/export` | any role, 3/h per user | `ExportUserData` | JSON attachment `vertice-dados-<date>.json`; `RESOURCE_EXHAUSTED` → 413 `TOO_LARGE`. |
| `DELETE /clients/:id` | TRAINER, own client | `IsTrainersClient` → `EndTrainerClientRelationship` | Was `DeleteUser`. Ends the relationship, never the account. |

Every `/auth/me` route takes the user from the token and reads no id from the request; vertice-api's
`DeleteAccount` and `ExportUserData` have no id field at all. ADMIN is admitted, as on
`/auth/password` (it is the caller's own account).

## Decisions

- **The CPF in `Me` is masked, with no own-reveal.** The profile screen needs to show that a CPF is
  on file; correcting it (LGPD art. 18 III) means typing the full new one, which `PATCH /auth/me`
  accepts. Seeing the full stored value is access (art. 18 II), which the export already gives. A
  reveal route would be one more path that returns a CPF in full, for no capability the user lacks.
  Masked values are refused on PATCH, as on `PATCH /clients/:id`.
- **`PATCH /auth/me` is partial.** `UpdateUser` replaces every field, so the BFF reads the self
  view and sends back what the body omits. That is the clients PATCH's CPF rule extended to every
  field: the profile form can send only what changed. `cpf: null` removes the CPF, which a TRAINER
  can't (required; 400 before any `UpdateUser`). A CREF is a TRAINER's only.
- **Email changes are not verified yet.** The new address is the login from then on. A verification
  flow (confirm the new address before switching) is a P1-06 follow-up.
- **Account deletion needs the password.** The BFF re-checks it with `VerifyCredentials` (the same
  helper as `POST /auth/password`), so a stolen session or a CSRF-style one-click can't delete the
  account. The route has its own strict bucket (IP + user, failures only).
- **Export rate limit:** 3 per hour per user, every export counts (a 5xx is refunded). Its own
  `AttemptLimiter` (`profile: 'export'`), since one limiter needs one window length for its sweep.
  Keyed on the user, not the IP.
- **`RESOURCE_EXHAUSTED` → 413 `TOO_LARGE` globally,** with a fixed message. Only the export can
  return it today; grpc-js's own receive limit (4 MiB, above vertice-api's 3 MB bound) gives the
  same status and means the same thing.
- **Audit lines:** `account.update` (field names only), `account.delete`, `account.export`, with the
  actor's id. The `audit_events` table is P2-08.
- **Deletes over recorded data** need no BFF change: vertice-api's FAILED_PRECONDITION already maps
  to 409 `PRECONDITION_FAILED` with a fixed message. `src/test/recorded-data.test.ts` pins it for
  plans, workouts, workout exercises and sets.

## Merge and deploy order

vertice-api (#67, #68, #69, merged) → vertice-bff (this) → vertice-web-react (P1-06). The BFF calls
RPCs that must exist upstream; the web needs the routes before it can offer them. Until the web
ships, the only visible change is `DELETE /clients/:id` (not exposed in the web today) and the
masked `cpf` key in `GET /auth/me`, which the web ignores. Rollback: revert the BFF first; the API
RPCs are additive.
