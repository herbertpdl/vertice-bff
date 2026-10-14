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

## Client IPs and the rate limits

The per-IP buckets (strict auth buckets and the global one) key on `req.ip` (IPv6 cut to its
/64). Who that is depends on the path a request takes:

- **vertice-web-react** calls the BFF server-side, from its Next server. Without help, every web
  user is that server's address: one shared bucket, so about five typos anywhere lock web login out
  platform-wide, and all web traffic shares the global 300/min. So the web server **forwards the
  browser's IP as `X-Forwarded-For`** on every BFF call (appending the address it saw to any
  incoming value), and the BFF sets **`TRUST_PROXY` to the web server's address(es)**. Fastify then
  takes the right-most untrusted `X-Forwarded-For` entry as `req.ip`: the address the web server
  observed, which a browser can't forge.
- **vertice-mobile / Expo web** call the BFF directly: `req.ip` is the socket peer, not trusted,
  so any `X-Forwarded-For` they send is ignored.
- **A reverse proxy in front of the BFF** must be listed in `TRUST_PROXY` too (comma-separated),
  and must append, not pass through, `X-Forwarded-For`.

`src/modules/auth/routes.test.ts` pins this: two forwarded client IPs from the trusted web server
get separate buckets, and an untrusted peer's `X-Forwarded-For` is ignored.

Memory: strict-bucket keys are fixed-size (IPv6 by /64, any non-address as one `invalid` key,
emails as a SHA-256 of the normalized address, and none at all for a malformed one), a bucket
refunded to zero is deleted, and each route also checks a per-network bucket (IPv6 /48, IPv4 /24,
`AUTH_RATE_LIMIT_NETWORK_MAX`, default 20 × the limit) before allocating anything else. The
limiter holds at most `AUTH_RATE_LIMIT_MAX_KEYS` (default 1M, ~230 MB measured) and fails closed
when full: new clients get 429 until buckets expire, tracked ones keep working, and a spray can't
flush a victim's counter. Sweeps delete at most 1,000 expired buckets per call.

Residual risk: once the cap is reached, clients the limiter isn't already tracking get 429 until windows expire. Reaching it takes many distinct networks: each IPv6 /48 or IPv4 /24 can hold only about `2 × AUTH_RATE_LIMIT_NETWORK_MAX` keys per route per window (≈200 by default), so filling 1M keys needs roughly 5,000 distinct /48s (or /24s) failing at full rate on one route, or about 1,250 spread over all four strict routes. That is within reach of a large botnet or a cheap pool of IPv6 allocations; the remedies then are a shared store, a CAPTCHA/proof-of-work step, or blocking at the edge.

## Merge and deploy order

1. **vertice-api** PR #53 (merged): the RPCs this BFF calls.
2. **vertice-web-react, `X-Forwarded-For` forwarding** (P0-02 step 6): **a hard prerequisite for
   deploying this BFF.** Deployed with an unpatched web, every web user shares one rate-limit
   bucket and a handful of failed logins locks web login out for everyone. The forwarding is
   harmless before the BFF trusts it, so it can deploy first; the rest of the web PR (setup page,
   setup link in `NewStudentDialog`, register route hardcoding `TRAINER`) needs this BFF's routes
   and can ship in the same release or after.
3. **vertice-bff** (this), deployed with `TRUST_PROXY` set to the web server's address(es).
4. **vertice-mobile**: setup/change-password screens, 429 handling.

Local dev (web and BFF on one machine) works without either step: one developer sharing a bucket
with themselves is fine, and `AUTH_RATE_LIMIT_MAX` can be raised.

Rollout: legacy clients (random passwords) are locked out from the moment this BFF is deployed
with `VERIFY_PASSWORDS=true` until they redeem an ops-issued link. Run
`npm run ops:issue-setup-tokens` and distribute the links first; in a dev environment
`VERIFY_PASSWORDS=false` can bridge the gap. Rollback: revert the BFF (the API RPCs stay unused);
the web's forwarding needs no rollback.
