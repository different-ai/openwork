---
name: daytona-cloud-server
description: Daytona cloud server and Den sandbox setup. Use when the user says Daytona server, cloud server, Den server, marketplace server, worker proxy, cloud auth, org policies, or connect Electron to a Daytona server.
---

# Daytona Cloud Server

Use this skill when the user needs the hosted/server side of OpenWork running in
Daytona. This is separate from the Electron desktop sandbox.

## What This Covers

- Den Web on port `3005`.
- Den API on port `8788`.
- Worker proxy on port `8789`.
- MySQL inside the server sandbox.
- Public Daytona preview URLs for Electron to consume.
- Marketplace, org policy, cloud auth, and server-managed extension flows.

## Start Server Sandbox

From the repo root:

```bash
bash .devcontainer/test-server-on-daytona.sh [branch-or-commit]
```

The helper creates a separate server sandbox, starts MySQL, Den API, Den Web,
and worker proxy, waits for health checks, then prints URLs.

If dependencies or the base image changed, refresh the server snapshot:

```bash
bash .devcontainer/create-daytona-openwork-server-snapshot.sh
```

## Connect Electron To Server

For end-to-end desktop validation, use the `daytona-electron-den` skill. This
section only covers wiring the Electron sandbox to the printed server URLs.

Start a second Daytona sandbox for Electron and point it at the server URLs:

```bash
bash .devcontainer/test-on-daytona.sh [branch-or-commit] \
  --den-base-url <DEN_WEB_URL> \
  --den-api-base-url <DEN_API_URL>
```

For flows that must require cloud sign-in, add `--require-signin`.

## Validate Server Health

Use the public URLs printed by the helper:

```bash
curl -sf <DEN_WEB_URL>/api/den/health
curl -sf <DEN_API_URL>/health
```

Inspect logs if health checks fail:

```bash
daytona exec "$SERVER_SANDBOX" -- 'tail -120 /tmp/den-api.log'
daytona exec "$SERVER_SANDBOX" -- 'tail -120 /tmp/den-web.log'
daytona exec "$SERVER_SANDBOX" -- 'tail -120 /tmp/den-worker-proxy.log'
daytona exec "$SERVER_SANDBOX" -- 'tail -120 /tmp/den-db-push.log'
```

## When To Use Two Sandboxes

Use two sandboxes when testing cloud behavior end-to-end: server sandbox for Den
and a separate Electron sandbox for the desktop client. This matches production
better than trying to run everything inside one desktop sandbox.

Use this for marketplace install/remove/search/filter, org-managed extensions,
desktop handoff auth, cloud restrictions, and worker proxy flows.

## Evidence

Pair this with the `daytona-recording-artifacts` skill. Server proof should
include health-check output, relevant logs, CDP assertions from Electron, and a
recording or screenshot artifact for human review.

Use `daytona-flow-validator` for pass/fail. Server health alone does not prove
Electron cloud behavior works.
