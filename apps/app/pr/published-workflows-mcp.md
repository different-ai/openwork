# Publish OpenWork workflows as MCP-callable tools

Closes: N/A — Path B submission / exploratory product PR.

## Commits

Reviewable in three logical passes:

1. `feat(server): publish workflows as MCP tools` — storage,
   admin routes, MCP transport, sync OpenCode bridge, server tests.
2. `feat(app): publish workflows UI in skills settings` — Publish action,
   modal, list panel, store + HTTP helpers, English i18n keys.
3. `chore(i18n): mirror publishedWorkflows keys to all locales` —
   English placeholders across `ca / es / fr / ja / pt-BR / th / vi / zh`.

## Why

OpenWork already runs OpenCode agents against a workspace, with skills,
plugins, and MCPs wired in. What it cannot do today is invert that
relationship: there is no way for an _external_ MCP client (Claude
Desktop, Cursor, the OpenCode CLI on a teammate's machine, an automation
in n8n) to call back into a workspace and trigger one of those agents.

`ARCHITECTURE.md` (line 152) literally describes MCP as the right primitive
for "authenticated third-party flows… when 'auth + capability surface' is
the product boundary," and the same doc lists "frictionless publishing
without signup" as a Skill-Registry roadmap goal. This PR delivers the
narrowest useful version of both.

The product framing is **publishing a workflow**, not "publishing a skill":

- Skills are markdown context that guides an agent _inside_ a session.
- A workflow is the executable thing: a session running a specific agent,
  primed with a specific skill, against a specific workspace.

So the user-visible verb is _Publish workflow_. The artifact is a tool an
external MCP client can list and call. The transport is a single URL with
a token in the path; the same token IS the authorization. Stateless POST,
single HTTP turn, real result back.

## Storage

Same on-disk pattern as `TokenService` and the env file from
`environment-variables.md`. JSON file, sha256-hashed tokens, never store
the plaintext.

| OS | Path |
| --- | --- |
| Linux / macOS | `~/.config/openwork/published-workflows.json` |
| Windows | `%APPDATA%\openwork\published-workflows.json` |

Override via `OPENWORK_PUBLISHED_WORKFLOWS_STORE` (mirrors
`OPENWORK_TOKEN_STORE`). File shape:

```json
{
  "schemaVersion": 1,
  "updatedAt": 1714000000000,
  "workflows": [
    {
      "id": "uuid",
      "tokenHash": "sha256-hex",
      "workspaceId": "ws_a",
      "skillName": "summarize",
      "toolName": "summarize",
      "description": "Summarize input text",
      "agent": "build",
      "inputSchema": { "type": "object", "properties": { "input": { "type": "string" } } },
      "createdAt": 1714000000000
    }
  ]
}
```

`PublishedWorkflowsService` (apps/server/src/published-workflows.ts)
exposes `list / get / create / revoke / findByToken`. The plaintext token
is returned **only** from `create()`; from then on the only way to use it
is via the MCP transport route, which hashes the inbound URL token and
matches by hash.

## Server

Three host-token admin routes, scoped per workspace:

- `GET /workspace/:id/published-workflows` → `{ items: [...] }`
- `POST /workspace/:id/published-workflows` → `{ id, token, ... }` (201).
  Body: `{ skillName, description, toolName?, agent?, inputSchema?, label? }`.
- `DELETE /workspace/:id/published-workflows/:workflowId` → `{ ok: true }`.

Each create/revoke is mirrored into the workspace audit log.

## MCP transport

One public route, registered for `POST/GET/DELETE`:

```text
/published/:token/mcp
```

Auth is the URL-embedded token. Unknown token → JSON-RPC `-32001`
(HTTP 401). Workspace removed from config after publish → JSON-RPC
`-32002` (HTTP 410). Anything else falls through to the JSON-RPC
dispatcher in `apps/server/src/published-mcp.ts`, which implements the
minimal MCP Streamable-HTTP subset:

- `initialize` → returns `protocolVersion: "2024-11-05"`, `serverInfo`,
  `capabilities.tools`.
- `notifications/initialized`, `notifications/cancelled` → 202.
- `ping` → `{}`.
- `tools/list` → returns the single tool descriptor for this token.
- `tools/call` → executes the workflow synchronously and returns
  `{ content: [{ type: "text", text }] }`.

GET (SSE upgrade) and DELETE (session terminate) return `405` and `204`
respectively — the transport is stateless and does not need streams.

We deliberately do not pull in `@modelcontextprotocol/sdk` or `@hono/mcp`.
`apps/server` is a hand-written Bun fetch router; adding the SDK would
mean either bridging Hono into that router or rewriting it. The handler
is ~150 lines and covers everything Claude Desktop / Cursor / Codex
actually call against a tool server.

## Synchronous bridge

`tools/call` runs `executePublishedWorkflow`:

1. `POST /session` against the workspace's OpenCode → new session id.
2. Build a prompt: ``Run the `<skillName>` skill with the following input: ```json …`````.
3. `POST /session/:id/prompt` (the **synchronous** OpenCode endpoint —
   the SDK's `client.session.prompt`, not `prompt_async`) with optional
   `agent` from the publication record.
4. `Promise.race` against a 60s timer (`OPENWORK_PUBLISHED_WORKFLOW_TIMEOUT_MS`
   override) — a stuck agent cannot pin the worker.
5. Pull text parts out of the assistant response and return them.

Errors inside `execute` are caught by the JSON-RPC dispatcher and
returned as `{ isError: true, content: [{ type: "text", text: <message> }] }`
so the calling LLM gets a useful tool error instead of an HTTP 500.

## UI

Skills view at `apps/app/src/react-app/domains/settings/pages/skills-view.tsx`
gains a **Publish** action on every installed skill card, plus a new
**Published workflows** panel listing active publications.

- Publish modal: tool name (defaults to skill name), description, optional
  JSON input schema. Validates locally before POST.
- Success state surfaces the full MCP URL with the token **once** (the
  token is never returned again — same pattern as `TokenService`).
- Listed rows show the token-redacted URL pattern, copy-pattern, and
  revoke. Revoke confirms inline.
- Auto-refreshes on mount; manual refresh button on the panel.
- Gated on a connected OpenWork server — disconnected state shows a
  warning toast instead of a 401.
- 25 new i18n keys under `settings.publishedWorkflows.*` + `common.copy`
  in `en.ts`, mirrored as English placeholders to all 8 other locales
  in a separate `chore(i18n)` commit (matches the
  `settings.environment.*` precedent).

State lives in `apps/app/src/react-app/domains/settings/state/extensions-store.ts`;
HTTP helpers (`listPublishedWorkflows`, `createPublishedWorkflow`,
`revokePublishedWorkflow`) live in `apps/app/src/app/lib/openwork-server.ts`
and use the existing host-token plumbing.

## How to try it

The fastest reproducible path is curl-only against a local server. A full
transcript is in
[`published-workflows-mcp.curl.txt`](./published-workflows-mcp.curl.txt);
the short version:

```bash
# 1. Make a workspace dir with one skill in it
mkdir -p ~/openwork-mcp-test/.opencode/skill/echo
cat > ~/openwork-mcp-test/.opencode/skill/echo/SKILL.md <<'EOF'
---
description: Echo the input back verbatim
---
Echo the input back verbatim as a JSON code block.
EOF

# 2. Run the server with a workspace and explicit tokens
export CLIENT_TOKEN=owt_test_client
export HOST_TOKEN=owt_test_host
pnpm --filter openwork-server dev -- \
  --host 127.0.0.1 --port 4747 \
  --token "$CLIENT_TOKEN" --host-token "$HOST_TOKEN" \
  --workspace ~/openwork-mcp-test --verbose

# 3. In another terminal: list workspaces, publish the skill, hit MCP
BASE=http://127.0.0.1:4747
WS_ID=$(curl -s "$BASE/workspaces" -H "Authorization: Bearer $CLIENT_TOKEN" | jq -r '.items[0].id')

curl -s -X POST "$BASE/workspace/$WS_ID/published-workflows" \
  -H "x-openwork-host-token: $HOST_TOKEN" \
  -H "content-type: application/json" \
  -d '{"skillName":"echo","description":"Echo the input back verbatim"}' | jq
# → { id, token: "pwt_…", … } — copy the token

TOKEN=pwt_…
curl -s -X POST "$BASE/published/$TOKEN/mcp" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

For the UI flow, run the web app against the same server:

```bash
VITE_OPENWORK_URL=http://127.0.0.1:4747 \
VITE_OPENWORK_TOKEN="$CLIENT_TOKEN" \
VITE_OPENWORK_HOST_TOKEN="$HOST_TOKEN" \
pnpm --filter @openwork/app dev
```

Then **Settings → Skills → Publish** on the echo card → modal → submit →
copy the URL from the success notice → confirm the new row appears in
**Published workflows** → drop the URL into Claude Desktop / Cursor or
hit it with curl as above → **Revoke** to invalidate the URL.

## Tests

| Layer | File | What |
| --- | --- | --- |
| Server unit | `apps/server/src/published-workflows.test.ts` | 7 tests — empty start, create returns issued token + hides hash, list filters by workspace, findByToken hashes input, revoke invalidates, persistence across instances |
| Server HTTP e2e | `apps/server/src/published-mcp.e2e.test.ts` | 9 tests — admin create + list, missing skillName 400, unknown token 401, MCP `initialize` / `tools/list` / `tools/call` / unknown-tool `-32602`, DELETE 204, revoke breaks the token. Uses an in-process fake OpenCode `Bun.serve` |

## Verification

```text
pnpm --filter openwork-server typecheck     # clean
pnpm --filter @openwork/app   typecheck     # clean
bun test                                    # 132 pass, 0 fail
```

Also confirmed against a running local server:

- Server admin routes (`list / create / delete`) and MCP routes
  (`initialize / tools/list / tools/call`) succeed against a live
  workspace with a managed OpenCode (transcript:
  `published-workflows-mcp.curl.txt`).
- Manual UI walkthrough (publish → copy URL → list → revoke) executed
  end-to-end against a `pnpm --filter @openwork/app dev` instance
  pointed at the local server.

## Non-goals (follow-ups)

- Multi-tool publications (one workflow = one tool today).
- OAuth / DCR — bearer-style URL token is enough for MVP.
- Streaming partial results back over SSE — sync `/prompt` is the MVP.
- Public marketplace surface — out of scope; this is private per token.
- Per-call billing / metering — Den-team territory.
