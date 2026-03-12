# Den Service

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
- `BETTER_AUTH_URL` public base URL Better Auth uses for OAuth redirects and callbacks
- `GITHUB_CLIENT_ID` optional OAuth app client ID for GitHub sign-in
- `GITHUB_CLIENT_SECRET` optional OAuth app client secret for GitHub sign-in
- `GOOGLE_CLIENT_ID` optional OAuth app client ID for Google sign-in
- `GOOGLE_CLIENT_SECRET` optional OAuth app client secret for Google sign-in
- `PORT` server port
- `CORS_ORIGINS` comma-separated list of trusted browser origins (used for Better Auth origin validation + Express CORS)
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
- `GET /v1/workers` (list recent workers for signed-in user/org)
- `POST /v1/workers`
  - Cloud launches return `202` quickly with worker `status=provisioning` and continue provisioning asynchronously.
  - Returns `402 payment_required` with Polar checkout URL when paywall is enabled and entitlement is missing.
  - Existing Polar customers are matched by `external_customer_id` first, then by email to preserve access for pre-existing paid users.
- `GET /v1/workers/:id`
  - Includes latest instance metadata when available.
- `POST /v1/workers/:id/tokens`
- `DELETE /v1/workers/:id`
  - Deletes worker records and attempts to suspend the backing cloud service when destination is `cloud`.

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
- `DEN_RENDER_WORKER_OPENWORK_VERSION` (defaults to `0.11.113`)
- `DEN_CORS_ORIGINS` (defaults to `https://app.openwork.software,https://api.openwork.software,<render-service-url>`)
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
