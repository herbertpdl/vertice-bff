# Spec (BFF): Stay logged in on the mobile app

Status: Implemented (merge gated on vertice-api, see §5)
Owner: as in the PRD
Related: [vertice-api PRD](https://github.com/herbertpdl/vertice-api/blob/main/docs/prds/mobile-persistent-session/prd.md) (Approved; R14 amended by the owner: a role change still ends sessions),
[vertice-api assessment](https://github.com/herbertpdl/vertice-api/blob/main/docs/assessments/mobile-persistent-session/assessment.md),
this repo's assessment for the same slug (B1–B6), ticket VRT-6

## 0. Scope decisions

- **Stateless 90-day mobile token plus a renewal route (assessment option A).** No session store;
  revocation is vertice-api's check on every call. Refresh tokens per device (option B) are out of
  scope with the PRD's §6.
- **The mobile app asks with a request header, `X-Vertice-Client: mobile` (B1).** Read on
  `POST /auth/login` and `POST /auth/register` only: trimmed, any case, exactly `mobile` means a
  mobile session; absent, repeated or any other value means today's 8h web session. A malformed
  value is never a 400, so no existing client can break on it. Never inferred from `User-Agent`.
  The web cannot send it: its Next routes forward only `X-Forwarded-For`. Login and register body
  schemas are unchanged (R1, R2, R5, R18, R19). The header is declared as an optional header
  parameter (`enum: [mobile]`) on login, register and renewal in `docs/openapi.json`. CORS needs no
  change: `@fastify/cors` reflects the requested headers when `allowedHeaders` is unset (Expo web).
- **ADMIN never gets a mobile session.** The PRD's actors are trainers and clients, and ADMIN has
  no product (P1-02); with the header, an ADMIN still gets the 8h session, and renewal is
  `requireRole('TRAINER', 'CLIENT')` (403 by role before anything else). The ADMIN route list in
  `route-authorization.test.ts` is unchanged.
- **The mobile claim is `session: "mobile"` (B3).** Present only on mobile tokens; web tokens have
  exactly the claims they had (`sub`, `role`, `iss`, `aud`, `iat`, `exp`). `verifyToken` refuses a
  `session` claim with any other value and returns `AuthUser.session = "mobile"` for a mobile
  token. Cross-repo claim change: vertice-api's `HmacJwtDecoder` checks signature, `alg`, `typ`,
  `iss`, `aud` and that `exp` exists and is in the future, with no upper bound on lifetime;
  `CallerIdentityResolver` reads `sub` and `role` only. So vertice-api accepts the extra claim and
  the 90-day `exp` with **no code change**; its resolver comment ("Token shapes") should mention the
  claim (doc-only, can ride with VRT-5).
- **Every session response carries `expiresAt`** (the token's `exp` as an ISO-8601 instant), web
  and mobile alike: an additive field on `AuthSession`, so existing clients are unaffected, and the
  app knows when to renew without decoding the token.
- **Renewal decides from the token, never the header (B2).** A web token is refused with or without
  the header: `403 SESSION_NOT_RENEWABLE` (a new error code, not a 401: an app that still holds a
  pre-release 8h token must not read it as a logout; it keeps the token until it expires, R18).
- **Renewal asks vertice-api before signing.** `GetUser` on the caller's own id with the caller's
  own token. `CallerIdentityResolver` refuses a deleted user or a changed role (R12, R14 amended),
  and vertice-api's VRT-5 adds "sessions valid after" (last password change) against `iat`, so a
  token voided by a password change (R9–R11) is refused too. Every refusal is `UNAUTHENTICATED` →
  `401 UNAUTHENTICATED` "Session no longer valid", no token. The BFF also checks the answered id and
  role equal the token's. The new token's `iat` is the renewal time, after vertice-api accepted
  the old token.
- **"Sair" doesn't revoke (B4).** Accepted with the PRD: the phone deletes its token; the token stays
  valid until it expires or the password changes. A renewal does not revoke the old token either.
- **Rate limit:** bucket `session-renew`, keys IP + user (plus the automatic network bucket),
  `AUTH_RATE_LIMIT_*` (5 per 15 minutes), **counting refusals only**. Counting successes would let
  one carrier-grade NAT /24 of phones lock each other out through the network bucket; a successful
  renewal costs one `GetUser` and is bounded by the global per-IP bucket. The mobile app renews on
  use at most about once a day.
- **Tokens are never logged.** Nothing logs a header or a response body; a test captures every log
  line of a renewal and a mobile login and checks neither token appears.

## 1. Contract

| | |
|---|---|
| Header | `X-Vertice-Client: mobile` (optional; login, register, renewal) |
| Claim | `session: "mobile"` on mobile tokens only |
| Mobile lifetime | 90 days from issue (`MOBILE_SESSION_TTL_SECONDS`), restarted by each renewal |
| Web lifetime | `JWT_EXPIRES_IN` (8h), unchanged |
| `POST /api/auth/login`, `POST /api/auth/register` | `AuthSession` `{token, expiresAt, user}` (`expiresAt` added) |
| `POST /api/auth/session/renew` | bearer, TRAINER or CLIENT, no body → `200 AuthSession` |
| Renewal errors | `401` missing/invalid/expired token (`UNAUTHORIZED`) or vertice-api refused (`UNAUTHENTICATED`); `403 FORBIDDEN` ADMIN by role; `403 SESSION_NOT_RENEWABLE` web token; `429 RATE_LIMITED` |

## 2. Changes

- `src/lib/jwt.ts`: `MOBILE_SESSION`, `MOBILE_SESSION_TTL_SECONDS`; `signToken` adds the claim and
  the 90-day expiry for `AuthUser.session === "mobile"`; `verifyToken` validates and returns it;
  `tokenExpiresAt`.
- `src/modules/auth/schemas.ts`: `SESSION_CLIENT_HEADER`, `sessionClientHeadersSchema` (docs only),
  `sessionClientOf(headers)`.
- `src/modules/auth/service.ts`: `Session.expiresAt`; `login`/`register` take the session client;
  `renewSession(caller)`.
- `src/modules/auth/routes.ts`: the header on login and register; `POST /session/renew` with the
  `session-renew` limiter.
- `src/openapi/docs.ts`: `routeDoc({ headers })`; `src/openapi/responses.ts`: `AuthSession.expiresAt`,
  `SESSION_NOT_RENEWABLE` in `ERROR_CODES`.
- `docs/openapi.json` and the route reference regenerated; prose in `docs/api-contract.md`
  ("Web and mobile sessions", Auth, Rate limits), README (`JWT_EXPIRES_IN`, secret rotation ends
  mobile sessions too, B6), CLAUDE.md (trust model, rate limits).

## 3. Tests

- `auth/routes.test.ts`: login without the header → 8h, no claim, `expiresAt` = `exp`; with it → 90
  days and the claim, for a client and a trainer; header trimmed/any case, other values → web;
  `User-Agent` alone → web; ADMIN with the header → web; register both ways. Renewal: a 30-day-old
  mobile token → a fresh 90-day one (later `exp`), `GetUser` sent with the caller's own token; a
  trainer too; a web token → 403 `SESSION_NOT_RENEWABLE` with and without the header, nothing
  upstream; vertice-api `UNAUTHENTICATED` → 401, no token; a deleted and a re-roled user → 401; an
  expired mobile token → 401 before any upstream call; no token in the logs. Rate limits: the 6th
  refusal for one user is 429 across IPs; successful renewals don't count.
- `lib/jwt.test.ts`: the claim round-trips; web tokens unchanged; other `session` values refused;
  `tokenExpiresAt`.
- `route-authorization.test.ts`: the renewal entry (`roles: ['TRAINER', 'CLIENT']`, called with a
  mobile token); the 2xx parses with `AuthSession`.

## 4. Rollout

Additive and inert until a mobile build sends the header: the web and installed apps keep getting
8h tokens (R18). No proto change. Rollback: redeploy the previous BFF; mobile tokens already issued
stay valid until they expire or the password changes (the previous BFF verifies them, ignoring the
claim, but cannot renew them).

## 5. Merge and deploy order

1. **vertice-api VRT-5** (password change voids older tokens, "sessions valid after" against
   `iat`), merged **and deployed**. Long-lived tokens must not exist before a password change can
   revoke them (assessment B5). No vertice-api change is needed for the claim or the 90-day `exp`.
2. **vertice-bff** (this change). Re-pin `protos/.api-ref` only if VRT-5 changed a proto this BFF
   loads.
3. **vertice-mobile** sends the header, stores `expiresAt`, renews on use and treats
   `SESSION_NOT_RENEWABLE` as "keep the current token". vertice-web-react needs nothing (it never
   sends the header); it may regenerate its types for the additive `expiresAt`.

Rollback goes the other way: mobile first, then the BFF; vertice-api's revocation check stays.
