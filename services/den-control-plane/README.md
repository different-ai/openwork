# Den Control Plane

Control plane for hosted workers. Provides Better Auth, worker CRUD, and provisioning hooks.

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

## Environment

- `DATABASE_URL` MySQL connection URL
- `BETTER_AUTH_SECRET` 32+ char secret
- `BETTER_AUTH_URL` base URL for auth callbacks
- `PORT` server port
- `CORS_ORIGINS` comma-separated list
- `PROVISIONER_MODE` `stub` or `render`
- `WORKER_URL_TEMPLATE` template string with `{workerId}`
- `RENDER_API_BASE` Render API base URL (default `https://api.render.com/v1`)
- `RENDER_API_KEY` Render API key (required for `PROVISIONER_MODE=render`)
- `RENDER_OWNER_ID` Render workspace owner id (required for `PROVISIONER_MODE=render`)
- `RENDER_WORKER_REPO` repository URL used to create worker services
- `RENDER_WORKER_BRANCH` branch used for worker services
- `RENDER_WORKER_ROOT_DIR` render `rootDir` for worker services
- `RENDER_WORKER_PLAN` Render plan for worker services
- `RENDER_WORKER_REGION` Render region for worker services
- `RENDER_WORKER_OPENWORK_VERSION` `openwork-orchestrator` npm version installed in workers
- `RENDER_WORKER_NAME_PREFIX` service name prefix
- `RENDER_PROVISION_TIMEOUT_MS` max time to wait for deploy to become live
- `RENDER_HEALTHCHECK_TIMEOUT_MS` max time to wait for worker health checks
- `RENDER_POLL_INTERVAL_MS` polling interval for deploy + health checks

## Auth setup (Better Auth)

Generate Better Auth schema (Drizzle):

```bash
npx @better-auth/cli@latest generate --config src/auth.ts --output src/db/better-auth.schema.ts --yes
```

Apply migrations:

```bash
pnpm db:generate
pnpm db:migrate
```

## API

- `GET /health`
- `GET /` demo web app (sign-up + auth + worker launch)
- `GET /v1/me`
- `POST /v1/workers`
- `GET /v1/workers/:id`
- `POST /v1/workers/:id/tokens`

## CI deployment (dev == prod)

The workflow `.github/workflows/deploy-den-control-plane.yml` updates Render env vars and deploys the service on every push to `dev` when this service changes.

Required GitHub Actions secrets:

- `RENDER_API_KEY`
- `RENDER_DEN_CONTROL_PLANE_SERVICE_ID`
- `RENDER_OWNER_ID`
- `DEN_DATABASE_URL`
- `DEN_BETTER_AUTH_SECRET`

Optional GitHub Actions variable:

- `DEN_RENDER_WORKER_OPENWORK_VERSION` (defaults to `0.11.113`)
