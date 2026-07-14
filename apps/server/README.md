# OpenWork Server

Filesystem-backed API for OpenWork remote clients. This package provides the OpenWork server layer described in `apps/app/pr/openwork-server.md` and is intentionally independent from the desktop app.

## Quick start

```bash
npm install -g openwork-server
openwork-server --workspace /path/to/workspace --approval auto
```

`openwork-server` ships as a compiled binary, so Bun is not required at runtime.

Or from source:

```bash
pnpm --filter openwork-server dev -- \
  --workspace /path/to/workspace \
  --approval auto
```

The server logs the client token and host token on boot when they are auto-generated.

Add `--verbose` to print resolved config details on startup. Use `--version` to print the server version and exit.

## Config file

Defaults to `~/.config/openwork/server.json` (override with `OPENWORK_SERVER_CONFIG` or `--config`).

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "approval": { "mode": "manual", "timeoutMs": 30000 },
  "workspaces": [
    {
      "path": "/Users/susan/Finance",
      "name": "Finance",
      "workspaceType": "local",
      "baseUrl": "http://127.0.0.1:4096",
      "directory": "/Users/susan/Finance"
    }
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
- `OPENWORK_OPENCODE_BASE_URL`
- `OPENWORK_OPENCODE_DIRECTORY`
- `OPENWORK_OPENCODE_USERNAME`
- `OPENWORK_OPENCODE_PASSWORD`

Local Connect:

- `OPENWORK_CONNECT_VAULT_KEY` — required 32-byte key encoded as base64url, or
  prefixed with `hex:`. The key stays outside `runtime.sqlite`; losing it makes
  stored Connect credentials unreadable. The desktop generates and protects
  this key with the operating system credential vault.
- `OPENWORK_CONNECT_PUBLIC_URL` — stable public origin used for OAuth callback
  URLs when the server sits behind a TLS reverse proxy.
- `OPENWORK_CONNECT_AGENT_URL` — optional engine-reachable Connect endpoint
  override for advanced remote/self-hosted layouts.
- `OPENWORK_CONNECT_ALLOW_PRIVATE_URLS=1` — operator-wide private-network
  override. Prefer the per-connection private-network choice in Settings.

Local Connect is account-free and uses this server's existing owner access.
Public HTTPS MCP endpoints are the default. A private-network connection must
be explicitly allowed; link-local/cloud-metadata and reserved addresses remain
blocked. Provider secrets, OAuth tokens, PKCE verifiers, and dynamic client
secrets are encrypted and are never returned by the management API.

Token management (scoped tokens):

- `OPENWORK_TOKEN_STORE` path to token store JSON (default: alongside `server.json`)

File injection / artifacts:

- `OPENWORK_INBOX_ENABLED` (`1` | `0`)
- `OPENWORK_INBOX_MAX_BYTES` (default: 50MB, capped)
- `OPENWORK_OUTBOX_ENABLED` (`1` | `0`)

Sandbox advertisement (for capability discovery):

- `OPENWORK_SANDBOX_ENABLED` (`1` | `0`)
- `OPENWORK_SANDBOX_BACKEND` (`docker` | `container` | `none`)

## Endpoints

- `GET /health`
- `GET /status`
- `GET /capabilities`
- `GET|PUT /v1/connect/profile`
- `GET|POST /v1/connect/connections`
- `DELETE /v1/connect/connections/:id`
- `POST /v1/connect/connections/:id/connect`
- `POST /v1/connect/connections/:id/disconnect`
- `GET /v1/connect/connections/:id/callback`
- `GET|POST|DELETE /mcp/agent` (dedicated agent bearer credential; exactly
  `search_capabilities` and `execute_capability`)
- `GET /whoami`
- `GET /workspaces`
- `GET /workspace/:id/config`
- `PATCH /workspace/:id/config`
- `GET /workspace/:id/events`
- `POST /workspace/:id/engine/reload`
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
- `GET /workspace/:id/audit`
- `GET /workspace/:id/export`
- `POST /workspace/:id/import/preview`
- `POST /workspace/:id/import`

Token management (host/owner auth):

- `GET /tokens`
- `POST /tokens` (body: `{ "scope": "owner"|"collaborator"|"viewer", "label"?: string }`)
- `DELETE /tokens/:id`

Inbox/outbox:

- `POST /workspace/:id/inbox` (multipart upload into `.opencode/openwork/inbox/`)
- `GET /workspace/:id/artifacts`
- `GET /workspace/:id/artifacts/:artifactId`
- `POST /workspace/:id/files/sessions`
- `POST /files/sessions/:sessionId/renew`
- `DELETE /files/sessions/:sessionId`
- `GET /files/sessions/:sessionId/catalog/snapshot`
- `GET /files/sessions/:sessionId/catalog/events`
- `POST /files/sessions/:sessionId/read-batch`
- `POST /files/sessions/:sessionId/write-batch`
- `POST /files/sessions/:sessionId/ops`

Toy UI (static assets served by the server):

- `GET /ui`
- `GET /w/:id/ui`
- `GET /ui/assets/*`

OpenCode proxy:

- `GET|POST|... /opencode/*`
- `GET|POST|... /w/:id/opencode/*`

## Approvals

All writes are gated by host approval.

Host APIs accept either:

- `X-OpenWork-Host-Token: <token>` (legacy host token), or
- `Authorization: Bearer <token>` where the token scope is `owner`.

Approvals endpoints:

- `GET /approvals`
- `POST /approvals/:id` with `{ "reply": "allow" | "deny" }`

Set `OPENWORK_APPROVAL_MODE=auto` to auto-approve during local development.
