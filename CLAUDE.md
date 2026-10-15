# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

IMCR (Intelligent Message Classifier & Router): customer messages are classified by an LLM (sector, sentiment, urgency, confidence) and shown on a live Kanban board. The product spec is in `.specs/especifica_o_t_cnica_imcr.md`; `.specs/qa-report.md` has QA findings and fix status. UI text, comments and error messages are in pt-BR.

Monorepo with no root `package.json`: `frontend/` (Vite + React 19 + TanStack Query + Tailwind v4) and `backend/` (Fastify + Drizzle/Postgres + BullMQ/Redis), run independently.

## Commands

Frontend (`cd frontend`):
- `npm run dev` (port 5173; `/api` proxied to `localhost:3000`), `npm run build`, `npm run typecheck` (`tsc -b`), `npm run lint` (oxlint), `npm test`
- single test: `npx vitest run src/lib/sse.test.ts` or `npx vitest run -t "part of test name"`

Backend (`cd backend`):
- `npm run dev` (API) and `npm run dev:worker` (both read `backend/.env` if present), `npm run typecheck`, `npm run build`
- `npm test` runs everything; unit only: `npx vitest run test/unit`; one file: `npx vitest run test/unit.llm.test.ts`
- `npm run db:generate` after editing `src/db/schema.ts`; migrations in `drizzle/` are applied by the API at startup (`runMigrations`)
- `npm run llm:check` (one real LLM call) and `npm run eval` (labeled cases in `eval/cases.json`, results in the gitignored `eval/results/`)

Full stack: the compose file is named `podman-compose.yaml`, so always pass `-f`:
`podman compose -f podman-compose.yaml up -d --build` (postgres, redis, `app-backend` on :3000, `worker`). Rebuild `app-backend worker` after backend changes.

CI (`.github/workflows/ci.yml`, Node 22): frontend runs lint → typecheck → test → build; backend runs typecheck → build → test against Postgres 18 and Redis service containers with `LLM_PROVIDER=fake`. Run the same sequence locally before pushing.

## Architecture

**Message flow.** `POST /api/messages` inserts a `PENDING` row, publishes `message.created`, enqueues a BullMQ job (jobId = message id). The worker (`entrypoints/worker.ts` → `worker/processor.ts`) sets `PROCESSING`, calls the `LlmClassifier`, applies `routeSector` (confidence below `CONFIDENCE_THRESHOLD` → `HUMAN_REVIEW`), stores the result with the classifier name, then `COMPLETED`. Every state change is published on the Redis channel `imcr:events`; the API relays it to browsers over SSE (`/api/events`, event names `message.created` / `message.updated`, plus a named `ping` every 15 s). API and worker are separate processes sharing `src/`; only the worker needs LLM credentials.

**Failure rules.** Jobs retry 3 times with exponential backoff. `shouldMarkFailed` marks `FAILED` when attempts are exhausted **or** the error is a BullMQ `UnrecoverableError` (the Anthropic adapter maps 400/401/403/404 to it); the worker's `failed` listener and the integration harness must use that same function.

**LLM adapters** (`backend/src/llm/`): `LlmClassifier` interface (`name` is persisted in `messages.classifier` and exposed as DTO `model`); `fake` (keyword heuristic, default, used by tests/CI), `anthropic` (forced tool call whose input schema is derived from the Zod `ClassificationSchema`), `gemini` (plain `fetch` against `v1beta/models/{model}:generateContent`, structured output via `generationConfig.responseSchema` derived from the same Zod schema), `ollama`. Chosen by `LLM_PROVIDER`; the system prompt in `prompt.ts` defines the urgency/confidence scoring that drives routing, so change it together with `eval/cases.json`.

**Resolved vs status.** "Resolved" is `resolvedAt`, orthogonal to `status` (only `COMPLETED` messages can be resolved; resolve/reopen are idempotent POSTs). Frontend `columnFor` (`src/lib/sectors.ts`) is the single place mapping a message to a column: resolved → `RESOLVED`; `CRITICAL` sentiment or `HUMAN_REVIEW` sector → `URGENT`; unclassified → "Em triagem". A human correction (`correctedSector`) overrides the AI sector; AI accuracy = `1 - corrected / completed`.

**Contract is duplicated, not shared.** Zod schemas exist in both `backend/src/schemas/api.ts` and `frontend/src/lib/schemas.ts`; adding a field means editing both, the Drizzle schema + migration, `toDto`, and every `Message`/`MessageRow` test fixture.

**Frontend data layer.** Messages live in the TanStack Query cache (`messagesKey`), fed by both HTTP responses and SSE events through `applyEvent` (`hooks/useMessages.ts`). Updates arrive in no guaranteed order, so `applyEvent` never replaces a message with one of a lower status rank (PENDING < PROCESSING < COMPLETED/FAILED); do not bypass it. `lib/sse.ts` reopens the stream after 45 s without events and `useRealtime` refetches after a reconnect.

**Mock mode.** `VITE_USE_MOCKS` defaults to on: MSW handlers + an in-memory simulator (`src/mocks/`) replace the backend, and `sse.ts` subscribes to the simulator directly instead of `EventSource`. `frontend/.env.development.local` sets it to `false` to use the real backend.

## Production (Railway)

Dev uses the compose stack; production runs on Railway (project `triagem`, environment `production`): Postgres and Redis plus three services that have no GitHub source. There is no `railway.toml` (Config as Code is deprecated by Railway).

**Deploy is done by GitHub Actions**, not by Railway's GitHub integration: the `deploy` job in `ci.yml` runs only on push to `main`, after the frontend and backend jobs pass, and calls `railway up <dir> --path-as-root --service <name> --ci` in the order api → worker → frontend (secret `RAILWAY_TOKEN`, a Project Token for `production`). `--path-as-root` uploads only `backend/` or `frontend/`, so no Root Directory is set in Railway. Do not connect a repo to the services, or every push deploys twice.

- `api`: variable `RAILWAY_DOCKERFILE_PATH=Containerfile` (Railway only auto-detects a file named `Dockerfile`), healthcheck path `/health`, public domain. Migrations run at startup.
- `worker`: same Containerfile, custom start command `node dist/entrypoints/worker.js`, no public domain, healthcheck off. Deploy it after `api` has migrated. Only this service gets the active LLM provider's API key (currently `GEMINI_API_KEY`, production runs `LLM_PROVIDER=gemini`); `ANTHROPIC_API_KEY` is only needed if switching back to `anthropic`.
- `frontend`: `frontend/Containerfile` (Vite build, then nginx serving `dist` with SPA fallback on `$PORT`). `VITE_API_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}` and `VITE_USE_MOCKS=false` are service variables, consumed as build args.
- Healthcheck path and start command are set through the GraphQL API (`railway api`, mutation `serviceInstanceUpdate`), because the CLI has no command for them.
- Variables on `api` and `worker`: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `REDIS_URL=${{Redis.REDIS_URL}}`, `LLM_PROVIDER`. On `api`, `CORS_ORIGIN=https://${{frontend.RAILWAY_PUBLIC_DOMAIN}}`. Railway injects `PORT`, which `config.ts` already reads. Use the exact service names in the references.
- Railway Postgres has no pooler, so there is a single `DATABASE_URL`. `DB_POOL_MAX` caps the pool per process.

## Gotchas

- `api.ts` only sends `Content-Type: application/json` when there is a body: Fastify answers 400 to an empty body with that header (resolve/reopen send none).
- Backend integration tests need Postgres and Redis up; they use database `routing_test` and Redis db 1 (never the dev data) and skip themselves when the services are down. `app.close()` waits for open SSE connections, so abort clients before restarting the API in tests.
- Frontend tests: Radix Select does not work in jsdom (component tests swap in a native `<select>`); `MessageCard.hidden.test.tsx` kills `requestAnimationFrame` on purpose to simulate a hidden tab (card exit animation is disabled while `document.hidden`).
- `ANTHROPIC_API_KEY` goes only in an untracked `.env` (repo root for compose, `backend/.env` for local scripts). The compose file passes it to `worker` only.
- Frontend tests always run in mock mode: Vitest does not load `.env.development.local`, so `App.integration.test.tsx` exercises MSW + the simulator, never the real backend. State of the simulator is module-level and shared by the tests of that file, so their order matters.
- The worker must start only after the API has migrated the database (the API runs migrations, the worker does not): compose enforces it with the `app-backend` healthcheck and `depends_on: service_healthy`. Keep both when editing `podman-compose.yaml`.
- API validation errors are `{ error: 'Dados inválidos', details }` in Portuguese: `server.ts` sets a global `z.config(z.locales.pt())` and a custom error handler. Shape new error responses as `{ error }`.
- The real Anthropic path has not been run against the live API with a valid key yet (only mocks and a deliberately invalid key). Confirm with `npm run llm:check`, then `npm run eval`, before trusting prompt or schema changes.
- Browser automation opens the tab with `document.visibilityState === 'hidden'`: `requestAnimationFrame` is paused, so animations never finish and screenshots can look stale. Verify through the DOM and the API, not by waiting for animations.
- Vite hot reload can interrupt a long `javascript_exec` in the browser tool ("Inspected target navigated"); reload the page and run it again.
- On Windows, `curl` with accented JSON in the command line breaks `Content-Length`; send a UTF-8 file with `--data-binary @file`.
