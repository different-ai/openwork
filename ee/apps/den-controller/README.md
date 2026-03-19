# Den v2 Service

Control plane for hosted workers. Provides Better Auth, worker CRUD, and provisioning hooks.

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm dev
```

## Docker dev stack

For a one-command local stack with MySQL + the Den cloud web app, run this from the repo root:

```bash
./packaging/docker/den-dev-up.sh
```

That brings up:
- local MySQL for Den
- the Den control plane on a randomized host port
- the OpenWork Cloud web app on a randomized host port

The script prints the exact URLs and `docker compose ... down` command to use for cleanup.

## Environment

- `DATABASE_URL` MySQL connection URL
- `BETTER_AUTH_SECRET` 32+ char secret
- `BETTER_AUTH_URL` public base URL Better Auth uses for OAuth redirects and callbacks
- `DEN_BETTER_AUTH_TRUSTED_ORIGINS` optional comma-separated trusted origins for Better Auth origin validation (defaults to `CORS_ORIGINS`)
- `GITHUB_CLIENT_ID` optional OAuth app client ID for GitHub sign-in
- `GITHUB_CLIENT_SECRET` optional OAuth app client secret for GitHub sign-in
- `GOOGLE_CLIENT_ID` optional OAuth app client ID for Google sign-in
- `GOOGLE_CLIENT_SECRET` optional OAuth app client secret for Google sign-in
- `PORT` server port
- `CORS_ORIGINS` comma-separated list of trusted browser origins (used for Better Auth origin validation + Express CORS)
- `PROVISIONER_MODE` `stub`, `render`, or `daytona`
- `OPENWORK_DAYTONA_ENV_PATH` optional path to a shared `.env.daytona` file; when unset, Den searches upwards from the repo for `.env.daytona`
- `WORKER_URL_TEMPLATE` template string with `{workerId}`
- `RENDER_API_BASE` Render API base URL (default `https://api.render.com/v1`)
- `RENDER_API_KEY` Render API key (required for `PROVISIONER_MODE=render`)
- `RENDER_OWNER_ID` Render workspace owner id (required for `PROVISIONER_MODE=render`)
- `RENDER_WORKER_REPO` repository URL used to create worker services
- `RENDER_WORKER_BRANCH` branch used for worker services
- `RENDER_WORKER_ROOT_DIR` render `rootDir` for worker services
- `RENDER_WORKER_PLAN` Render plan for worker services
- `RENDER_WORKER_REGION` Render region for worker services
- `RENDER_WORKER_OPENWORK_VERSION` `openwork-orchestrator` npm version installed in workers; the worker build uses its `opencodeVersion` metadata to bundle a matching `opencode` binary into the Render deploy
- `RENDER_WORKER_NAME_PREFIX` service name prefix
- `RENDER_WORKER_PUBLIC_DOMAIN_SUFFIX` optional domain suffix for worker custom URLs (e.g. `openwork.studio` -> `<worker-id>.openwork.studio`)
- `RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS` max time to wait for vanity URL health before falling back to Render URL
- `RENDER_PROVISION_TIMEOUT_MS` max time to wait for deploy to become live
- `RENDER_HEALTHCHECK_TIMEOUT_MS` max time to wait for worker health checks
- `RENDER_POLL_INTERVAL_MS` polling interval for deploy + health checks
- `VERCEL_API_BASE` Vercel API base URL (default `https://api.vercel.com`)
- `VERCEL_TOKEN` Vercel API token used to upsert worker DNS records
- `VERCEL_TEAM_ID` optional Vercel team id for scoped API calls
- `VERCEL_TEAM_SLUG` optional Vercel team slug for scoped API calls (used when `VERCEL_TEAM_ID` is unset)
- `VERCEL_DNS_DOMAIN` Vercel-managed DNS zone used for worker records (default `openwork.studio`)
- `POLAR_FEATURE_GATE_ENABLED` enable cloud-worker paywall (`true` or `false`)
- `POLAR_API_BASE` Polar API base URL (default `https://api.polar.sh`)
- `POLAR_ACCESS_TOKEN` Polar organization access token (required when paywall enabled)
- `POLAR_PRODUCT_ID` Polar product ID used for checkout sessions (required when paywall enabled)
- `POLAR_BENEFIT_ID` Polar benefit ID required to unlock cloud workers (required when paywall enabled)
- `POLAR_SUCCESS_URL` redirect URL after successful checkout (required when paywall enabled)
- `POLAR_RETURN_URL` return URL shown in checkout (required when paywall enabled)
- Daytona:
  - `DAYTONA_API_KEY` API key used to create sandboxes and volumes
  - `DAYTONA_API_URL` Daytona API base URL (default `https://app.daytona.io/api`)
  - `DAYTONA_TARGET` optional Daytona region/target
  - `DAYTONA_SNAPSHOT` optional snapshot name; if omitted Den creates workers from `DAYTONA_SANDBOX_IMAGE`
  - `DAYTONA_SANDBOX_IMAGE` sandbox base image when no snapshot is provided (default `node:20-bookworm`)
  - `DAYTONA_SANDBOX_CPU`, `DAYTONA_SANDBOX_MEMORY`, `DAYTONA_SANDBOX_DISK` resource sizing when image-backed sandboxes are used
  - `DAYTONA_SANDBOX_AUTO_STOP_INTERVAL`, `DAYTONA_SANDBOX_AUTO_ARCHIVE_INTERVAL`, `DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL` lifecycle controls
  - `DAYTONA_SIGNED_PREVIEW_EXPIRES_SECONDS` TTL for the signed OpenWork preview URL returned to Den clients (Daytona currently caps this at 24 hours)
  - `DAYTONA_SANDBOX_NAME_PREFIX`, `DAYTONA_VOLUME_NAME_PREFIX` resource naming prefixes
  - `DAYTONA_WORKSPACE_MOUNT_PATH`, `DAYTONA_DATA_MOUNT_PATH` volume mount paths inside the sandbox
  - `DAYTONA_RUNTIME_WORKSPACE_PATH`, `DAYTONA_RUNTIME_DATA_PATH`, `DAYTONA_SIDECAR_DIR` local sandbox paths used for the live OpenWork runtime; the mounted Daytona volumes are linked into the runtime workspace under `volumes/`
  - `DAYTONA_OPENWORK_PORT`, `DAYTONA_OPENCODE_PORT` ports used when launching `openwork serve`
  - `DAYTONA_CREATE_TIMEOUT_SECONDS`, `DAYTONA_DELETE_TIMEOUT_SECONDS`, `DAYTONA_HEALTHCHECK_TIMEOUT_MS`, `DAYTONA_POLL_INTERVAL_MS` provisioning timeouts

For local Daytona development, place your Daytona API credentials in `/_repos/openwork/.env.daytona` and Den will pick them up automatically, including from task worktrees.

## Building a Daytona snapshot

If you want Daytona workers to start from a prebuilt runtime instead of a generic base image, create a snapshot and point Den at it.

The snapshot builder for this repo lives at:

- `scripts/create-daytona-openwork-snapshot.sh`
- `ee/apps/den-worker-runtime/Dockerfile.daytona-snapshot`

It builds a Linux image with:

- `openwork-orchestrator`
- `opencode`

Prerequisites:

- Docker running locally
- Daytona CLI installed and logged in
- a valid `.env.daytona` with at least `DAYTONA_API_KEY`

From the OpenWork repo root:

```bash
./scripts/create-daytona-openwork-snapshot.sh
```

To publish a custom-named snapshot:

```bash
./scripts/create-daytona-openwork-snapshot.sh openwork-runtime
```

Useful optional overrides:

- `DAYTONA_SNAPSHOT_NAME`
- `DAYTONA_SNAPSHOT_REGION`
- `DAYTONA_SNAPSHOT_CPU`
- `DAYTONA_SNAPSHOT_MEMORY`
- `DAYTONA_SNAPSHOT_DISK`
- `OPENWORK_ORCHESTRATOR_VERSION`
- `OPENCODE_VERSION`

After the snapshot is pushed, set it in `.env.daytona`:

```env
DAYTONA_SNAPSHOT=openwork-runtime
```

Then start Den in Daytona mode:

```bash
DEN_PROVISIONER_MODE=daytona packaging/docker/den-dev-up.sh
```

If you do not set `DAYTONA_SNAPSHOT`, Den falls back to `DAYTONA_SANDBOX_IMAGE`. That image must already include `openwork` and `opencode` on `PATH`.

## Release automation for snapshots

GitHub workflow `.github/workflows/release-daytona-snapshot.yml` builds and pushes a new Daytona snapshot whenever a GitHub release is published.

- Trigger: `release.published` (or manual `workflow_dispatch`)
- Snapshot naming: `DAYTONA_SNAPSHOT` repo variable if set, otherwise `openwork-runtime-<tag-without-v>`
- Required secret: `DAYTONA_API_KEY`
- Optional repo vars: `DAYTONA_API_URL`, `DAYTONA_TARGET`, `DAYTONA_SNAPSHOT_REGION`, `DAYTONA_SNAPSHOT_NAME_BASE`

## Auth setup (Better Auth)

Generate Better Auth schema (Drizzle):

```bash
npx @better-auth/cli@latest generate --config src/auth.ts --output src/db/better-auth.schema.ts --yes
```

Apply migrations:

```bash
pnpm db:generate
pnpm db:migrate

# or use the SQL migration runner used by Docker
pnpm db:migrate:sql
```

## API

- `GET /health`
- `GET /` demo web app (sign-up + auth + worker launch)
- `GET /v1/me`
- `GET /v1/workers` (list recent workers for signed-in user/org)
- `POST /v1/workers`
  - Cloud launches return `202` quickly with worker `status=provisioning` and continue provisioning asynchronously.
  - Returns `402 payment_required` with Polar checkout URL when paywall is enabled and entitlement is missing.
  - Existing Polar customers are matched by `external_customer_id` first, then by email to preserve access for pre-existing paid users.
- `GET /v1/workers/:id`
  - Includes latest instance metadata when available.
- `POST /v1/workers/:id/tokens`
- `DELETE /v1/workers/:id`
  - Deletes worker records and attempts to tear down the backing cloud runtime when destination is `cloud`.

## CI deployment (dev == prod)

The workflow `.github/workflows/deploy-den.yml` updates Render env vars and deploys the service on every push to `dev` when this service changes.

Required GitHub Actions secrets:

- `RENDER_API_KEY`
- `RENDER_DEN_CONTROL_PLANE_SERVICE_ID`
- `RENDER_OWNER_ID`
- `DEN_DATABASE_URL`
- `DEN_BETTER_AUTH_SECRET`

Optional GitHub Actions secrets (enable GitHub social sign-in):

- `DEN_GITHUB_CLIENT_ID`
- `DEN_GITHUB_CLIENT_SECRET`
- `DEN_GOOGLE_CLIENT_ID`
- `DEN_GOOGLE_CLIENT_SECRET`

Optional GitHub Actions variable:

- `DEN_RENDER_WORKER_PLAN` (defaults to `standard`)
- `DEN_RENDER_WORKER_OPENWORK_VERSION` pins the `openwork-orchestrator` npm version installed in workers; the worker build bundles the matching `opencode` release asset into the Render image
- `DEN_CORS_ORIGINS` (defaults to `https://app.openwork.software,https://api.openwork.software,<render-service-url>`)
- `DEN_BETTER_AUTH_TRUSTED_ORIGINS` (defaults to `DEN_CORS_ORIGINS`)
- `DEN_RENDER_WORKER_PUBLIC_DOMAIN_SUFFIX` (defaults to `openwork.studio`)
- `DEN_RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS` (defaults to `240000`)
- `DEN_BETTER_AUTH_URL` (defaults to `https://app.openwork.software`)
- `DEN_VERCEL_API_BASE` (defaults to `https://api.vercel.com`)
- `DEN_VERCEL_TEAM_ID` (optional)
- `DEN_VERCEL_TEAM_SLUG` (optional, defaults to `prologe`)
- `DEN_VERCEL_DNS_DOMAIN` (defaults to `openwork.studio`)
- `DEN_POLAR_FEATURE_GATE_ENABLED` (`true`/`false`, defaults to `false`)
- `DEN_POLAR_API_BASE` (defaults to `https://api.polar.sh`)
- `DEN_POLAR_SUCCESS_URL` (defaults to `https://app.openwork.software`)
- `DEN_POLAR_RETURN_URL` (defaults to `DEN_POLAR_SUCCESS_URL`)

Required additional secret when using vanity worker domains:

- `VERCEL_TOKEN`
