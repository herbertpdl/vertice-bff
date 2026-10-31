# vertice-bff

Backend for Frontend for `vertice-web-react`. It exposes an HTTP/JSON REST API and bridges each
request to `vertice-api`, a gRPC service, translating between the two protocols and shaping
responses for the frontend's screens.

## Tech stack

- Node.js 22 (pinned in `.nvmrc`; `engines.node` is `>=22 <23`), TypeScript
- [Fastify](https://fastify.dev/) — HTTP server
- [`@grpc/grpc-js`](https://github.com/grpc/grpc-node) + [`@grpc/proto-loader`](https://github.com/grpc/grpc-node/tree/master/packages/proto-loader) — gRPC client to `vertice-api`
- [Zod](https://zod.dev/) 4 — request validation, and the source of the OpenAPI document
- [`fastify-type-provider-zod`](https://github.com/turkerdev/fastify-type-provider-zod) + [`@fastify/swagger`](https://github.com/fastify/fastify-swagger) — generate `docs/openapi.json` from the route schemas (dev dependencies; not loaded by a normal start)
- [`jsonwebtoken`](https://github.com/auth0/node-jsonwebtoken) — auth tokens issued by the BFF
- [Pino](https://getpino.io/) — logging
- [Vitest](https://vitest.dev/) — test runner

## Project structure

```
protos/                gRPC .proto definitions consumed from vertice-api
src/
  server.ts             entrypoint — starts the Fastify server
  app.ts                builds the Fastify app and registers all routes under /api
  config/env.ts          environment variable parsing/validation (zod)
  grpc/                  proto loading and gRPC client instances for vertice-api
  lib/                   shared helpers (JWT, error types, date/ownership utils, net)
  plugins/               Fastify plugins (authentication, error handling, rate limits)
  ops/                   one-off operations run from scripts/ (e.g. issuing setup tokens)
  modules/                one folder per resource (routes/schemas/service), e.g.
                          auth, legal, clients, exercises, training-plans, workouts,
                          workout-exercises, exercise-sets, workout-sessions,
                          feedback, dashboard, users
  openapi/               OpenAPI generation: per-route docs, response schemas, the generator
scripts/                 operator and build CLIs (`npm run ops:*`, `sync:protos`, `openapi`)
docs/openapi.json        generated OpenAPI 3.1 document (`npm run openapi`; CI fails when stale)
docs/api-contract.md     REST API contract: prose (ownership, errors, rate limits) plus a generated route reference
```

Each module under `src/modules/*` typically has:
- `routes.ts` — Fastify route registration
- `schemas.ts` — Zod request schemas (the handlers parse with them; they also feed the OpenAPI document)
- `service.ts` — business logic, including calls to the gRPC clients

## Prerequisites

- Node.js 22 (`nvm use` picks it up from `.nvmrc`)
- A running `vertice-api` instance reachable over gRPC (defaults to `localhost:9090`)

## Setup

```sh
npm install
cp .env.example .env
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the BFF listens on |
| `HOST` | `0.0.0.0` | HTTP host to bind |
| `LOG_LEVEL` | `info` | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`) |
| `CORS_ORIGIN` | `http://localhost:8081` | Comma-separated browser origins allowed to call the BFF directly. Only needed for browser clients such as Expo web (`vertice-mobile` `npm run web`, Metro on `:8081`). `vertice-web-react` doesn't need an entry: its Next server proxies to the BFF server-side. An empty value allows no browser origin |
| `VERTICE_API_GRPC_HOST` | `localhost` | Host of the `vertice-api` gRPC server |
| `VERTICE_API_GRPC_PORT` | `9090` | Port of the `vertice-api` gRPC server |
| `JWT_SECRET` | `vertice-dev-jwt-secret-do-not-use-in-production` (only when `NODE_ENV` is unset, `development` or `test`) | HS256 secret used to sign/verify auth tokens issued by the BFF; must equal vertice-api's. For any other `NODE_ENV` (`production`, `staging`, ...; trimmed and case-insensitive) there is no default: the BFF refuses to start if it is missing, has leading/trailing whitespace, is shorter than 32 bytes, or is a known placeholder/dev value (mirrors vertice-api's `JwtSecretGuard`). Generate one with `openssl rand -base64 48` |
| `JWT_EXPIRES_IN` | `8h` | Auth token expiry |
| `VERIFY_PASSWORDS` | `true` | Login checks the password through vertice-api's `VerifyCredentials`. `false` restores the old email-only login (any password works) for the rollout window, until every existing client has a setup link (see [Operations](#operations)). The BFF logs a warning at startup when it is `false`, and refuses to start with `false` unless `NODE_ENV` is unset, `development` or `test`. With `false`, login finds the user through an unauthenticated `ListUsers`, so it **only works against vertice-api's `local` profile** (the BFF's service token may not list users) |
| `TRUST_PROXY` | `false` | Fastify `trustProxy`: which peers may tell the BFF the client's IP through `X-Forwarded-For`. The rate limits key on that IP. **Set it to vertice-web-react's server address(es)**, comma-separated addresses/CIDRs (e.g. `10.0.0.5`, `10.0.0.0/24`, or `loopback` when they share a host): the web calls the BFF server-side and forwards the browser's IP as `X-Forwarded-For`; without this every web user shares one bucket. Add any reverse proxy in front of the BFF. Peers not listed (vertice-mobile, Expo web) are keyed by their own address and their `X-Forwarded-For` is ignored. `true` trusts every hop: only when nothing reaches the BFF except through a proxy that overwrites the header. A bare hop count (`1`) is refused: this Fastify version treats a number as "trust nothing". `false` is fine for local dev |
| `RATE_LIMIT_GLOBAL_MAX` / `RATE_LIMIT_GLOBAL_WINDOW_MS` | `300` / `60000` | Loose per-IP bucket over every route |
| `AUTH_RATE_LIMIT_NETWORK_MAX` | `20 × AUTH_RATE_LIMIT_MAX` (`100`) | Strict-bucket limit per client network (IPv6 /48, IPv4 /24), checked before any per-IP or per-email bucket is created, so one network can only create a bounded number of buckets however many addresses it rotates through. Shared networks: the network bucket is shared by everyone behind the same IPv4 /24 or IPv6 /48 — carrier-grade NAT, an office or university network, a mobile carrier's /48. One abuser on that network can use it up (about 100 failures in 15 minutes by default) and lock everyone else on it out of that route for the rest of the window, even with correct passwords. Raise `AUTH_RATE_LIMIT_NETWORK_MAX` if many users sit behind shared networks. The long-term fix is a shared store plus a CAPTCHA or proof-of-work step instead of a hard network limit. |
| `AUTH_RATE_LIMIT_MAX_KEYS` | `1000000` | Most strict-bucket keys held in memory. Minimum `3` (one attempt can need a network, an IP and an email key). Keys are fixed-size (IPs normalized, emails stored as a SHA-256), so this is about 230 MB worst case (measured: ~1.6 µs per attempt at 1M keys). When full, requests that need a new key get `429` until buckets expire (fail closed, so a spray of fresh IPs can't flush live counters); clients already tracked are unaffected. Residual risk: once the cap is reached, clients the limiter isn't already tracking get 429 until windows expire. Reaching it takes many distinct networks: each IPv6 /48 or IPv4 /24 can mint only about `2 × AUTH_RATE_LIMIT_NETWORK_MAX` keys per route per window, but keys from consecutive windows overlap, so it can hold about `4 × AUTH_RATE_LIMIT_NETWORK_MAX` (≈400 by default; 399 measured). Filling 1M keys therefore needs roughly 2,500 distinct /48s (or /24s) failing at full rate on one route, or about 625 spread over all four strict routes. That is within reach of a large botnet or a cheap pool of IPv6 allocations; the remedies then are a shared store, a CAPTCHA/proof-of-work step, or blocking at the edge. |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | `5` / `900000` | Strict per-IP and per-email buckets on `/auth/login`, `/auth/register` and `/auth/password[/setup]`: the request after `AUTH_RATE_LIMIT_MAX` counted attempts in the window gets `429`. Login and password setup count failures only; register counts every attempt. See [`docs/api-contract.md`](docs/api-contract.md#rate-limits) |
| `EXPORT_RATE_LIMIT_MAX` / `EXPORT_RATE_LIMIT_WINDOW_MS` | `3` / `3600000` | Per-user bucket on `GET /api/auth/me/export` (the data export), counting every export; the next one in the window is `429`. Its own limiter, sharing `AUTH_RATE_LIMIT_NETWORK_MAX` and `AUTH_RATE_LIMIT_MAX_KEYS`. |
| `TERMS_VERSION` / `HEALTH_DATA_CONSENT_VERSION` | `2026-10-draft` / `2026-10-draft` | Current version of the Terms of Use / Privacy Policy and of the health-data consent notice (P1-04), served by the public `GET /api/legal/versions`. 1 to 32 of `[A-Za-z0-9._-]` (vertice-api's format); anything else refuses to start. Bump one when its text changes: users whose stored consent has another version are asked again. The texts are drafts pending legal review |

## Running locally

`vertice-bff` needs a running `vertice-api` (gRPC) to talk to. There are two ways to run the
stack:

### Option 1 — run each app natively (recommended)

As sibling checkouts (`vertice-api`, `vertice-bff`, `vertice-web-react`), each in its own
terminal, no Docker required beyond Postgres:

1. `vertice-api` — `docker compose up -d` (Postgres only), then
   `./gradlew bootRun --args='--spring.profiles.active=local'` (gRPC on `:9090`, auth disabled
   for local dev — see `vertice-api`'s `application-local.properties`).
2. `vertice-bff` (this repo):
   ```sh
   npm install
   cp .env.example .env
   npm run dev
   ```
   This starts the REST API on `http://localhost:3000` using `tsx watch` (restarts on file
   changes).
3. `vertice-web-react` — `npm install && npm run dev` (`http://localhost:5173`; its `dev`
   script is pinned to `5173` so it doesn't collide with this BFF's `3000`).

This avoids Docker image-cache/rebuild pain, especially for the frontend.

### Option 2 — full stack via `vertice-local`

If you have a `vertice-local` repo checked out as a sibling (holds a `docker-compose.yml`
orchestrating Postgres, the API and this BFF with hot reload), run:

```sh
cd ../vertice-local
cp .env.example .env   # first time only
docker compose up --build
```

This starts, in order: Postgres -> `vertice-api` (gRPC on `:9090`, HTTP on `:8080`) ->
`vertice-bff` (`:3000`). It does not start the web app: run `vertice-web-react` natively
(`npm run dev`, `:5173`). Source is bind-mounted, so this BFF's container restarts automatically
on file changes.

A basic health check is available at `GET /health`.

## Available scripts

| Script | Description |
|---|---|
| `npm run dev` | Run the server in watch mode with `tsx` |
| `npm run dev:docker` | Same as `dev`, but with polling-based file watching (`CHOKIDAR_USEPOLLING=true`; for Docker bind mounts where native filesystem events aren't reliable, e.g. Docker Desktop on macOS) |
| `npm run build` | Type-check and compile to `dist/` |
| `npm start` | Run the compiled output from `dist/` (`node dist/server.js`) |
| `npm run typecheck` | Type-check without emitting output |
| `npm run lint` | Run ESLint |
| `npm test` | Run the test suite with Vitest |
| `npm run test:hostile-tz` | Run the whole suite again with the host pinned to `TZ=Pacific/Kiritimati` (UTC+14), proving nothing depends on the host's time zone (see [Dates and times](#dates-and-times)) |
| `npm run sync:protos [-- --check]` | Copy `protos/vertice/**` from the pinned vertice-api commit (see [gRPC contract](#grpc-contract)) |
| `npm run openapi [-- --check]` | Write `docs/openapi.json` and the route reference in `docs/api-contract.md` from the route schemas; `--check` fails when either is stale (see [OpenAPI](#openapi)) |
| `npm run ops:issue-setup-tokens [-- --dry-run]` | Issue a password setup link to every CLIENT (see [Operations](#operations)) |

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`, on the Node
version in `.nvmrc`: `npm ci`, `npm run sync:protos -- --check`, `npm run openapi -- --check`,
`npm run typecheck`, `npm run lint`, `npm test`, `npm run test:hostile-tz`, `npm run build` and
`npm audit --omit=dev --audit-level=high`. The tests mock the upstream, so CI needs no
running `vertice-api` or Postgres. Run the same commands locally before opening a PR.

## Operations

### Issuing setup links to existing clients (password verification rollout)

Clients created before password setup tokens got a random password nobody knows, so once login
verifies passwords (the default) **they are locked out until they redeem a setup link**. Run this
and distribute the links before deploying with `VERIFY_PASSWORDS=true` (in dev,
`VERIFY_PASSWORDS=false` can bridge the gap):

```sh
# Who would get a link (issues nothing):
npm run -s ops:issue-setup-tokens -- --dry-run
# Issue them; one CSV line per client on stdout:
npm run -s ops:issue-setup-tokens > setup-links.csv
```

- It reads the same `.env` as the BFF (`VERTICE_API_GRPC_HOST`/`PORT`) and lists every CLIENT with
  `ListUsers(role=CLIENT)`, page by page (vertice-api returns at most 100 users per call) until
  `next_page_token` is empty. Not `ListUsersWithoutPassword`: legacy clients have a random password
  hash, so they don't show up there.
- Output is CSV on stdout, `userId,email,linkPath,expiresAt`; `linkPath` is
  `/definir-senha?token=…`, to prefix with the web app's origin. Progress and errors go to
  stderr. Nothing is logged.
- **The links are credentials**: anyone holding one can set that client's password. Send each
  link only to its client, and delete the file afterwards. Tokens expire after 72h (vertice-api
  `PASSWORD_SETUP_TOKEN_TTL`) and are single-use.
- Every run issues a new token per client and invalidates that client's previous unused one, so
  only the latest run's links work. It also issues one to clients who already set their own
  password, so run it once, at migration time. A trainer can re-issue a single client's link with
  `POST /api/clients/:id/setup-token` while that client has no password.
- It calls vertice-api as its own identity, `service:ops` (`src/ops/ops-token.ts`): a 60s token
  signed with `JWT_SECRET`, minted per call inside the script process only. vertice-api allows it
  on `ListUsers` and `CreatePasswordSetupToken` and nothing else; the running BFF's
  `service:bff` token is not allowed on either.

## API

All routes are mounted under `/api` (e.g. `POST /api/auth/login`, `GET /api/clients`).
Authenticated routes expect `Authorization: Bearer <token>`. Error responses share a common
shape: `{ "error": { "code": "...", "message": "...", "details": {} } }`.

See [`docs/api-contract.md`](docs/api-contract.md) for the prose (roles and ownership, error mapping,
rate limits, known limitations) and a generated route reference, and [`docs/openapi.json`](docs/openapi.json)
for the machine-readable contract.

### Dates and times

**The business time zone is `America/Sao_Paulo`.** Every date-ish field is either an **instant**
(ISO-8601 with `Z`, e.g. `completedAt` — an absolute point in time, which a client formats in a zone
and never slices a clock out of) or a **business date** (`yyyy-MM-dd`, e.g. a plan's `endDate` — a
local calendar day in that zone, with no time and no zone). "Today" and a week's Monday are derived
in the business zone through `Intl` (`src/lib/dates.ts`), not from `toISOString().slice(0, 10)`,
which is the UTC day and flips at 21:00 local. No field carries a fixed `-03:00`: Brazil observed
DST until 2019, so older instants were recorded at `-02:00`.

The BFF's correctness does not depend on its host's `TZ` and must not start to:
`npm run test:hostile-tz` runs the whole suite again with the process pinned to
`Pacific/Kiritimati` (UTC+14), and CI runs it. The rule, the per-field table and what clients must
do are in [`docs/api-contract.md`](docs/api-contract.md) ("Dates and times"); vertice-api's
[README](https://github.com/herbertpdl/vertice-api/blob/main/README.md) ("Dates and times") and
[CLAUDE.md](https://github.com/herbertpdl/vertice-api/blob/main/CLAUDE.md) ("Time: instants vs.
business dates") are the source of truth.

### OpenAPI

`docs/openapi.json` (OpenAPI 3.1: bearer security scheme, one `operationId` and tag per route, the shared
`ErrorResponse`, named enums) is **generated** from the Zod schemas on the routes, and committed. It is a build
artifact: the BFF serves no spec and no docs UI in any environment.

- `npm run openapi` regenerates it, and the route reference in `docs/api-contract.md`. Run it in any PR that
  changes a route, a request schema or a response shape, and commit the result. `npm run openapi -- --check`
  (CI, and a unit test) fails when the committed files are stale.
- Web and mobile generate their TypeScript types from it (`openapi-typescript`), e.g. from
  `https://raw.githubusercontent.com/herbertpdl/vertice-bff/main/docs/openapi.json`, or from a sibling checkout's
  `../vertice-bff/docs/openapi.json`.
- A route declares its documentation with `schema: routeDoc({ operationId, summary, tag, roles, params, query, body, ok, errors })`
  (`src/openapi/docs.ts`). The response shapes are in `src/openapi/responses.ts`, where a compile-time check fails if
  one stops matching the type its service returns, and the route-authorization suite parses every answer with them.
- The route schemas document; they do not validate. Handlers still call `schema.parse(...)` themselves, after
  authentication and ownership checks, so 401/403 still come before 400 and the error bodies are unchanged.

## gRPC contract

The `.proto` files under `protos/vertice/**` describe the `vertice-api` gRPC services this BFF
consumes (`UserService`, `ExerciseService`, `TrainingPlanService`, `WorkoutService`,
`WorkoutExerciseService`, `ExerciseSetService`, `WorkoutSessionService`,
`WorkoutFeedbackService`, `TrainerClientService`). They are loaded dynamically at startup via `@grpc/proto-loader`
(see `src/grpc/loadProto.ts`); client instances live in `src/grpc/clients.ts`.

The protos are **copies**: vertice-api owns them. `protos/.api-ref` pins the vertice-api commit they
come from, and `npm run sync:protos` rewrites `protos/vertice/**` from that commit (`*.proto` only).
Workflow for a contract change:

1. Change the proto in `vertice-api` and merge it.
2. Put the merge commit's full SHA in `protos/.api-ref`.
3. Run `npm run sync:protos` and commit both. (`-- --local` reads the sibling `../vertice-api` clone instead of GitHub.)

`npm run sync:protos -- --check` changes nothing and exits 1 if the copy differs from the pin; CI runs it,
so a proto edited by hand, or a pin bumped without syncing, fails the build. `protos/google/**` (well-known
types) is not synced.

## Docker

A `Dockerfile` is provided for local development (installs dependencies, then runs
`npm run dev:docker`). It is intended to be built via `vertice-local`'s `docker-compose.yml`,
which supplies the environment variables needed to reach `vertice-api` and Postgres.

`Dockerfile.prod` builds the deployed image: the compiled `dist/`, production dependencies only,
`NODE_ENV=production` (JSON logs, and the `JWT_SECRET` / `VERIFY_PASSWORDS` guards apply), run as
the `node` user on port 3000. The ECS tasks are ARM64, so pin the platform when building elsewhere:

```sh
docker build --platform linux/arm64 -f Dockerfile.prod -t vertice-bff .
```

Deployed, set at least `JWT_SECRET` (the same value as vertice-api's), `VERTICE_API_GRPC_HOST` /
`VERTICE_API_GRPC_PORT`, `CORS_ORIGIN` and `TRUST_PROXY`. `TRUST_PROXY` must list every proxy
between a client and the BFF, or `req.ip` is a proxy's address and users share rate-limit buckets
(five failed logins would lock everyone out): the VPC CIDR (load balancer, and vertice-web-react's
server, which must call the BFF privately through Service Connect, not the public URL) plus, behind CloudFront, its origin-facing ranges (`CLOUDFRONT_ORIGIN_FACING` in
`https://ip-ranges.amazonaws.com/ip-ranges.json`). Never `true` there: the load balancer appends to
`X-Forwarded-For`, so a client could pick its own IP and skip the login limits. `GET /health` is the
liveness check; it does not call vertice-api. The image has no curl, so a container health check
runs Node itself:
`node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`.
