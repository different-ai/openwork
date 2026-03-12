# OpenWork Host (Docker)

## Dev testability stack (recommended for testing)

One command, one dev image, and a health-gated startup path.

From the repo root:

```bash
./packaging/docker/dev-up.sh
```

Then open the printed Web UI URL (ports are randomized so you can run multiple stacks).

What it does:
- Builds a single Docker image from the current checkout before the stack starts
- Installs dependencies and compiles Linux sidecars at image build time instead of every container boot
- Starts **headless** (OpenCode + OpenWork server) on port 8787
- Starts **web UI** (Vite dev server) on port 5173
- Auto-generates and shares auth tokens between services through a mounted runtime env file
- Waits for both `http://localhost:<openwork_port>/health` and the web UI before printing "ready"
- Uses an isolated OpenCode dev state by default so the stack does not read your personal host config/auth/data

This stack now favors reproducibility over live bind-mounted source edits. When you change code, rerun `./packaging/docker/dev-up.sh` so the image rebuild picks up the new checkout.

If you want to seed the container from your host OpenCode state for debugging, run with `OPENWORK_DOCKER_DEV_MOUNT_HOST_OPENCODE=1`. This imports host config/auth into the isolated dev state instead of mounting live host state directly.

For extra observability, run:

```bash
OPENWORK_DOCKER_DEBUG=1 ./packaging/docker/dev-up.sh
```

Debug mode:
- Enables verbose orchestrator logs
- Writes container status, logs, inspect output, and health snapshots under `tmp/docker-dev/<dev-id>/`
- Prints the runtime metadata file that includes the exact `logs` and `down` commands for that stack

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
- `OPENWORK_DOCKER_DEBUG=1` — capture extra runtime diagnostics under `tmp/docker-dev/<dev-id>/`
- `OPENWORK_DOCKER_SKIP_BUILD=1` — reuse the last built dev image instead of rebuilding from the current checkout
- `OPENWORK_DOCKER_DEV_MOUNT_HOST_OPENCODE=1` — import host OpenCode config/auth into the isolated dev state
- `OPENWORK_OPENCODE_CONFIG_DIR` — override the host OpenCode config source used for that optional import
- `OPENWORK_OPENCODE_DATA_DIR` — override the host OpenCode data source used for that optional import

---

## Production container

This is a minimal packaging template to run the OpenWork Host contract in a single container.

It runs:

- `opencode serve` (engine) bound to `127.0.0.1:4096` inside the container
- `openwork-server` bound to `0.0.0.0:8787` (the only published surface)

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
