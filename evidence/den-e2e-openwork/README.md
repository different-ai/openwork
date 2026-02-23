# OpenWork Repo Non-Stub Render E2E Proof

This directory captures end-to-end proof for the OpenWork-repo implementation of the Den service and worker provisioning flow.

## Control-plane deployment proof

- `render-control-plane.json`

Includes service id, repo/branch/rootDir, public URL, and latest live deploy metadata.

## API/CLI auth + worker provisioning flow

- `report.json`
- `07-worker-health.json`

`report.json` shows:

- `POST /api/auth/sign-up/email` succeeds (`status: 200`)
- `GET /v1/me` via cookie session succeeds (`status: 200`)
- `GET /v1/me` via bearer token succeeds (`status: 200`)
- `POST /v1/workers` succeeds (`status: 201`)
- created instance is real Render (`instance.provider: "render"`)
- returned worker health endpoint succeeds (`worker_health.status: 200`)

Sensitive token/session fields are redacted.

## Web flow proof (Chrome MCP)

- `webapp/01-web-signup-form.png`
- `webapp/02-web-signup-success.png`
- `webapp/03-web-worker-created-render.png`
- `08-web-worker-health.json`

`03-web-worker-created-render.png` shows successful cloud worker creation with Render provider and healthy status, with tokens redacted in UI output.
