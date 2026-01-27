# OpenWork Server

Filesystem-backed API for OpenWork remote clients. This package provides the OpenWork server layer described in `packages/app/pr/openwork-server.md` and is intentionally independent from the desktop app.

## Quick start

```bash
pnpm --filter @different-ai/openwork-server dev -- \
  --workspace /path/to/workspace \
  --approval auto
```

The server logs the client token and host token on boot when they are auto-generated.

## Config file

Defaults to `~/.config/openwork/server.json` (override with `OPENWORK_SERVER_CONFIG` or `--config`).

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "approval": { "mode": "manual", "timeoutMs": 30000 },
  "workspaces": [
    { "path": "/Users/susan/Finance", "name": "Finance", "workspaceType": "local" }
  ],
  "corsOrigins": ["http://localhost:5173"]
}
```

## Environment variables

- `OPENWORK_SERVER_CONFIG` path to config JSON
- `OPENWORK_HOST` / `OPENWORK_PORT`
- `OPENWORK_TOKEN` client bearer token
- `OPENWORK_HOST_TOKEN` host approval token
- `OPENWORK_APPROVAL_MODE` (`manual` | `auto`)
- `OPENWORK_APPROVAL_TIMEOUT_MS`
- `OPENWORK_WORKSPACES` (JSON array or comma-separated list of paths)
- `OPENWORK_CORS_ORIGINS` (comma-separated list or `*`)

## Endpoints (initial)

- `GET /health`
- `GET /capabilities`
- `GET /workspaces`
- `GET /workspace/:id/config`
- `PATCH /workspace/:id/config`
- `GET /workspace/:id/plugins`
- `POST /workspace/:id/plugins`
- `DELETE /workspace/:id/plugins/:name`
- `GET /workspace/:id/skills`
- `POST /workspace/:id/skills`
- `GET /workspace/:id/mcp`
- `POST /workspace/:id/mcp`
- `DELETE /workspace/:id/mcp/:name`
- `GET /workspace/:id/commands`
- `POST /workspace/:id/commands`
- `DELETE /workspace/:id/commands/:name`
- `GET /workspace/:id/export`
- `POST /workspace/:id/import`

## Approvals

All writes are gated by host approval. Host APIs require `X-OpenWork-Host-Token`:

- `GET /approvals`
- `POST /approvals/:id` with `{ "reply": "allow" | "deny" }`

Set `OPENWORK_APPROVAL_MODE=auto` to auto-approve during local development.
