# On-prem Den static runbook

Use this runbook to deploy Den on your own network when the worker runtimes already exist and Den should allocate them from a fixed pool.

This runbook uses:

- `packaging/docker/docker-compose.yml` for the worker runtime
- `packaging/docker/docker-compose.den-static.yml` for the Den stack

In `static` mode:

- you start and manage the OpenWork worker runtimes yourself
- Den allocates a free worker URL from `DEN_STATIC_WORKER_URLS`
- Den verifies worker health and the configured token pair before marking a worker `healthy`
- Den does not create Docker containers, worker VMs, or worker hosts for you

The Den web URL is the normal browser-facing entrypoint. The Den API should remain internal to the Den host unless you intentionally expose it to another trusted client.

Use HTTPS for the browser-facing Den web URL whenever possible. If you intentionally use HTTP on a private LAN, use that exact HTTP origin consistently for `DEN_WEB_ORIGIN`, `DEN_BETTER_AUTH_URL`, trusted origins, and any client configuration.

## Prerequisites

- One host for Den and one or more hosts for OpenWork workers. These can be separate machines or the same machine if your deployment model allows it.
- Docker Engine with Compose v2 on the Den host and on every worker host.
- The OpenWork repository checkout or a release artifact on each target host. Use the exact source checkout or artifact you intend to deploy.
- A browser-facing Den web URL, for example `https://den.company.local`.
- One stable URL per worker runtime, for example `http://worker-01.company.local:8787`.
- A persistent workspace directory for each worker, mounted at `/workspace` inside the worker container.
- A persistent data directory for each worker, mounted at `/data` inside the worker container.
- One `OPENWORK_TOKEN` and one `OPENWORK_HOST_TOKEN` for each worker runtime.
- One `DEN_BETTER_AUTH_SECRET` for Den.
- One `DEN_DB_ENCRYPTION_KEY` for Den.
- One `DEN_STATIC_WORKER_TOKEN_MAP_JSON` that maps each worker URL to its `clientToken` and `hostToken`.
- Network reachability from:
  - browsers to the Den web URL
  - Den to every worker URL on port `8787`
- A production email provider for normal sign-up, invitation, and verification flows.
- `DEN_MYSQL_ROOT_PASSWORD` for the Den database container.

All commands below assume the OpenWork repository root is available on the target host. Replace `/path/to/openwork` with the real path on your host.

## Inputs To Collect

Prepare these values before launching anything:

- `DEN_WEB_ORIGIN`, for example `https://den.company.local`
- One worker URL per runtime, for example `http://worker-01.company.local:8787`
- One workspace path per worker
- One data path per worker
- `OPENWORK_TOKEN` per worker
- `OPENWORK_HOST_TOKEN` per worker
- `DEN_BETTER_AUTH_SECRET`
- `DEN_DB_ENCRYPTION_KEY`
- `DEN_MYSQL_ROOT_PASSWORD`
- `DEN_STATIC_WORKER_URLS`, containing all worker URLs as a comma-separated list
- `DEN_STATIC_WORKER_TOKEN_MAP_JSON`, containing the token pair for each worker URL

The browser-facing Den web URL must match the value used for `DEN_BETTER_AUTH_URL`. If users open Den at `https://den.company.local`, then `DEN_BETTER_AUTH_URL` must be exactly `https://den.company.local`. If you intentionally use HTTP on a private LAN, then use that exact HTTP origin consistently.

## Start One Worker

Run this on the worker host from `packaging/docker`:

```bash
cd /path/to/openwork/packaging/docker
export OPENWORK_HOST_PORT=8787
export OPENWORK_CONNECT_HOST=worker-01.company.local
export OPENWORK_WORKSPACE_DIR=/srv/openwork/worker-01/workspace
export OPENWORK_DATA_DIR_HOST=/srv/openwork/worker-01/data
export OPENWORK_TOKEN='<worker-01-client-token>'
export OPENWORK_HOST_TOKEN='<worker-01-host-token>'
docker compose -p openwork-worker-1 up --build -d
docker compose -p openwork-worker-1 ps
curl http://worker-01.company.local:8787/health
```

Expected result:

- the container is running
- `curl` returns HTTP 200 JSON from the OpenWork server

This worker URL is what Den will later use in `DEN_STATIC_WORKER_URLS`.

## Start Additional Workers

If you need more than one worker runtime, repeat the worker launch with:

- a different Compose project name
- a different worker URL or host port
- a different workspace path
- a different data path
- a different `OPENWORK_TOKEN`
- a different `OPENWORK_HOST_TOKEN`

On separate hosts, you can keep the container port at `8787` on each host and vary only the hostname, for example:

- `http://worker-01.company.local:8787`
- `http://worker-02.company.local:8787`

If multiple workers share one host, use a unique host port per worker and a unique Compose project per worker.

## Start Den In Static Mode

Run this on the Den host from the repository root.

Export the variables and run `docker compose` in the same shell session.

In Bash, export `DEN_STATIC_WORKER_TOKEN_MAP_JSON` as a single-quoted JSON string so it reaches the container unchanged.

```bash
cd /path/to/openwork
export DEN_WEB_ORIGIN=https://den.company.local
export DEN_BETTER_AUTH_URL=$DEN_WEB_ORIGIN
export DEN_BETTER_AUTH_TRUSTED_ORIGINS=$DEN_WEB_ORIGIN
export DEN_CORS_ORIGINS=$DEN_WEB_ORIGIN
export DEN_STATIC_WORKER_URLS=http://worker-01.company.local:8787,http://worker-02.company.local:8787
export DEN_STATIC_WORKER_HEALTH_PATH=/health
export DEN_STATIC_WORKER_HEALTHCHECK_TIMEOUT_MS=10000
export DEN_BETTER_AUTH_SECRET='<better-auth-secret>'
export DEN_DB_ENCRYPTION_KEY='<db-encryption-key>'
export DEN_MYSQL_ROOT_PASSWORD='<mysql-root-password>'
export DEN_EMAIL_FROM='OpenWork Den <den@example.com>'
export DEN_STATIC_WORKER_TOKEN_MAP_JSON='{"http://worker-01.company.local:8787":{"clientToken":"<worker-01-client-token>","hostToken":"<worker-01-host-token>"},"http://worker-02.company.local:8787":{"clientToken":"<worker-02-client-token>","hostToken":"<worker-02-host-token>"}}'
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-static.yml up --build -d
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-static.yml ps
```

`DEN_STATIC_WORKER_URLS` is the pool of worker runtimes that Den can allocate.

`DEN_STATIC_WORKER_TOKEN_MAP_JSON` must contain one entry for every worker URL that Den is allowed to attach as a shared worker.

## Verify Deployment

Run these checks after the worker and Den are up:

```bash
curl http://worker-01.company.local:8787/health
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-static.yml ps
curl $DEN_WEB_ORIGIN/api/den/health
```

Expected result:

- the worker health endpoint returns HTTP 200 JSON
- the `den` and `web` services are `healthy` in `docker compose ps`
- the Den web health endpoint returns HTTP 200 JSON

At this point, the deployment is up.

## First Use

Open the Den web URL in a browser:

- `https://<den-host>`

Create the first account and complete email verification.

Configure SMTP or Resend before the first real sign-up so the verification email is delivered normally.

After the first account is verified, create the first organization.

When the first organization is created in `static` mode and `DEN_STATIC_WORKER_URLS` is not empty, Den automatically attempts to create one default shared/static worker for that organization.

Expected behavior:

- Den picks the first free worker URL from `DEN_STATIC_WORKER_URLS`
- Den calls `/health` on that worker URL
- Den verifies the configured client token against `/workspaces`
- Den verifies the configured host token against `/env/keys`
- Den marks the worker `healthy` only after the runtime contract succeeds

You can also add another shared worker from the Den UI later. In `static` mode, the UI can allocate a free worker URL from the pre-provisioned pool, but it cannot create a new runtime worker.

If you need more capacity than the remaining free URLs:

1. start another runtime worker
2. add its URL to `DEN_STATIC_WORKER_URLS`
3. add its token pair to `DEN_STATIC_WORKER_TOKEN_MAP_JSON`
4. restart Den

## Minimal Troubleshooting

- `Invalid origin` during sign-up or email verification:
  - `DEN_BETTER_AUTH_URL`, `DEN_BETTER_AUTH_TRUSTED_ORIGINS`, and `DEN_CORS_ORIGINS` do not match the real browser-facing Den URL
- worker stays `Starting` or becomes `failed`:
  - run `curl http://<worker-host>:8787/health`
  - inspect Den logs with `docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-static.yml logs den`
- `No available static worker URL remains`:
  - every URL in `DEN_STATIC_WORKER_URLS` is already in use, so add another pre-running worker runtime and restart Den
- `STATIC_WORKER_TOKEN_MAP_JSON must be valid JSON`:
  - export it as a single-quoted JSON string in Bash
