# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`vertice-bff` is a Backend-for-Frontend: a Fastify HTTP/JSON API that sits between `vertice-web-react` (frontend) and `vertice-api` (a Spring Boot service exposed only over gRPC on `:9090`). It does not own any data itself — every route handler ultimately calls a gRPC method on `vertice-api` and reshapes the response for the frontend. There is no database, ORM, or ODM in this repo.

Sibling repos (as local checkouts, e.g. `../vertice-api`, `../vertice-web-react`):
1. `vertice-api` — `docker compose up -d` (postgres), then `./gradlew bootRun --args='--spring.profiles.active=local'` (gRPC on `:9090`, auth disabled locally).
2. `vertice-bff` (this repo) — `cp .env.example .env && npm install && npm run dev` (REST on `:3000`).
3. `vertice-web-react` — `npm run dev` (Next.js App Router, default `:3000` — **same default port as this BFF**; override one of them, e.g. `PORT=3000` here is already taken, so run this BFF on its default and start Next with `npm run dev -- -p <other-port>`, or vice versa). Replaces the old Vue-based `vertice-web`, which is deprecated. It's currently a skeleton with no features implemented yet, so the two aren't wired together in practice.

## Commands

- `npm run dev` — run with hot reload (tsx watch)
- `npm run dev:docker` — same, but with polling-based file watching (for Docker Desktop bind mounts where inotify doesn't propagate)
- `npm run build` / `npm start` — compile to `dist/` and run the compiled output
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint (flat config, `eslint.config.js`, typescript-eslint recommended rules)
- `npm test` — Vitest (`vitest run`); no test files exist yet, so this currently passes trivially
- `docker build .` / the provided `Dockerfile` — containerized dev, runs `npm run dev:docker`

There's no single-test-file invocation documented yet since the suite is empty; once tests exist, standard Vitest filtering (`vitest run path/to/file.test.ts` or `-t "name"`) applies.

## Architecture

**Request flow:** `src/server.ts` boots `buildApp()` from `src/app.ts`, which registers (in order) CORS, the global error handler, the auth plugin, then every feature module's routes under `/api`. Each module is self-contained:

- `routes.ts` — Fastify route registration, param parsing (`parseId`), auth/role hooks, calls into `service.ts`. Route handlers stay thin: parse → authorize → delegate → return.
- `schemas.ts` — Zod schemas for request bodies, parsed explicitly in route handlers (`schema.parse(req.body)`), not via a Fastify validation hook.
- `service.ts` — business logic, gRPC calls, and response shaping. This is where cross-module composition happens (e.g. `clients/service.ts` pulls from `users`, `training-plans`, and `workout-sessions` services to build a roster view).

Not every module has all three files — `users` and `dashboard` are read/compose-only and have no `routes.ts`/`schemas.ts` of their own where unneeded.

**gRPC bridge** (`src/grpc/`):
- `loadProto.ts` loads all `.proto` files under `protos/vertice/**` via `@grpc/proto-loader` into `grpcProto`, a dynamically-shaped object with no static type (hence the `as any` at its export — services are consumed through the concrete clients below, not through this object directly).
- `clients.ts` instantiates one gRPC client per service (`userClient`, `exerciseClient`, `trainingPlanClient`, `workoutClient`, `workoutExerciseClient`, `exerciseSetClient`, `workoutSessionClient`, `workoutFeedbackClient`, `trainerClientClient`) against `grpcTarget` (from `env.VERTICE_API_GRPC_HOST`/`PORT`), using insecure credentials (vertice-api runs without TLS locally).
- `call.ts` exports `grpcCall(client, method, request, metadata?)`, which promisifies grpc-js's callback API and maps gRPC status codes to `HttpError` subclasses (`NOT_FOUND`→404, `INVALID_ARGUMENT`/`FAILED_PRECONDITION`→400, `ALREADY_EXISTS`→409, `UNAUTHENTICATED`→401, `PERMISSION_DENIED`→403, `UNAVAILABLE`→503, else 502). Every service function funnels through this.

To add a new proto: drop the `.proto` file under `protos/`, add its path to `PROTO_FILES` in `loadProto.ts`, and instantiate a client for it in `clients.ts`.

**Auth** (`src/plugins/authenticate.ts`, `src/lib/jwt.ts`): JWTs are signed/verified by the BFF itself (`JWT_SECRET`), not by vertice-api. `app.authenticate` (decorated onto the Fastify instance) verifies the bearer token and sets `req.user: AuthUser {id, name, email, role}`. `app.requireRole(...roles)` gates by role (`ADMIN` | `TRAINER` | `CLIENT`). Both are applied as `preHandler` hooks per-module, not globally — `/health` and `/api/auth/*` are intentionally unauthenticated. **Known MVP limitation:** `POST /auth/login` only checks that the email exists — vertice-api's gRPC surface has no password-verification RPC yet, so any password is accepted for an existing account.

**Ownership/scoping** (`src/lib/ownership.ts`): beyond role checks, several resources need per-record ownership checks (a client can only touch their own plan; a trainer only their own client's). `assertOwnsPlan`, `assertOwnsWorkout`, `assertOwnsWorkoutExercise` walk up from a resource to its owning `TrainingPlan` and check `trainerId`/`clientId` against the requesting user (ADMIN bypasses). The **trainer↔client relationship itself** is not derivable from `User` or `TrainingPlan` — it's sourced from vertice-api's `TrainerClientService` (see `clients/service.ts`'s `assertIsTrainersClient`), which is the source of truth for "is this client one of this trainer's clients."

**Composed/aggregate endpoints:** several routes exist specifically to save the frontend from orchestrating multiple calls — `GET /clients` (roster with plan/activity enrichment), `GET /clients/:id/overview` (client-detail header stats incl. an approximated 4-week adherence %), `GET /workouts/:id/full`, `GET /workouts/:workoutId/session` (auto-starts/resumes the week's log and merges in last-performed set values), and `GET /dashboard`. These exist because vertice-api's gRPC surface is narrow (e.g. `ListWorkoutLogs` is scoped to one `trainingPlanId` + one `weekStartDate` — there's no general history query), so service functions often approximate or re-fetch across a small date window rather than there being a matching upstream RPC. When touching these, read the surrounding comments in the service file first — they document exactly which upstream limitation is being worked around and why the approximation is shaped the way it is.

**Error handling:** all errors are `HttpError` subclasses (`src/lib/errors.ts`: `NotFoundError`, `ConflictError`, `UnauthorizedError`, `ForbiddenError`, `ValidationError`), thrown from anywhere (routes or services) and caught by the global handler (`src/plugins/error-handler.ts`), which also maps `ZodError` and Fastify's own validation errors to the same `{ error: { code, message, details } }` shape. Don't `reply.send()` an error response manually — throw instead.

**Config** (`src/config/env.ts`): all env vars are parsed once through a Zod schema at import time (`env`); there's no other place reading `process.env` directly for app config. `grpcTarget` is derived here too.

## Current module layout

`auth`, `clients` (trainer's roster of CLIENT users — recently replaced a `students` module; sourced via `TrainerClientService`, not derived from training plans), `dashboard`, `exercises`, `exercise-sets`, `training-plans`, `users` (shared `User` type/mapping, no own routes), `workouts`, `workout-exercises`, `workout-sessions` (also owns `/workout-logs` and `/workout-sessions/:id/{sets,complete}`), `feedback`.

## Reference doc

`docs/api-contract.md` documents the full REST surface (request/response shapes, role requirements, and the same upstream-limitation notes as the code comments) and is generally reliable for endpoint-level detail — but it predates the `students`→`clients` rename and still refers to a `/students` route; treat anything mentioning `/students` there as referring to what is now `/clients`.
