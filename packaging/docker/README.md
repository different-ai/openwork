# OpenWork Host (Docker)

## Den local stack (Docker)

One command for the Den control plane, local MySQL, and the cloud web app.

From the repo root:

```bash
./packaging/docker/den-dev-up.sh
```

Or via pnpm:

```bash
pnpm dev:den-docker
```

What it does:
- Starts **MySQL** for the Den service
- Starts **Den control plane** on port 8788 inside Docker with `PROVISIONER_MODE=stub`
- Runs **Den migrations** automatically before the API starts in the local compose stack
- Starts the **OpenWork Cloud web app** on port 3005 inside Docker
- Points the web app's auth + API proxy routes at the local Den service
- Prints randomized host URLs so multiple stacks can run side by side

Production-oriented EE images:
- `Dockerfile.den` -> `ghcr.io/different-ai/openwork-den-api`
- `Dockerfile.den-web` -> `ghcr.io/different-ai/openwork-den-web`
- `Dockerfile.inference` -> `ghcr.io/different-ai/openwork-inference`

These images are intended for Terraform, Helm, ECS, EKS, and customer-cloud deployments. Prefer immutable tags or digests in production.

Publish flow:
- Release tags like `v0.17.1` publish images tagged `v0.17.1`, `0.17.1`, `sha-<commit>`, and `latest`.
- The same workflow publishes the Helm chart to `oci://ghcr.io/different-ai/charts/openwork-ee` with chart version `0.17.1`.
- Manual publishes from a branch require `push=true` and an explicit `chart_version`.

Health and smoke expectations:
- Published service images include shallow Docker healthchecks for the HTTP process only.
- Den API and inference probe `GET /health`; Den web probes `GET /api/health`.
- The publish workflow loads each PR image locally and probes the same endpoint without cloud secrets. Production orchestrators should still add dependency-aware readiness checks where needed.

### Demo org seed

After the Den DB is running, seed a full local demo org with users, teams, pending invites, and imported plugin data from `anthropics/knowledge-work-plugins`:

```bash
pnpm dev:den:seed-demo
```

The seed is local/dev-only, idempotent for the `acme-robotics-demo` org, and does not create workers or live integrations. It imports plugin marketplace rows, plugin rows, access grants, and config objects so plugin pages look populated without connecting external services.

Default demo login:

- Email: `alex@acme.test`
- Password: `OpenWorkDemo123!`

For the Docker stack with randomized MySQL ports, source the printed runtime env file first and pass `DEN_MYSQL_URL` as `DATABASE_URL`:

```bash
source tmp/.den-dev-env-<id>
DATABASE_URL="$DEN_MYSQL_URL" pnpm dev:den:seed-demo
```

Set `DEN_DEMO_SEED_FETCH_GITHUB=0` to skip live GitHub source fetching and use built-in plugin fallbacks only.

Useful commands:
- Logs: `docker compose -p <project> -f packaging/docker/docker-compose.den-dev.yml logs`
- Tear down: `docker compose -p <project> -f packaging/docker/docker-compose.den-dev.yml down`
- Tear down + reset DB: `docker compose -p <project> -f packaging/docker/docker-compose.den-dev.yml down -v`

Optional env vars (via `.env` or `export`):
- `DEN_API_PORT` — host port to map to the Den control plane :8788
- `DEN_WEB_PORT` — host port to map to the cloud web app :3005
- `DEN_BETTER_AUTH_SECRET` — Better Auth secret (auto-generated if unset)
- `DEN_PUBLIC_HOST` — host name/IP used for default auth URL + printed LAN/public URLs (defaults to your machine hostname)
- `DEN_BETTER_AUTH_URL` — browser-facing auth base URL (defaults to `http://$DEN_PUBLIC_HOST:<DEN_WEB_PORT>`)
- `DEN_MCP_RESOURCE_URL` — API-facing MCP resource URL (defaults to `http://localhost:<DEN_API_PORT>/mcp`)
- `DEN_MCP_ADDITIONAL_RESOURCES` — extra public MCP resource URLs beyond the `DEN_API_PUBLIC_URL` API origin and web-app defaults
- `DEN_ENABLE_ENTERPRISE_MCP_CLIENT` — set to `true` to enable the additive `@openwork/enterprise-mcp-client` Den runtime (defaults to `false`)
- `DEN_BETTER_AUTH_TRUSTED_ORIGINS` — trusted origins for Better Auth (defaults to `DEN_CORS_ORIGINS`)
- `DEN_CORS_ORIGINS` — trusted origins for Express CORS (defaults include hostname, localhost, `127.0.0.1`, `0.0.0.0`, and detected LAN IPv4)
- `DEN_PROVISIONER_MODE` — `stub` or `render` (defaults to `stub`)
- `DEN_WORKER_URL_TEMPLATE` — stub worker URL template with `{workerId}` placeholder

### Live OpenTelemetry Docker validation

`docker-compose.otel-lgtm.yml` adds Grafana's all-in-one development backend
(Grafana, Tempo, Loki, Prometheus, Pyroscope, and an OTLP receiver) to the Den
Docker stack. The image is pinned to `0.11.16` and its multi-arch digest.

Start only the collector/UI stack:

```bash
docker compose -f packaging/docker/docker-compose.otel-lgtm.yml up -d --wait
docker compose -f packaging/docker/docker-compose.otel-lgtm.yml ps
curl -fsS http://127.0.0.1:3000/api/health
```

Run the reproducible live E2E validator (the script resolves paths relative to
itself, so absolute-path invocations work from any working directory):

```bash
bash packaging/docker/otel-hono-live-validate.sh
```

The validator merges `docker-compose.den-dev.yml` and
`docker-compose.otel-lgtm.yml`, configures both Den services for OTLP/HTTP,
builds and starts the stack, waits for health, and makes a real request to
`/api/den/openapi.json?token=super-secret`. It then polls Grafana's Tempo,
Loki, and Prometheus datasource proxy APIs with a bounded timeout. The JSON
report proves the connected `den-web` → `den-api` trace, normalized Hono route
and request ID, secret redaction, correlated Den Web and Den API OTLP request
logs, Hono duration and active-request metric series, and absence of unhandled
runtime errors.

After the OTEL phase passes, the same validator recreates only `den` and `web`
with `DEN_OBSERVABILITY_BACKEND=none` while keeping MySQL and LGTM running. It
makes the same proxy request and records proof that the app still returns HTTP
200, request logs are structured JSON stdout for both services, and no exporter
connection/error attempt appears in the none-backend runtime logs.

Defaults use a unique Compose project and process-derived high host ports, so
parallel runs do not share state. Useful controls:

```bash
KEEP_STACK=1 bash packaging/docker/otel-hono-live-validate.sh  # keep containers (left in none mode after the final phase)
OTEL_HONO_PROJECT=<previous-project> SKIP_BUILD=1 bash packaging/docker/otel-hono-live-validate.sh
OTEL_HONO_PORT_BASE=42000 bash packaging/docker/otel-hono-live-validate.sh
OTEL_HONO_REPORT_JSON=/tmp/otel-proof.json bash packaging/docker/otel-hono-live-validate.sh
```

Individual host ports remain overridable with `DEN_WEB_PORT`, `DEN_API_PORT`,
`DEN_MYSQL_PORT`, `OTEL_LGTM_GRAFANA_PORT`,
`OTEL_LGTM_OTLP_GRPC_PORT`, and `OTEL_LGTM_OTLP_HTTP_PORT`. Override
`OTEL_HONO_PROJECT`, `OTEL_HONO_POLL_SECONDS`, or
`OTEL_HONO_COMPOSE_WAIT_SECONDS` when a stable project or different bounded
timeouts are needed. The default report is
`tmp/otel-hono-live-<project>/report.json`.

Open Grafana at `http://127.0.0.1:3000` and log in with `admin` / `admin`. Use Explore with the pre-provisioned Tempo, Loki, and Prometheus data sources for traces, logs, and metrics.

To start the same merged stack manually:

```bash
DEN_OBSERVABILITY_BACKEND=otel \
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318 \
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://otel-lgtm:4318/v1/traces \
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://otel-lgtm:4318/v1/metrics \
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://otel-lgtm:4318/v1/logs \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_TRACES_EXPORTER=otlp \
OTEL_METRICS_EXPORTER=otlp \
OTEL_LOGS_EXPORTER=otlp \
OTEL_TRACES_SAMPLER=parentbased_always_on \
docker compose -p openwork-den-otel \
  -f packaging/docker/docker-compose.den-dev.yml \
  -f packaging/docker/docker-compose.otel-lgtm.yml \
  up --build --wait
```

Run the services outside Docker against the same local receiver:

```bash
docker compose -f packaging/docker/docker-compose.otel-lgtm.yml up -d --wait

DEN_OBSERVABILITY_BACKEND=otel \
OTEL_SERVICE_NAME=den-api \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
pnpm dev:den:api

DEN_OBSERVABILITY_BACKEND=otel \
OTEL_SERVICE_NAME=den-web \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
pnpm dev:den:web
```

Useful signal controls:

```bash
OTEL_TRACES_EXPORTER=none    # disable traces
OTEL_METRICS_EXPORTER=none   # disable metrics
OTEL_LOGS_EXPORTER=none      # disable logs
OTEL_TRACES_SAMPLER=parentbased_traceidratio OTEL_TRACES_SAMPLER_ARG=0.25
```

`docker-compose.den-dev.yml` forwards the full OTLP runtime surface to both Den
services: base and per-signal endpoints, base and per-signal protocol values,
headers, per-signal exporters, and sampler settings. It also forwards runtime
Sentry settings (`SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`,
`SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, and `SENTRY_DIST`) while keeping
distinct `OTEL_SERVICE_NAME` defaults for Den API and Den Web.

Sentry source-map upload is build-time only. Runtime Compose and Helm settings
cannot upload maps after the image is built. The Dockerfiles default their
upload flags to `0`, so normal builds and PR builds skip Sentry secret reads
cleanly. To opt in for a trusted build, pass only non-secret upload flags as
build args and pass credentials as BuildKit secrets; never pass Sentry
credentials through `ARG`, `ENV`, or Compose runtime env.

For custom Den API images, `DEN_UPLOAD_SENTRY_SOURCEMAPS=1` requires
`sentry_auth_token`, `sentry_org`, `sentry_project`, and `sentry_release`.
`sentry_url` and `sentry_dist` are optional:

```bash
SENTRY_AUTH_TOKEN=... SENTRY_ORG=... SENTRY_PROJECT=... \
SENTRY_RELEASE=2026.07.11 SENTRY_DIST=den-api \
docker buildx build \
  -f packaging/docker/Dockerfile.den \
  --build-arg DEN_UPLOAD_SENTRY_SOURCEMAPS=1 \
  --secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
  --secret id=sentry_org,env=SENTRY_ORG \
  --secret id=sentry_project,env=SENTRY_PROJECT \
  --secret id=sentry_release,env=SENTRY_RELEASE \
  --secret id=sentry_dist,env=SENTRY_DIST \
  -t openwork-den-api:sentry .
```

For custom Den Web images, `DEN_WEB_UPLOAD_SENTRY_SOURCEMAPS=1` requires
`sentry_auth_token`, `sentry_org`, and `sentry_project`. `sentry_url`,
`sentry_release`, and `sentry_dist` are optional. The Dockerfile exports the
upload flag and secrets only inside the build step; runtime Sentry still
requires its own runtime environment configuration:

```bash
SENTRY_AUTH_TOKEN=... SENTRY_ORG=... SENTRY_PROJECT=... \
SENTRY_RELEASE=2026.07.11 SENTRY_DIST=den-web SENTRY_URL=... \
docker buildx build \
  -f packaging/docker/Dockerfile.den-web \
  --build-arg DEN_WEB_UPLOAD_SENTRY_SOURCEMAPS=1 \
  --secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
  --secret id=sentry_org,env=SENTRY_ORG \
  --secret id=sentry_project,env=SENTRY_PROJECT \
  --secret id=sentry_url,env=SENTRY_URL \
  --secret id=sentry_release,env=SENTRY_RELEASE \
  --secret id=sentry_dist,env=SENTRY_DIST \
  -t openwork-den-web:sentry .
```

The EE image publish workflow never passes repository Sentry secrets to
`pull_request` builds. On trusted publish events, it checks for the complete
configuration for each image and uses the Sentry upload build only for that
configured image; otherwise it publishes the normal image without failing the
release. Generic prebuilt images cannot perform source-map uploads for a
deployment-specific Sentry project after publication.

Caveats: `grafana/otel-lgtm` is intended for development, demos, and tests, not production retention or security. The default Grafana credentials are public, and the digest should be refreshed deliberately when updating the image tag. Upstream images are signed with cosign; see the `grafana/docker-otel-lgtm` README if you need signature verification in CI.

### Install links (self-host)

Run the install-link migration once against the Den database:

```bash
docker compose -f packaging/docker/docker-compose.den-dev.yml exec den sh -lc "node /app/ee/packages/den-db/dist/scripts/bootstrap.js"
```

Set `DEN_BOOTSTRAP_ADMIN_EMAILS` on the Den API service, restart it, open `/admin`, and toggle `Install links` for each org. Optional installer artifact env vars are `OPENWORK_INSTALLER_RELEASE_TAG`, `OPENWORK_INSTALLER_RELEASE_REPO`, and `OPENWORK_INSTALLER_ARTIFACTS_DIR`; see the [operator guide](../../docs/org-install-links.md).

### Faster inner-loop alternative

If you are iterating on Den locally and do not need the full Dockerized web stack, use the hybrid path instead:

From the OpenWork repo root:

```bash
pnpm dev:den
```

Or from the OpenWork enterprise root:

```bash
pnpm --dir _repos/openwork dev:den
```

What it does:
- Starts only **MySQL** in Docker
- Runs **Den controller** locally in watch mode
- Runs **OpenWork Cloud web app** locally in Next.js dev mode
- Reuses the existing local-dev wiring in `scripts/dev-web-local.sh`

This is usually the fastest path for UI/auth/control-plane iteration because it avoids rebuilding the Docker web image on each boot.

If you want to run the pieces in separate terminals, use the root package scripts:

```bash
pnpm dev:den:mysql
pnpm dev:den:db-push
pnpm dev:den:api
pnpm dev:den:web
```

The split API/web flow defaults to Den API on `http://localhost:8790` and Den web on `http://localhost:3005`. Stop the local MySQL container with:

```bash
pnpm dev:den:mysql:down
```

---

## Pre-baked Micro-Sandbox Image

For micro-sandbox work, use the pre-baked image that compiles `openwork` and `openwork-server` from source and downloads the pinned `opencode` binary during `docker build`.

Build it from the repo root:

```bash
./scripts/build-microsandbox-openwork-image.sh
```

Run it locally:

```bash
docker run --rm -p 8787:8787 \
  -e OPENWORK_CONNECT_HOST=127.0.0.1 \
  openwork-microsandbox:dev
```

Defaults:
- `OPENWORK_TOKEN=microsandbox-token`
- `OPENWORK_HOST_TOKEN=microsandbox-host-token`
- `OPENWORK_APPROVAL_MODE=auto`

Verification:
- Health: `curl http://127.0.0.1:8787/health`
- Authenticated API call: `curl -H "Authorization: Bearer microsandbox-token" http://127.0.0.1:8787/workspaces`
- Docker health: `docker inspect --format '{{json .State.Health}}' <container>`

Useful overrides:
- `OPENWORK_TOKEN` — set your own client bearer token
- `OPENWORK_HOST_TOKEN` — set your own host/admin token
- `OPENWORK_CONNECT_HOST` — host name embedded in the printed connect URL
- `DOCKER_PLATFORM` — optional platform passed to `docker build`

---

## Production container

This is a minimal packaging template to run the OpenWork Host contract in a single container.

It runs:

- `opencode serve` (engine) bound to `127.0.0.1:4096` inside the container
- `openwork-server` published on `0.0.0.0:8787` via an explicit `--remote-access` launch path (the only published surface)

### Local run (compose)

From this directory:

```bash
docker compose up --build
```

Then open:

- `http://127.0.0.1:8787/ui`

### Config

Recommended env vars:

- `OPENWORK_TOKEN` (client token)
- `OPENWORK_HOST_TOKEN` (host/owner token)

Optional:

- `OPENWORK_APPROVAL_MODE=auto|manual`
- `OPENWORK_APPROVAL_TIMEOUT_MS=30000`

Persistence:

- Workspace is mounted at `/workspace`
- Host data dir is mounted at `/data` (OpenCode caches + OpenWork server config/tokens)

### Notes

- OpenCode is not exposed directly; access it via the OpenWork proxy (`/opencode/*`).
- For PaaS, replace `./workspace:/workspace` with a volume or a checkout strategy (git clone on boot).
