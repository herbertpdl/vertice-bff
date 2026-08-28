# vertice-bff

Backend for Frontend for `vertice-web`. It exposes an HTTP/JSON REST API and bridges each
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
  plugins/               Fastify plugins (authentication, error handling)
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
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed CORS origin (the `vertice-web` dev server) |
| `VERTICE_API_GRPC_HOST` | `localhost` | Host of the `vertice-api` gRPC server |
| `VERTICE_API_GRPC_PORT` | `9090` | Port of the `vertice-api` gRPC server |
| `JWT_SECRET` | `dev-secret-change-me` | Secret used to sign/verify auth tokens issued by the BFF |
| `JWT_EXPIRES_IN` | `8h` | Auth token expiry |

## Running locally

`vertice-bff` needs a running `vertice-api` (gRPC) to talk to. There are two ways to run the
stack:

### Option 1 — full stack via `vertice-local`

If you have the sibling repos `vertice-api`, `vertice-bff`, and `vertice-web` checked out next
to a `vertice-local` repo (which holds a `docker-compose.yml` orchestrating Postgres, the API,
this BFF, and the web app with hot reload for all three), run:

```sh
cd ../vertice-local
cp .env.example .env   # first time only
docker compose up --build
```

This starts, in order: Postgres -> `vertice-api` (gRPC on `:9090`, HTTP on `:8080`) ->
`vertice-bff` (`:3000`) -> `vertice-web` (`:5173`). Source is bind-mounted, so this BFF's
container restarts automatically on file changes.

### Option 2 — run this service standalone against a local `vertice-api`

1. Start `vertice-api` and its database, then run it locally with the `local` Spring profile
   (gRPC on `:9090`, auth disabled for local dev — see `vertice-api`'s
   `application-local.properties`).
2. In this repo:
   ```sh
   npm install
   cp .env.example .env
   npm run dev
   ```
   This starts the REST API on `http://localhost:3000` using `tsx watch` (restarts on file
   changes).
3. Optionally start `vertice-web` (`npm run dev`, default `http://localhost:5173`) to hit the
   BFF from the actual frontend.

A basic health check is available at `GET /health`.

## Available scripts

| Script | Description |
|---|---|
| `npm run dev` | Run the server in watch mode with `tsx` |
| `npm run dev:docker` | Same as `dev`, but using polling-based file watching (for Docker bind mounts where native filesystem events aren't reliable, e.g. Docker Desktop on macOS) |
| `npm run build` | Type-check and compile to `dist/` |
| `npm start` | Run the compiled output from `dist/` (`node dist/server.js`) |
| `npm run typecheck` | Type-check without emitting output |
| `npm run lint` | Run ESLint |
| `npm test` | Run the test suite with Vitest |

## API

All routes are mounted under `/api` (e.g. `POST /api/auth/login`, `GET /api/students`).
Authenticated routes expect `Authorization: Bearer <token>`. Error responses share a common
shape: `{ "error": { "code": "...", "message": "...", "details": {} } }`.

See [`docs/api-contract.md`](docs/api-contract.md) for the full list of endpoints, request/response
shapes, roles, and known MVP limitations (e.g. `POST /auth/login` currently only checks that the
email exists, since `vertice-api` does not yet expose password verification over gRPC).

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
