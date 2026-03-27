# OpenWork Host (Docker)

## Dev testability stack (recommended for testing)

One command, no custom Dockerfile. Uses `node:22-bookworm-slim` off the shelf.

From the repo root:

```bash
./packaging/docker/dev-up.sh
```

Then open the printed Web UI URL (ports are randomized so you can run multiple stacks).

What it does:
- Starts **headless** (OpenCode + OpenWork server) on port 8787
- Starts **web UI** (Vite dev server) on port 5173
- Auto-generates and shares auth tokens between services
- Web waits for headless health check before starting
- Builds Linux binaries inside the container (no host binary conflicts)
- Uses an isolated OpenCode dev state by default so the stack does not read your personal host config/auth/data

If you want to seed the container from your host OpenCode state for debugging, run with `OPENWORK_DOCKER_DEV_MOUNT_HOST_OPENCODE=1`. This imports host config/auth into the isolated dev state instead of mounting live host state directly.

Useful commands:
- Logs: `docker compose -p <project> -f packaging/docker/docker-compose.dev.yml logs`
- Tear down: `docker compose -p <project> -f packaging/docker/docker-compose.dev.yml down`
- Health check: `curl http://localhost:<openwork_port>/health`

Optional env vars (via `.env` or `export`):
- `OPENWORK_TOKEN` — fixed client token
- `OPENWORK_HOST_TOKEN` — fixed host/admin token
- `OPENWORK_WORKSPACE` — host path to mount as workspace
- `OPENWORK_PORT` — host port to map to container :8787
- `WEB_PORT` — host port to map to container :5173
- `SHARE_PORT` — host port to map to the local share service :3000
- `OPENWORK_PUBLIC_HOST` — host name/IP used in printed LAN/public URLs (defaults to your machine hostname)
- `OPENWORK_DOCKER_DEV_MOUNT_HOST_OPENCODE=1` — import host OpenCode config/auth into the isolated dev state
- `OPENWORK_OPENCODE_CONFIG_DIR` — override the host OpenCode config source used for that optional import
- `OPENWORK_OPENCODE_DATA_DIR` — override the host OpenCode data source used for that optional import

The dev stack also starts the local share service automatically and points the OpenWork app at it, so share-link flows publish to a local service instead of `https://share.openworklabs.com`.

---

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
- `DEN_BETTER_AUTH_TRUSTED_ORIGINS` — trusted origins for Better Auth (defaults to `DEN_CORS_ORIGINS`)
- `DEN_CORS_ORIGINS` — trusted origins for Express CORS (defaults include hostname, localhost, `127.0.0.1`, `0.0.0.0`, and detected LAN IPv4)
- `DEN_PROVISIONER_MODE` — `stub` or `render` (defaults to `stub`)
- `DEN_WORKER_URL_TEMPLATE` — stub worker URL template with `{workerId}` placeholder

### Faster inner-loop alternative

If you are iterating on Den locally and do not need the full Dockerized web stack, use the hybrid path instead:

From the OpenWork repo root:

```bash
pnpm dev:den-local
```

Or from the OpenWork enterprise root:

```bash
pnpm --dir _repos/openwork dev:den-local
```

What it does:
- Starts only **MySQL** in Docker
- Runs **Den controller** locally in watch mode
- Runs **OpenWork Cloud web app** locally in Next.js dev mode
- Reuses the existing local-dev wiring in `scripts/dev-web-local.sh`

This is usually the fastest path for UI/auth/control-plane iteration because it avoids rebuilding the Docker web image on each boot.

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
