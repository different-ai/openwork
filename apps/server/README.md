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

Token management (collaborator or owner bearer token):

- `GET /tokens`
- `POST /tokens` (body: `{ "scope": "owner"|"collaborator"|"viewer", "label"?: string }`)
- `DELETE /tokens/:id`

Inbox/outbox:

- `POST /workspace/:id/inbox` (multipart upload into `.opencode/openwork/inbox/`)
- `GET /workspace/:id/artifacts`
- `GET /workspace/:id/artifacts/:artifactId`
- `POST /workspace/:id/files/sessions`
- `DELETE /files/sessions/:sessionId`
- `GET /files/sessions/:sessionId/catalog/snapshot`
- `POST /files/sessions/:sessionId/ops`

UI control mailbox:

- `POST /experimental/ui-control/request` (collaborator or owner bearer token)
- `GET /experimental/ui-control/pending` (collaborator or owner bearer token; optional `?wait=1`)
- `POST /experimental/ui-control/:id/reply` (collaborator or owner bearer token)

Desktop and web renderers poll the same server they are connected to. The first
polling window claims each request; commands are never broadcast to every tab.
Requests expire after five seconds, and a server with no recent renderer poll
returns an explicit no-window result. The external desktop UI MCP bridge remains
available; in-app tools no longer discover or fall back to that bridge.

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

## Automatic title recovery

The managed v1 engine ships a title-only compatibility plugin. If a provider
returns HTTP 400 with `unsupported_value` or `unsupported_parameter` for
`reasoning.effort`, `reasoning_effort`, `temperature`, or `top_p`, it makes at
most one corrected request. It uses a reported supported effort or omits the
rejected optional parameter so the same model can use its default. Provider,
model, credentials, conversation content, and normal chat options stay intact.
Access, quota, transport, and unrelated request errors do not trigger an added
recovery request. The engine's own transport retry policy still applies.

Engine log records with service `openwork.title` / message `Automatic title
generation` contain only session/provider/model IDs, outcome, recovery attempt,
HTTP status, and the rejected parameter name. `accepted_after_recovery` means
the provider accepted the retry; `title_available` separately confirms a real
title was observed in a session update. An accepted request with no title update
within 60 seconds is `title_unconfirmed`, which can mean empty output, a stream
failure, or missing persistence; it is not reported as success. The app's
existing bounded placeholder probes and warning remain the user-facing safety
net. Existing untitled conversations are not bulk-regenerated.
