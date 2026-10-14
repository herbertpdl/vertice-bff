# vertice-bff

Backend for Frontend for `vertice-web-react`. It exposes an HTTP/JSON REST API and bridges each
request to `vertice-api`, a gRPC service, translating between the two protocols and shaping
responses for the frontend's screens.

## Tech stack

- Node.js (>= 22), TypeScript
- [Fastify](https://fastify.dev/) — HTTP server
- [`@grpc/grpc-js`](https://github.com/grpc/grpc-node) + [`@grpc/proto-loader`](https://github.com/grpc/grpc-node/tree/master/packages/proto-loader) — gRPC client to `vertice-api`
- [Zod](https://zod.dev/) — request validation
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
scripts/                 operator CLIs (`npm run ops:*`)
  modules/                one folder per resource (routes/schemas/service), e.g.
                          auth, students, exercises, training-plans, workouts,
                          workout-exercises, exercise-sets, workout-sessions,
                          feedback, dashboard, users
docs/api-contract.md     REST API contract (endpoints, request/response shapes, known limitations)
```

Each module under `src/modules/*` typically has:
- `routes.ts` — Fastify route registration
- `schemas.ts` — Zod request/response schemas
- `service.ts` — business logic, including calls to the gRPC clients

## Prerequisites

- Node.js >= 22
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
| `VERIFY_PASSWORDS` | `true` | Login checks the password through vertice-api's `VerifyCredentials`. `false` restores the old email-only login (any password works) for the rollout window, until every existing client has a setup link (see [Operations](#operations)). The BFF logs a warning at startup when it is `false`, and refuses to start with `false` unless `NODE_ENV` is unset, `development` or `test` |
| `TRUST_PROXY` | `false` | Fastify `trustProxy`: which peers may tell the BFF the client's IP through `X-Forwarded-For`. The rate limits key on that IP. **Set it to vertice-web-react's server address(es)**, comma-separated addresses/CIDRs (e.g. `10.0.0.5`, `10.0.0.0/24`, or `loopback` when they share a host): the web calls the BFF server-side and forwards the browser's IP as `X-Forwarded-For`; without this every web user shares one bucket. Add any reverse proxy in front of the BFF. Peers not listed (vertice-mobile, Expo web) are keyed by their own address and their `X-Forwarded-For` is ignored. `true` trusts every hop: only when nothing reaches the BFF except through a proxy that overwrites the header. A bare hop count (`1`) is refused: this Fastify version treats a number as "trust nothing". `false` is fine for local dev |
| `RATE_LIMIT_GLOBAL_MAX` / `RATE_LIMIT_GLOBAL_WINDOW_MS` | `300` / `60000` | Loose per-IP bucket over every route |
| `AUTH_RATE_LIMIT_NETWORK_MAX` | `20 × AUTH_RATE_LIMIT_MAX` (`100`) | Strict-bucket limit per client network (IPv6 /48, IPv4 /24), checked before any per-IP or per-email bucket is created, so one network can only create a bounded number of buckets however many addresses it rotates through |
| `AUTH_RATE_LIMIT_MAX_KEYS` | `1000000` | Most strict-bucket keys held in memory. Keys are fixed-size (IPs normalized, emails stored as a SHA-256), so this is about 230 MB worst case (measured: ~1.6 µs per attempt at 1M keys). When full, requests that need a new key get `429` until buckets expire (fail closed, so a spray of fresh IPs can't flush live counters); clients already tracked are unaffected. Residual risk: once the cap is reached, clients the limiter isn't already tracking get 429 until windows expire. Reaching it takes many distinct networks: each IPv6 /48 or IPv4 /24 can hold only about `2 × AUTH_RATE_LIMIT_NETWORK_MAX` keys per route per window (≈200 by default), so filling 1M keys needs roughly 5,000 distinct /48s (or /24s) failing at full rate on one route, or about 1,250 spread over all four strict routes. That is within reach of a large botnet or a cheap pool of IPv6 allocations; the remedies then are a shared store, a CAPTCHA/proof-of-work step, or blocking at the edge. |
| `AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS` | `5` / `900000` | Strict per-IP and per-email buckets on `/auth/login`, `/auth/register` and `/auth/password[/setup]`: the request after `AUTH_RATE_LIMIT_MAX` counted attempts in the window gets `429`. Login and password setup count failures only; register counts every attempt. See [`docs/api-contract.md`](docs/api-contract.md#rate-limits) |

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
orchestrating Postgres, the API, this BFF, and the web app with hot reload for all three), run:

```sh
cd ../vertice-local
cp .env.example .env   # first time only
docker compose up --build
```

This starts, in order: Postgres -> `vertice-api` (gRPC on `:9090`, HTTP on `:8080`) ->
`vertice-bff` (`:3000`) -> `vertice-web-react` (`:5173`). Source is bind-mounted, so this BFF's
container restarts automatically on file changes.

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
| `npm run ops:issue-setup-tokens [-- --dry-run]` | Issue a password setup link to every CLIENT (see [Operations](#operations)) |

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
  `ListUsers(role=CLIENT)`. Not `ListUsersWithoutPassword`: legacy clients have a random password
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
- vertice-api has no role restriction on these RPCs yet (P1-01); once it does, the script needs
  the BFF's service identity.

## API

All routes are mounted under `/api` (e.g. `POST /api/auth/login`, `GET /api/students`).
Authenticated routes expect `Authorization: Bearer <token>`. Error responses share a common
shape: `{ "error": { "code": "...", "message": "...", "details": {} } }`.

See [`docs/api-contract.md`](docs/api-contract.md) for the full list of endpoints, request/response
shapes, roles, rate limits and known MVP limitations.

## gRPC contract

The `.proto` files under `protos/vertice/**` describe the `vertice-api` gRPC services this BFF
consumes (`UserService`, `ExerciseService`, `TrainingPlanService`, `WorkoutService`,
`WorkoutExerciseService`, `ExerciseSetService`, `WorkoutSessionService`,
`WorkoutFeedbackService`). They are loaded dynamically at startup via `@grpc/proto-loader`
(see `src/grpc/loadProto.ts`); client instances live in `src/grpc/clients.ts`.

## Docker

A `Dockerfile` is provided for local development (installs dependencies, then runs
`npm run dev:docker`). It is intended to be built via `vertice-local`'s `docker-compose.yml`,
which supplies the environment variables needed to reach `vertice-api` and Postgres.
