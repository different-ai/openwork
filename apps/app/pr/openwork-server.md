# OpenWork Server
Bridge missing capabilities between OpenWork and OpenCode

---
## Summarize
Introduce an OpenWork server layer that fills gaps in OpenCode APIs, enabling remote clients to manage workspace config, skills, plugins, and MCPs without direct filesystem access.

---
## Define problem
Remote clients cannot read or write workspace config because critical state lives in the filesystem. OpenWork needs a safe, minimal surface to access and mutate config, skills, plugins, and MCPs when connected to a host.

---
## Set goals
- Bridge OpenWork needs that OpenCode does not expose today
- Enable remote clients to view and update workspace config safely
- Keep the surface minimal, auditable, and aligned to OpenCode primitives

---
## Mark non-goals
- Replacing OpenCode's server or duplicating its APIs
- Arbitrary filesystem access outside approved workspace roots
- Hosting multi-tenant or cloud-managed instances

---
## Describe personas
- Remote client user: needs visibility into installed skills/plugins while connected
- Host operator: wants safe, explicit control over config changes

---
## List requirements
- Functional: expose workspace config read/write APIs for `.opencode` and `opencode.json`
- Functional: list installed skills, plugins, MCPs for a workspace without direct FS access
- Functional: allow saving new skills, plugins, and MCP entries from a remote client
- Functional: host mode auto-starts the OpenWork server alongside the OpenCode engine
- UX: surface pairing URL + tokens in Settings for host mode
- UX: show remote-config origin, last updated time, and change attribution

---
## Define API (initial)
All endpoints are scoped to an approved workspace root and require host approval for writes.

When OpenCode already exposes a stable API (agents, skills, MCP status), prefer OpenCode directly and avoid duplicating it here. This server only covers filesystem-backed gaps.

### API conventions
- Base URL: provided by the host during pairing (e.g., `http://host:PORT/openwork`)
- Content-Type: `application/json`
- Auth: bearer token issued during pairing (`Authorization: Bearer <token>`)
- Errors: JSON body with `{ code, message, details? }`
- All writes require explicit host approval and return `403` when denied

### Workspaces (discovery)
- `GET /workspaces` -> list known workspaces on the host
  - Response fields align with `WorkspaceInfo` (id, name, path, workspaceType, baseUrl?, directory?)
  - Used by remote clients to select a workspace without filesystem access

### Health
- `GET /health` -> { ok, version, uptimeMs }

### Capabilities
- `GET /capabilities` -> { skills: { read, write, source }, plugins: { read, write }, mcp: { read, write }, commands: { read, write }, config: { read, write } }
- `source` indicates whether OpenCode or OpenWork server is the authoritative API

### Workspace config
- `GET /workspace/:id/config` -> returns parsed `opencode.json` + `.opencode/openwork.json`
- `PATCH /workspace/:id/config` -> merges and writes config (write approval required)
  - Request body: `{ opencode?: object, openwork?: object }`
  - Merge strategy: shallow merge at top-level keys; arrays replaced (aligns with OpenCode config behavior)
  - Response: `{ opencode, openwork, updatedAt }`
  - Only project config is writable by default; global config requires explicit host-only scope

### Skills
- Prefer OpenCode skills API when available; OpenWork server only fills local FS gaps.
- `GET /workspace/:id/skills` -> list skill metadata from `.opencode/skills` (fallback only)
- `POST /workspace/:id/skills` -> add/update skill file(s) (write approval required, fallback only)
  - Request body: `{ name, content, description? }`
  - Writes to `.opencode/skills/<name>/SKILL.md`
  - Response: `{ name, path, description, scope }`

### Plugins
- `GET /workspace/:id/plugins` -> list configured plugins from `opencode.json`
- `POST /workspace/:id/plugins` -> add plugin entry to config (write approval required)
- `DELETE /workspace/:id/plugins/:name` -> remove plugin entry (write approval required)
  - Request body (POST): `{ spec }` where `spec` is a plugin string (npm or file URL)
  - Response: `{ items: [{ spec, source, scope, path? }], loadOrder: string[] }`
  - Server de-dupes by normalized name (strip version where possible)

### MCPs
- Prefer OpenCode MCP APIs for status/runtime; OpenWork server only reads/writes config.
- `GET /workspace/:id/mcp` -> list configured MCP servers
- `POST /workspace/:id/mcp` -> add MCP config entry (write approval required)
- `DELETE /workspace/:id/mcp/:name` -> remove MCP config entry (write approval required)
  - Request body (POST): `{ name, config }` where `config` matches `McpServerConfig`
  - Response: `{ items: [{ name, config, source }] }`

### Agents
- Prefer OpenCode agents API; no OpenWork server endpoints needed unless OpenCode lacks coverage for remote clients.

### Commands
- `GET /workspace/:id/commands` -> list commands from `.opencode/commands` (fallback only)
  - Optional query: `scope=workspace|global` (global requires host-only approval)
- `POST /workspace/:id/commands` -> create/update command (write approval required)
- `DELETE /workspace/:id/commands/:name` -> delete command (write approval required)
  - Request body (POST): `{ name, description?, template, agent?, model?, subtask? }`
  - Server writes `.opencode/commands/<name>.md` with YAML frontmatter

---
## OpenCode behavior reference (from docs)
This section captures the exact OpenCode semantics the OpenWork server must respect.

### Plugins
- Config list: `opencode.json` -> `plugin` field. Can be string or string[].
- Local plugin folders:
  - Project: `.opencode/plugins/`
  - Global: `~/.config/opencode/plugins/`
- Load order (all hooks run in sequence):
  1) Global config `~/.config/opencode/opencode.json`
  2) Project config `opencode.json`
  3) Global plugin dir `~/.config/opencode/plugins/`
  4) Project plugin dir `.opencode/plugins/`
- NPM plugins are installed automatically using Bun at startup.
- Cached node_modules live in `~/.cache/opencode/node_modules/`.
- Local plugins can use dependencies listed in `.opencode/package.json`.
- Duplicate npm packages with the same name+version load once; local and npm with similar names both load.

### Skills
- Skill discovery paths (project):
  - `.opencode/skills/<name>/SKILL.md`
  - `.claude/skills/<name>/SKILL.md`
- Skill discovery paths (global):
  - `~/.config/opencode/skills/<name>/SKILL.md`
  - `~/.claude/skills/<name>/SKILL.md`
- Discovery walks up from current working directory to git worktree root.
- `SKILL.md` must include YAML frontmatter with `name` and `description`.
- Name constraints:
  - 1-64 chars
  - lowercase alphanumeric with single hyphen separators
  - must match directory name
  - regex: `^[a-z0-9]+(-[a-z0-9]+)*$`
- Description length: 1-1024 chars.
- Permissions: `opencode.json` `permission.skill` supports `allow`, `deny`, `ask` patterns.

### MCP servers
- Config lives in `opencode.json` under `mcp` object.
- Local MCP fields: `type: "local"`, `command[]`, optional `environment`, `enabled`, `timeout`.
- Remote MCP fields: `type: "remote"`, `url`, optional `headers`, `oauth`, `enabled`, `timeout`.
- `oauth: false` disables automatic OAuth detection.
- Remote defaults can be provided via `.well-known/opencode`; local config overrides.
- MCP tools can be disabled globally in `tools` via glob patterns.
- Per-agent tool enabling overrides global settings.

### OpenCode server APIs
- OpenCode already exposes: `/config`, `/mcp` (runtime), `/agent`, `/command` (list), `/session`.
- OpenWork server should prefer OpenCode APIs for runtime status and only handle FS-backed config gaps.
- When reading config, prefer OpenCode `/config` to capture precedence (remote defaults + global + project).
- When writing, only modify project `opencode.json` to avoid clobbering upstream defaults.
- `/command` is list-only; OpenWork server adds create/delete via filesystem for remote clients.

### Config precedence (reference)
- Remote defaults from `.well-known/opencode`
- Global config `~/.config/opencode/opencode.json`
- Project config `opencode.json`
- `.opencode/` directories and inline env overrides
- OpenWork server should preserve this ordering when presenting config sources

---
## OpenCode server alignment (from docs)
- OpenCode runs an HTTP server via `opencode serve` (default `127.0.0.1:4096`).
- `--cors` can be used to allow browser origins; OpenWork should align with that for web clients.
- Basic auth can be enabled via `OPENCODE_SERVER_PASSWORD` (username defaults to `opencode`).
- The OpenWork server should not bypass OpenCode auth; if OpenCode is password-protected, the host UI must collect credentials and pass them to the client.
- OpenCode publishes its OpenAPI spec at `/doc`; the OpenWork server should track upstream changes and avoid duplicating stable APIs.

---
## Host auto-start + pairing UX
- When OpenWork runs in Host mode, it starts the OpenWork server automatically after the OpenCode engine comes online.
- The host UI exposes a pairing card in Settings with:
  - OpenWork Server URL (prefers `.local` hostname, falls back to LAN IP)
  - Client token (for remote devices)
  - Host token (for approvals)
- Tokens are generated per run unless supplied by host config.
- Pairing info should be copyable (tap-to-copy) and masked by default.

---
## Endpoint examples (requests and responses)
### List workspaces
Request:
```
GET /workspaces
Authorization: Bearer <token>
```
Response:
```json
{
  "items": [
    { "id": "ws_1", "name": "Finance", "path": "/Users/susan/Finance", "workspaceType": "local" },
    { "id": "ws_2", "name": "Remote Ops", "path": "/Users/bob/Shared", "workspaceType": "remote", "baseUrl": "http://10.0.0.8:4096" }
  ]
}
```

### Get config
Request:
```
GET /workspace/ws_1/config
```
Response:
```json
{
  "opencode": { "plugin": ["opencode-github"], "mcp": { "chrome": { "type": "local", "command": ["npx", "-y", "chrome-devtools-mcp@latest"] } } },
  "openwork": { "version": 1, "authorizedRoots": ["/Users/susan/Finance"] }
}
```

### Patch config
Request:
```json
PATCH /workspace/ws_1/config
{ "opencode": { "plugin": ["opencode-github", "opencode-notion"] } }
```
Response:
```json
{ "updatedAt": 1730000000000 }
```

### Add plugin
Request:
```json
POST /workspace/ws_1/plugins
{ "spec": "opencode-notion" }
```
Response:
```json
{
  "items": [
    { "spec": "opencode-github", "source": "config", "scope": "project" },
    { "spec": "opencode-notion", "source": "config", "scope": "project" }
  ],
  "loadOrder": ["config.global", "config.project", "dir.global", "dir.project"]
}
```

### Add skill
Request:
```json
POST /workspace/ws_1/skills
{ "name": "expense-audit", "content": "# Expense Audit\n..." }
```
Response:
```json
{ "name": "expense-audit", "path": ".opencode/skills/expense-audit", "description": "Audit expenses...", "scope": "project" }
```

### Add MCP server
Request:
```json
POST /workspace/ws_1/mcp
{ "name": "chrome", "config": { "type": "local", "command": ["npx", "-y", "chrome-devtools-mcp@latest"] } }
```
Response:
```json
{ "items": [{ "name": "chrome", "config": { "type": "local", "command": ["npx", "-y", "chrome-devtools-mcp@latest"] }, "source": "config.project" }] }
```

### Add command
Request:
```json
POST /workspace/ws_1/commands
{ "name": "daily-report", "description": "Daily report", "template": "summarize yesterday", "agent": "default" }
```
Response:
```json
{ "items": [{ "name": "daily-report", "description": "Daily report", "template": "summarize yesterday", "agent": "default", "scope": "workspace" }] }
```

---
## Outline integration
- Host side: OpenWork server exposes a narrow API layer on top of OpenCode
- Implementation: Bun-based server initially, shipped as a sidecar inside the OpenWork desktop app
- Client side: OpenWork UI uses this layer when remote, falls back to FS when local
- Storage: persists changes to `.opencode` and `opencode.json` within workspace root

---
## Server runtime and sidecar lifecycle
- The desktop app launches the OpenWork server as a sidecar process.
- The server binds to localhost on an ephemeral port and reports its URL back to the host UI.
- The host UI includes the OpenWork server URL in the pairing payload for remote clients.
- On crash, the host restarts the server and re-issues capabilities.
- The server must never expose filesystem paths outside approved workspace roots.

---
## Workspace identity and scoping
- Workspaces are referenced by `workspace.id` (stable hash of the workspace path).
- Remote clients fetch the list via `GET /workspaces` and select a target id.
- Each request includes `workspaceId` in the path; server resolves to a validated root.
- If the workspace is missing or not authorized, return `404` or `403`.

---
## Authentication and pairing
- The host generates a short-lived pairing token and includes the OpenWork server base URL in the pairing payload.
- Remote clients store the token in memory (not on disk) and send it as `Authorization: Bearer <token>`.
- Tokens are scoped to the host and expire on disconnect or after a short TTL (e.g., 24h).
- The OpenWork server rejects requests without a valid token (`401`).
- Future: rotate tokens on reconnect and support revocation from host settings.

---
## Capability schema (example)
```json
{
  "skills": { "read": true, "write": true, "source": "openwork" },
  "plugins": { "read": true, "write": true },
  "mcp": { "read": true, "write": true },
  "commands": { "read": true, "write": true },
  "config": { "read": true, "write": true }
}
```

---
## Audit log format (example)
```json
{
  "id": "audit_123",
  "workspaceId": "ws_abc",
  "actor": { "type": "remote", "clientId": "client_1" },
  "action": "plugins.add",
  "target": "opencode.json",
  "summary": "Added opencode-github",
  "timestamp": 1730000000000
}
```

---
## Web app integration
- Remote clients connect to both OpenCode (engine) and OpenWork server (config layer)
- Capability check gates UI actions: if OpenWork server is missing, config actions are read-only
- Writes require host approval and are surfaced in the audit log
- Future: this evolves into a sync layer across clients (out of scope here)

---
## Client caching and consistency
- Cache the last successful config snapshot per workspace in local state.
- On write success, refresh via `GET /workspace/:id/config` before updating UI.
- Use optimistic UI only for read-only lists; for writes, wait for approval + server response.
- If OpenWork server is unreachable, show read-only data and a reconnect CTA.

---
## Sequence flows (examples)
### Add plugin (remote)
1) User clicks “Add plugin” in Plugins page.
2) `context/extensions.ts` calls `POST /workspace/:id/plugins` with `{ spec }`.
3) Server requests host approval; host approves.
4) Server writes `opencode.json`, returns updated list.
5) Client refreshes plugins list and shows success toast.

### Add skill (remote)
1) User uploads a skill in Skills page.
2) Client sends `POST /workspace/:id/skills` with `{ name, content }`.
3) Server writes `.opencode/skills/<name>/SKILL.md` after approval.
4) Client refreshes skills list.

### Add MCP (remote)
1) User fills MCP config form.
2) Client sends `POST /workspace/:id/mcp` with `{ name, config }`.
3) Server merges into `opencode.json` and returns updated list.
4) UI shows “Reload engine” banner if required.

---
## OpenWork UI wiring (specific)
These are the concrete integration points inside `packages/app`.

### Data layer
- `src/app/lib/opencode.ts`: keep as-is for OpenCode engine calls
- `src/app/lib/tauri.ts`: host-only FS actions (local) stay here
- **New** `src/app/lib/openwork-server.ts`: remote config API client (HTTP) + capability check

Example client surface (TypeScript):
```ts
type Capabilities = {
  skills: { read: boolean; write: boolean; source: "opencode" | "openwork" };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
};

export const openworkServer = {
  health(): Promise<{ ok: boolean; version: string; uptimeMs: number }>;
  capabilities(): Promise<Capabilities>;
  listWorkspaces(): Promise<WorkspaceInfo[]>;
  getConfig(id: string): Promise<{ opencode: object; openwork: object }>;
  patchConfig(id: string, body: { opencode?: object; openwork?: object }): Promise<void>;
  listPlugins(id: string): Promise<string[]>;
  addPlugin(id: string, spec: string): Promise<string[]>;
  removePlugin(id: string, name: string): Promise<string[]>;
  listSkills(id: string): Promise<SkillCard[]>;
  upsertSkill(id: string, payload: { name: string; content: string }): Promise<SkillCard>;
  listMcp(id: string): Promise<McpServerEntry[]>;
  addMcp(id: string, payload: { name: string; config: McpServerConfig }): Promise<McpServerEntry[]>;
  removeMcp(id: string, name: string): Promise<McpServerEntry[]>;
  listCommands(id: string): Promise<WorkspaceCommand[]>;
  upsertCommand(id: string, payload: WorkspaceCommand): Promise<WorkspaceCommand[]>;
  deleteCommand(id: string, name: string): Promise<void>;
};
```

### State stores
- `src/app/context/workspace.ts`: route remote config reads/writes to OpenWork server when workspaceType is `remote`
- `src/app/context/extensions.ts`: use OpenWork server to list/add skills/plugins/MCPs in remote mode
- `src/app/context/session.ts`: no changes; stays on OpenCode engine

### UI surfaces
- `src/app/pages/dashboard.tsx`: display workspace config status + enable “Share config” only when supported
- `src/app/pages/skills.tsx`: list and import skills via OpenWork server in remote mode
- `src/app/pages/plugins.tsx`: list/add/remove plugins via OpenWork server in remote mode
- `src/app/pages/mcp.tsx`: list/connect MCPs via OpenWork server in remote mode
- `src/app/pages/commands.tsx`: list/add/remove commands via OpenWork server in remote mode
- `src/app/pages/session.tsx`: surface agent list/selection via OpenWork server when remote if OpenCode lacks agent APIs
- `src/app/components/workspace-chip.tsx` + `workspace-picker.tsx`: show capability badges (read-only if server missing)

### Capability checks
- On connect, call `GET /health` on OpenWork server
- Store a `serverCapabilities` flag in app state and guard remote config actions

---
## Detailed wiring notes
This section explains exactly how requests flow and where the UI switches between local FS and the OpenWork server.

### Connection flow (remote)
1) User connects to a host (OpenCode engine). The client already has a base URL for OpenCode.
2) The client derives or receives the OpenWork server base URL from the host pairing payload.
3) The client calls `GET /health` and `GET /capabilities` on the OpenWork server.
4) UI stores `openworkServerStatus` (ok/error) and `openworkServerCapabilities` in app state.
5) All config-mutating UI surfaces check capabilities before enabling write actions.

### Local vs remote switching
- **Local workspaces**: use Tauri FS helpers (existing `src/app/lib/tauri.ts`).
- **Remote workspaces**: route all config reads/writes through `src/app/lib/openwork-server.ts`.
- The decision happens in the stores, not the UI, so pages don’t need to branch on runtime.

### Store-level routing (concrete)
- `context/extensions.ts`
  - `refreshSkills()` uses OpenWork server when remote, else lists local skills from FS.
  - `refreshPlugins()` pulls config from OpenWork server in remote mode, else reads `opencode.json` locally.
  - `refreshMcpServers()` reads MCP config from OpenWork server in remote mode, else from FS.
- `context/workspace.ts`
  - Loads `openwork.json` and `opencode.json` from OpenWork server when remote.
  - On writes, calls OpenWork server endpoints and refreshes local state on success.
- `context/commands.ts`
  - `list`, `create`, and `delete` commands via OpenWork server when remote.

### Action mapping (UI -> endpoint -> file)
- Add plugin (Plugins page) -> `POST /workspace/:id/plugins` -> `opencode.json` `plugin` array
- Remove plugin -> `DELETE /workspace/:id/plugins/:name` -> `opencode.json` `plugin` array
- Add MCP server -> `POST /workspace/:id/mcp` -> `opencode.json` `mcp` map
- Remove MCP -> `DELETE /workspace/:id/mcp/:name` -> `opencode.json` `mcp` map
- Add skill -> `POST /workspace/:id/skills` -> `.opencode/skills/<name>/SKILL.md`
- Add command -> `POST /workspace/:id/commands` -> `.opencode/commands/<name>.md`

### UI wiring expectations
- Pages call store methods without caring about local vs remote.
- “Read-only” badges are derived from `openworkServerCapabilities` (e.g. missing `config.write`).
- “Share config” and any write action is disabled when capabilities are absent.

### Permissions and approvals
- Any write request from a remote client triggers a host approval prompt.
- The host UI should show: action type, target workspace, and files to be written.
- If approval is denied or times out, the server returns a clear error and the UI shows a non-blocking toast.

### Data contracts (expected formats)
These map to existing OpenWork types.

**Plugins**
- Source of truth: `opencode.json` → `plugin` field (string or string[]).
- Response shape:
```json
{
  "items": [
    { "spec": "opencode-github", "source": "config", "scope": "project" },
    { "spec": "file:///path/to/plugin.js", "source": "dir.project", "scope": "project", "path": ".opencode/plugins/custom.js" }
  ],
  "loadOrder": ["config.global", "config.project", "dir.global", "dir.project"]
}
```

**Skills**
- Source of truth: `.opencode/skills/<name>/SKILL.md`.
- Response shape:
```json
{
  "items": [
    { "name": "my-skill", "path": ".opencode/skills/my-skill", "description": "...", "scope": "project" },
    { "name": "global-skill", "path": "~/.config/opencode/skills/global-skill", "description": "...", "scope": "global" }
  ]
}
```

**MCP**
- Source of truth: `opencode.json` → `mcp` object.
- Response shape:
```json
{
  "items": [
    {
      "name": "chrome",
      "config": { "type": "local", "command": ["npx", "-y", "chrome-devtools-mcp@latest"], "enabled": true },
      "source": "config.project"
    }
  ]
}
```

**Commands**
- Source of truth: `.opencode/commands/<name>.md` with frontmatter.
- Response shape:
```json
{
  "items": [
    { "name": "daily-report", "description": "...", "template": "...", "agent": "default", "model": null, "subtask": false, "scope": "workspace" }
  ]
}
```

**Agents**
- Prefer OpenCode SDK (`listAgents`) as the primary source.
- Only add OpenWork server agent endpoints if OpenCode doesn’t expose them for remote clients.

---
## Write approval flow (detailed)
1) Client sends a write request (POST/PATCH/DELETE).
2) OpenWork server emits a permission request to the host UI with:
   - action (write type), workspace id, list of file paths, and summary of changes
3) Host approves or denies within a timeout window.
4) Server executes the write only after approval and records an audit log entry.
5) Client receives success or `403` with a reason and shows a toast.

Approval response schema (host -> server):
```json
{ "requestId": "...", "reply": "allow" | "deny" }
```

---
## Config merge rules (detailed)
- `opencode.json` is parsed as JSONC to preserve comments where possible.
- Writes are shallow merges at top-level keys; arrays replace existing values.
- Unknown keys are preserved.
- On parse errors, the server returns `422` with the error location.

Example: adding a plugin
```json
{ "plugin": ["opencode-github"] }
```
Server behavior:
- Read current `opencode.json`
- Normalize plugin list, append new spec if missing
- Write updated JSONC back to disk

---
## Validation rules (initial)
- Plugin spec: non-empty string; if duplicate, no-op.
- Skill name: kebab-case; 1-64 chars; must match folder name; regex `^[a-z0-9]+(-[a-z0-9]+)*$`.
- Skill description: 1-1024 chars, required in frontmatter.
- MCP name: `^[A-Za-z0-9_-]+$`, cannot start with `-`.
- MCP config: `type` required; for `local` require `command[]`; for `remote` require `url`.
- Commands: name sanitized to `[A-Za-z0-9_-]`; template required.
- Reject any path traversal (`..`) or absolute paths in payloads.

---
## Plugin handling (detailed)
- `plugin` list in `opencode.json` is treated as the source of npm plugins.
- Specs may be unscoped or scoped npm packages (e.g., `opencode-wakatime`, `@my-org/custom-plugin`).
- Specs may also be file URLs or absolute paths when supported by OpenCode.
- Local plugin files are discovered in `.opencode/plugins/` and `~/.config/opencode/plugins/`.
- Only JavaScript/TypeScript files are treated as plugins (`.js`, `.ts`).
- The OpenWork server should return both config plugins and local plugin files, with a `source` field:
  - `config` for npm specs
  - `dir.project` for `.opencode/plugins/`
  - `dir.global` for `~/.config/opencode/plugins/`
- The UI can display these as separate sections while preserving OpenCode load order.
- The server should not run `bun install`; OpenCode handles installs on startup.
- If `.opencode/package.json` is present, note it in responses so the UI can link to dependency setup.
- Plugin runtime behavior (events, custom tools, logging) remains owned by OpenCode; OpenWork server only manages config.

---
## Skill handling (detailed)
- Discovery must match OpenCode:
  - Walk up from the workspace root to the git worktree root.
  - Include any `.opencode/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md`.
- Include global skills from `~/.config/opencode/skills/*/SKILL.md` and `~/.claude/skills/*/SKILL.md`.
- Validate frontmatter fields:
  - `name` and `description` required
  - `license`, `compatibility`, `metadata` optional
- Enforce name and description length rules on write.
- The OpenWork server does not parse or interpret skill content beyond frontmatter extraction.

---
## MCP handling (detailed)
- Read `mcp` config from `opencode.json`.
- Preserve `enabled`, `environment`, `headers`, `oauth`, and `timeout` fields.
- If OpenCode provides remote defaults via `.well-known/opencode`, treat those as `source: "config.remote"`.
- Writes always go to project `opencode.json` and should not mutate remote defaults.
- If MCP tools are disabled via `tools` glob patterns, surface that as `disabledByTools: true` in responses.
- OAuth tokens are managed by OpenCode and stored in `~/.local/share/opencode/mcp-auth.json`; OpenWork server should not manage tokens directly.
- Authentication flows should be triggered via OpenCode (`/mcp` endpoints or CLI), not via OpenWork server.
- Reference CLI flows: `opencode mcp auth <name>`, `opencode mcp list`, `opencode mcp logout <name>`, `opencode mcp debug <name>`.

---
## Commands handling (detailed)
- Commands are markdown files with YAML frontmatter.
- The server should sanitize command names to `[A-Za-z0-9_-]` and strip leading `/`.
- The command template is the body after frontmatter and is required.
- Workspace scope lives under `.opencode/commands/` in the project.
- Global scope lives under `~/.config/opencode/commands/` and should be disabled by default for remote clients.

---
## Path safety
- All write targets are resolved under the workspace root.
- The server verifies the resolved path begins with the workspace root.
- Any violation returns `400` with a safe error message.

---
## Error codes
- `400` invalid request payload
- `401` missing/invalid token
- `403` write denied or capability missing
- `404` workspace not found
- `409` conflict (concurrent edit detected)
- `422` config parse/validation error
- `500` unexpected server error

---
## Implementation checklist
### Server runtime (Bun)
- Create `packages/openwork-server` with HTTP routing + JSON schema validation
- Define stable port + discovery mechanism for clients
- Add lifecycle hooks: start/stop/restart + health checks

### Auth + handshake
- Pairing token or session key for remote clients
- `GET /capabilities` endpoint to drive UI gating
- CORS rules and origin allowlist for web clients

### Permissions + audit
- Host approval for any write request
- Audit log for config mutations (who/what/when)
- Clear denial/error propagation to clients

### Filesystem writes
- Workspace-root scoping + path validation
- Config merge rules aligned to OpenCode
- Serialization helpers for:
  - `.opencode/skills/<name>/SKILL.md`
  - `.opencode/commands/<name>.md` (frontmatter)
  - `opencode.json` plugin + mcp updates

### UI wiring
- Add `src/app/lib/openwork-server.ts` client
- Route remote mode reads/writes through OpenWork server:
  - `src/app/context/extensions.ts`
  - `src/app/context/workspace.ts`
  - `src/app/pages/commands.tsx`
- UI gating badges for missing capabilities

### Resilience
- Retry/backoff for transient network errors
- Conflict handling for concurrent writes
- Friendly errors for missing workspace roots

### Packaging
- Bundle Bun server as a desktop sidecar
- Wire sidecar launch + permissions in Tauri config

---
## Testing strategy
### Unit tests (server)
- Config merge rules (arrays replace, unknown keys preserved)
- Validation rules for skill/plugin/mcp/command names
- Path safety checks (reject absolute paths and path traversal)

### Filesystem tests (local)
- Create a temp workspace with `.opencode/` and `opencode.json`
- Verify `GET /workspace/:id/plugins` reflects:
  - plugin list from `opencode.json`
  - local plugin files in `.opencode/plugins`
  - global plugin files from `~/.config/opencode/plugins` (optional, behind a flag)
- Verify plugin list preserves OpenCode load order metadata
- Verify `GET /workspace/:id/skills` returns:
  - `.opencode/skills/*/SKILL.md`
  - `.claude/skills/*/SKILL.md`
  - global skills from `~/.config/opencode/skills` (optional)
- Verify skill discovery respects git worktree boundary (walk up to `.git` only)
- Verify skill frontmatter parsing and name/description constraints
- Verify `.opencode/package.json` is detected and reported when present

### Integration tests (server + FS)
- Start server against a temp workspace; verify read/write endpoints
- Ensure writes only affect `.opencode` and `opencode.json`
- Verify audit log entries for each write action
- Validate local plugin discovery only includes `.js` and `.ts`
- Validate MCP config writes preserve `enabled` and `oauth` fields

### Approval flow tests
- Write request triggers approval prompt
- Deny returns `403` and no file is written
- Approve writes file and returns success

### Client wiring tests (OpenWork web)
- Remote mode uses OpenWork server endpoints instead of Tauri FS
- Missing capability switches UI to read-only
- Reconnect restores write actions after capabilities return
- OpenCode basic auth prompts propagate to client when enabled

### Sidecar lifecycle tests
- Server starts on app launch and reports base URL
- Crash triggers restart and new capabilities handshake

---
## Test cases (initial)
### Config
- `GET /workspace/:id/config` returns both `opencode` and `openwork` blocks
- `PATCH /workspace/:id/config` updates plugin list and preserves unknown keys
- Invalid JSONC returns `422` with parse location
- Remote defaults from `.well-known/opencode` appear as `source: config.remote` in responses
- Writes only update project `opencode.json`, leaving remote defaults unchanged

### Plugins
- Add plugin appends to list and de-dupes existing spec
- Remove plugin deletes only matching spec
- Invalid spec returns `400`
- Local plugin files are returned with `source: dir.project`
- Global plugin files are returned with `source: dir.global` when enabled
- Non-js/ts files in plugin dirs are ignored

### Skills
- Add skill writes `SKILL.md` with kebab-case name validation
- List skills returns `name`, `path`, and `description`
- Invalid skill name returns `400`
- Missing frontmatter fields return `422`
- Skill name mismatch with folder returns `400`

### MCP
- Add MCP writes to `opencode.json` under `mcp` map
- Invalid MCP name returns `400`
- Remove MCP deletes entry and returns updated list
- `enabled: false` is preserved in responses
- `oauth: false` is preserved in responses
- Missing `command` for `type: local` returns `400`
- Missing `url` for `type: remote` returns `400`
- `tools` glob disables MCP entries and marks them as `disabledByTools: true`

### Commands
- Create command writes `.opencode/commands/<name>.md`
- Delete command removes file and returns success
- Invalid template returns `400`
- Name with leading `/` is sanitized

### Permissions
- Denied approval returns `403` and no file changes
- Approval timeout returns `403` with timeout reason

### Security
- Path traversal payload returns `400` and is logged
- Workspace id mismatch returns `404`

### UI
- Remote client with OpenWork server: write actions enabled
- Remote client without OpenWork server: write actions disabled + read-only badge

---
## Set permissions
- Explicit approval for any config write originating from a remote client
- Scope-limited to the active workspace root only

---
## Cover data
- Audit log of config changes (who, what, when)
- Optional telemetry for success/failure counts, opt-in only

---
## Map flow
- Connect: remote client connects to host with capability check
- View: UI shows skills/plugins/MCPs from server API
- Update: user adds skill/plugin/MCP, server validates + writes config, UI refreshes

---
## Note risks
- Over-expanding API surface could drift from OpenCode primitives
- Mis-scoped writes could affect unrelated projects

---
## Ask questions
- Which config surfaces should be writable vs read-only initially?
- Should writes be batched or immediate per action?

---
## Measure success
- Remote users can view skills/plugins/MCPs without filesystem access
- Remote users can add a skill/plugin/MCP with a single approval

---
## Plan rollout
- Phase 0: Bun server prototype running alongside OpenWork host
- Phase 1: read-only APIs for skills/plugins/MCPs + config metadata
- Phase 2: write APIs for skills/plugins/MCPs with audit log
- Phase 3: config export/import support for remote clients
- Phase 4: bundle as a first-class sidecar in desktop builds
