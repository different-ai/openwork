---
name: daytona-seeded-cloud-demo
description: Daytona seeded cloud demo, demo credentials, Acme Robotics seed. Use when the user asks to spin up, keep running, seed, or prepare an OpenWork Cloud/Den Daytona demo instance.
---

# Daytona Seeded Cloud Demo

Use this skill to quickly create a persistent-enough OpenWork Cloud/Den Daytona server demo, seed it with Acme Robotics demo data, validate the login, and return copy-pasteable demo details.

## Goal

Start a server-only Daytona sandbox for demos, seed the Den database, keep the sandbox warm, and return URLs plus credentials the user can share.

## Fast Path

Run from the repo root. Prefer a stable sandbox name when the user wants to hand this to someone else:

```bash
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SANDBOX="openwork-cloud-demo-seeded"

bash .devcontainer/test-server-on-daytona.sh "$BRANCH" --name "$SANDBOX"
```

If the sandbox name already exists, choose a dated suffix instead, for example:

```bash
SANDBOX="openwork-cloud-demo-seeded-$(date +%Y%m%d-%H%M)"
bash .devcontainer/test-server-on-daytona.sh "$BRANCH" --name "$SANDBOX"
```

The helper prints these values. Capture them exactly:

```bash
DEN_WEB_URL="<printed Den Web URL>"
DEN_API_URL="<printed Den API URL>"
DEN_WORKER_PROXY_URL="<printed Worker Proxy URL>"
```

## Seed Demo Data

Seed the sandbox after the Den stack is healthy. The seed uses the same encryption and auth secrets as `.devcontainer/start-daytona-server.sh`.

```bash
daytona exec "$SANDBOX" -- 'bash -lc '\''cd /workspace && pnpm --filter @openwork/email build && cd /workspace/ee/apps/den-api && OPENWORK_DEV_MODE=1 DATABASE_URL=mysql://root:password@127.0.0.1:3306/openwork_den DEN_DB_ENCRYPTION_KEY=daytona-den-db-encryption-key-please-change-1234567890 BETTER_AUTH_SECRET=daytona-den-auth-secret-please-change-1234567890 BETTER_AUTH_URL="'"$DEN_WEB_URL"'" pnpm exec tsx scripts/seed-demo-org.ts --reset'\'''
```

Expected seeded credentials:

```text
Email: alex@acme.test
Password: OpenWorkDemo123!
```

Expected seed summary:

```text
Org: Acme Robotics
Org slug: acme-robotics-demo
Owner: Alex Chen
Members: 17
Teams: 12
Pending invites: 3
Marketplace plugins: 14
Config objects: 71
```

## Keep It Running

The server helper creates the sandbox with Daytona auto-stop enabled. If the CLI does not support changing auto-stop after creation, start a local keepalive loop that pings Den API every 30 minutes:

```bash
KEEPALIVE_DIR="${TMPDIR:-/tmp}/opencode"
mkdir -p "$KEEPALIVE_DIR"
KEEPALIVE_LOG="$KEEPALIVE_DIR/${SANDBOX}-keepalive.log"
nohup sh -c 'while true; do date; daytona exec '"$SANDBOX"' -- "bash -lc '\''curl -fsS http://127.0.0.1:8788/health >/dev/null'\''"; sleep 1800; done' >"$KEEPALIVE_LOG" 2>&1 &
```

Then confirm it is running:

```bash
ps -axo pid,command | rg "$SANDBOX.*8788/health|${SANDBOX}-keepalive"
```

Stop the keepalive later with the printed PID if the demo is no longer needed.

## Validate

Validate public health through both routes:

```bash
curl -fsS "$DEN_API_URL/health"
curl -fsS "$DEN_WEB_URL/api/den/health"
```

Validate the demo account through Den Web auth. This is the most relevant browser-facing path:

```bash
curl -fsS -X POST "$DEN_WEB_URL/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  --data '{"email":"alex@acme.test","password":"OpenWorkDemo123!"}'
```

Also validate direct Den API auth if the user will connect desktop or debug handoff:

```bash
curl -fsS -X POST "$DEN_API_URL/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  --data '{"email":"alex@acme.test","password":"OpenWorkDemo123!"}'
```

Both auth calls should return `redirect: false`, a `token`, and user `Alex Chen`.

## Final Response Template

Return concise demo details in this order:

```markdown
Daytona cloud demo is running and seeded.

**Demo Access**
- Den Web: <DEN_WEB_URL>
- Den API: <DEN_API_URL>
- Worker Proxy: <DEN_WORKER_PROXY_URL>
- Sandbox: `<SANDBOX>`
- Sandbox ID: `<id from daytona info>`

**Credentials**
- Email: `alex@acme.test`
- Password: `OpenWorkDemo123!`

**Seeded Data**
- Org: `Acme Robotics`
- Org slug: `acme-robotics-demo`
- Owner: `Alex Chen`
- Members: `17`
- Teams: `12`
- Pending invites: `3`
- Marketplace plugins: `14`
- Config objects: `71`

**Validation**
- Public Den Web health passed.
- Public Den API health passed.
- Seeded login passed through Den Web and Den API auth routes.
- Keepalive loop is running locally and pings the sandbox every 30 minutes.
```

## Troubleshooting

If older docs suggest running the Electron helper in a server-only mode, do not
use that path unless this checkout supports it. Use
`.devcontainer/test-server-on-daytona.sh` for server-only cloud demos.

If sign-in returns `403` for email verification, Den API is not running with `OPENWORK_DEV_MODE=1` or did not restart after env changes. Restart the Den stack and rerun the seed.

If Den Web health passes but auth through Den Web fails while direct Den API auth passes, report that distinction and debug the Den Web proxy separately. Do not claim the browser-facing demo path passed from direct API auth alone.
