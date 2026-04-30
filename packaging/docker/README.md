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
- Runs **Den migrations** automatically before the API starts
- Starts the **OpenWork Cloud web app** on port 3005 inside Docker
- Points the web app's auth + API proxy routes at the local Den service
- Prints randomized host URLs so multiple stacks can run side by side

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
- `DEN_BETTER_AUTH_TRUSTED_ORIGINS` — trusted origins for Better Auth (defaults to `DEN_CORS_ORIGINS`)
- `DEN_CORS_ORIGINS` — trusted origins for Express CORS (defaults include hostname, localhost, `127.0.0.1`, `0.0.0.0`, and detected LAN IPv4)
- `DEN_PROVISIONER_MODE` — `stub` or `render` (defaults to `stub`)
- `DEN_WORKER_URL_TEMPLATE` — stub worker URL template with `{workerId}` placeholder

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
