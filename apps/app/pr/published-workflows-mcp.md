# Publish OpenWork workflows as MCP-callable tools

Closes: N/A — Path B submission / exploratory product PR.

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

```
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

## UI (next half)

Skills view at `apps/app/src/react-app/domains/settings/pages/skills-view.tsx`
gains a **Publish** action per skill plus a "Published workflows" panel
listing active publications with copy-URL and revoke. i18n keys land
under `settings.publishedWorkflows.*` mirroring the env-vars precedent.
Implementation lives in the follow-up commit so this PR is reviewable in
two passes.

## Tests

| Layer | File | What |
| --- | --- | --- |
| Server unit | `apps/server/src/published-workflows.test.ts` | 7 tests — empty start, create returns issued token + hides hash, list filters by workspace, findByToken hashes input, revoke invalidates, persistence across instances |
| Server HTTP e2e | `apps/server/src/published-mcp.e2e.test.ts` | 9 tests — admin create + list, missing skillName 400, unknown token 401, MCP `initialize` / `tools/list` / `tools/call` / unknown-tool `-32602`, DELETE 204, revoke breaks the token. Uses an in-process fake OpenCode `Bun.serve` |

## Verification

```
pnpm --filter openwork-server typecheck     # clean
bun test                                    # 132 pass, 0 fail
```

## Non-goals (follow-ups)

- Multi-tool publications (one workflow = one tool today).
- OAuth / DCR — bearer-style URL token is enough for MVP.
- Streaming partial results back over SSE — sync `/prompt` is the MVP.
- Public marketplace surface — out of scope; this is private per token.
- Per-call billing / metering — Den-team territory.
