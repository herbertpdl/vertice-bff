# Password lifecycle (BFF)

Related: vertice-api [`docs/specs/password-lifecycle/spec.md`](https://github.com/herbertpdl/vertice-api/blob/main/docs/specs/password-lifecycle/spec.md)
(PR #53); Vertice health audit 2026-10-09, plan item P0-02 steps 3–5 (SEC-BFF-001, SEC-BFF-005,
PERF-BFF-001, PROD-BFF-002, BFF part of PARITY-005). Request/response shapes are in
[`docs/api-contract.md`](../../api-contract.md).

## Endpoints → upstream RPCs

| Endpoint | Auth | Upstream | Notes |
|---|---|---|---|
| `POST /auth/login` | public, rate-limited | `UserService.VerifyCredentials` | One 401 body for every refusal. `VERIFY_PASSWORDS=false` (dev/test only) falls back to the old `ListUsers` scan. |
| `POST /auth/register` | public, rate-limited | `UserService.CreateUser` | `role` must be `TRAINER`. No `ListUsers` pre-check: upstream's unique email is the 409. |
| `POST /auth/password` | any role | `GetUser` → `VerifyCredentials` → `SetUserPassword` | Self only. Wrong current password → 400 `INVALID_CURRENT_PASSWORD`. |
| `POST /auth/password/setup` | public, rate-limited | `UserService.SetPasswordWithToken` | Upstream `UNAUTHENTICATED` → 400 `INVALID_SETUP_TOKEN`. |
| `POST /clients` | TRAINER/ADMIN | `CreateClientForTrainer` (empty password) → `CreatePasswordSetupToken` | Returns `setup: {token, expiresAt} \| null`. |
| `POST /clients/:id/setup-token` | TRAINER, own client | `ListUsersWithoutPassword(CLIENT)` → `CreatePasswordSetupToken` | 409 `PRECONDITION_FAILED` once the client has a password. |

The password policy (≥8 chars, ≤72 UTF-8 bytes, not blank) is mirrored in Zod so a violation is a
400 before any upstream call.

## Decisions

- **Setup link path:** `/definir-senha?token=<token>`. The web builds it from `setup.token`; the ops
  script prints the same path.
- **Re-issue only while the client has no password.** Otherwise a trainer could reset a client's
  password and take over the account. Password reset proper is P1-06.
- **Strict rate limits count failures on login and setup, every attempt on register.** See
  `docs/api-contract.md#rate-limits`.
- **Existing clients:** `npm run ops:issue-setup-tokens` (README, "Operations").

## Merge and deploy order

vertice-api (PR #53, merged) → vertice-bff (this) → vertice-web-react (setup page, link in
`NewStudentDialog`, register route hardcodes `TRAINER`) / vertice-mobile. The BFF calls RPCs that
only exist from PR #53 on. The web can ship after the BFF: the extra `setup` field is additive, and
the web already sends `role: "TRAINER"`.

Rollout: deploy with `VERIFY_PASSWORDS=false` only in a dev environment that still has legacy
clients, run the ops script, distribute links, then remove the flag (default `true`). Rollback:
revert the BFF; the API RPCs stay unused.
