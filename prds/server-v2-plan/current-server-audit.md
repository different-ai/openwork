# Current Server Audit

## Scope

This audit covers the current server under `apps/server/**`.

The goal is to document the current server in the same framework as the other audits:

- what the major function/module is
- what it does in human-readable language
- where it is called from and when
- what it ultimately calls or affects

This is meant to help break down the current server into clear migration targets for the new server.

## Overall Shape

- The current server is still a Bun-first, custom-router server centered in `apps/server/src/server.ts`.
- Most meaningful behavior is implemented through one large route-registration function, `createRoutes`, plus focused modules for config mutation, OpenCode integration, auth/tokens, reload/watch behavior, portable export/import, and OpenCode Router bridging.
- The earlier in-place `/v2` scaffold under `apps/server/src/v2` has been removed. The real replacement server now lives separately under `apps/server-v2/**`.

## 1. Startup, CLI, Config, And Process Boot

### `src/cli.ts` main entrypoint

- What it is: the packaged/server CLI entrypoint.
- What it does: parses startup args, resolves runtime config, starts the server, and prints startup information.
- Called from and when: called when the `openwork-server` binary or `bun src/cli.ts` is launched.
- What it calls: `parseCliArgs`, `resolveServerConfig`, `createServerLogger`, and `startServer`.

### `parseCliArgs`

- What it is: CLI argument parser.
- What it does: turns command-line flags into normalized runtime options.
- Called from and when: called immediately at process startup.
- What it calls: feeds `resolveServerConfig` with host/port/token/workspace/OpenCode/logging overrides.

### `resolveServerConfig`

- What it is: config resolution pipeline.
- What it does: merges CLI args, env vars, and config file state into the final runtime config.
- Called from and when: called once during boot before the server starts.
- What it calls: `buildWorkspaceInfos`, token defaults, approval/cors/logging/read-only/authorized-roots setup.

### `buildWorkspaceInfos`

- What it is: workspace config normalizer.
- What it does: turns configured workspace records into normalized `WorkspaceInfo` objects with stable IDs.
- Called from and when: called while building the final server config.
- What it calls: produces the workspace metadata used by routing, auth, proxying, export/import, and runtime flows.

### `createServerLogger`

- What it is: server logging factory.
- What it does: creates either plain text or OTEL-style JSON logging with a run ID.
- Called from and when: called during startup and reused for request logging.
- What it calls: all startup, request, and reload-watcher logs.

### `startServer`

- What it is: main server boot function.
- What it does: initializes approvals, reload events, tokens, watchers, route registration, and starts Bun HTTP serving.
- Called from and when: called once after config resolution.
- What it calls: Bun `serve`, `ApprovalService`, `TokenService`, `ReloadEventStore`, `startReloadWatchers`, proxy behavior, and all legacy routes.

## 2. HTTP Routing And Request Dispatch

### `startServer(...).fetch`

- What it is: the top-level Bun request handler.
- What it does: handles every incoming request, applies CORS and request logging, routes mounted workspace paths, proxies OpenCode/OpenCode Router requests, and finally dispatches to legacy routes.
- Called from and when: called by Bun for every HTTP request.
- What it calls: `parseWorkspaceMount`, OpenCode proxy helpers, OpenCode Router proxy helpers, and `createRoutes` matches.

### `parseWorkspaceMount`

- What it is: mounted-workspace path parser.
- What it does: detects workspace-mounted URLs like `/w/:id/...`.
- Called from and when: called early in request dispatch.
- What it calls: enables single-workspace mounted base URL behavior.

### `createRoutes`

- What it is: the current legacy route registration map.
- What it does: defines the bulk of the server API surface: status, tokens, workspaces, config, sessions, router, files, skills, plugins, MCP, export/import, approvals, and more.
- Called from and when: called once at startup.
- What it calls: nearly every major subsystem in the current server.

### `withCors`

- What it is: response header helper.
- What it does: adds CORS headers based on configured allowlist.
- Called from and when: applied to every response in the dispatcher finalization path.
- What it calls: browser access policy for the server surface.

### `logRequest`

- What it is: per-request log helper.
- What it does: emits structured request logs with auth/proxy metadata.
- Called from and when: called after each request resolves or fails.
- What it calls: operational visibility into status/auth/proxy usage.

## 3. Auth, Tokens, And Approvals

### `TokenService`

- What it is: persisted scoped-token manager.
- What it does: manages bearer tokens with scopes like owner, collaborator, and viewer.
- Called from and when: instantiated at startup and used by auth and token-management routes.
- What it calls: reads and writes `tokens.json`, resolves token scope, issues and revokes tokens.

### `requireClient`

- What it is: client-auth guard.
- What it does: authenticates normal client bearer tokens.
- Called from and when: called by client-protected routes and proxy paths.
- What it calls: token resolution and `Actor` creation.

### `requireHost`

- What it is: host/admin auth guard.
- What it does: authenticates host token or owner bearer token.
- Called from and when: called by host-only routes like token management and approvals.
- What it calls: elevated owner-level auth flows.

### `requireClientScope`

- What it is: scope enforcement helper.
- What it does: enforces minimum client token scope for mutations.
- Called from and when: called inside many write routes.
- What it calls: permission failures for viewers or lower-scope actors.

### `ApprovalService`

- What it is: in-memory approval queue and responder.
- What it does: stores pending approvals and resolves allow/deny/timeout outcomes.
- Called from and when: instantiated at startup and used by approval-gated routes.
- What it calls: mutation blocking until host/admin response.

### `requireApproval`

- What it is: approval wrapper.
- What it does: enforces approval on sensitive writes.
- Called from and when: called by config, file, plugin, skill, MCP, command, scheduler, and router identity writes.
- What it calls: `ApprovalService`; throws `write_denied` on deny/timeout.

### `/tokens` and `/approvals` routes

- What they are: auth/approval control endpoints.
- What they do: expose token inventory/issuance/revocation and pending approval inventory/response actions.
- Called from and when: called by host/admin control UI or operator flows.
- What they call: `TokenService` and `ApprovalService`.

## 4. Workspace Lifecycle, Status, And Capabilities

### `resolveWorkspace`

- What it is: workspace lookup and validation helper.
- What it does: resolves a workspace by ID, validates authorized-root membership, and repairs legacy commands if writable.
- Called from and when: called by almost every workspace-scoped route.
- What it calls: normalized `WorkspaceInfo` for all downstream file/config/OpenCode actions.

### `/status` and `/workspaces`

- What they are: core discovery/status routes.
- What they do: expose server health, config summary, capabilities, and workspace inventory.
- Called from and when: called by clients during connect, status refresh, and initial UI load.
- What they call: workspace serialization, `buildCapabilities`, bind/auth/read-only summary state.

### `buildCapabilities`

- What it is: capability summarizer.
- What it does: advertises what this server instance can do.
- Called from and when: called by `/capabilities` routes.
- What it calls: read-only mode, approvals, sandbox, browser provider, OpenCode/OpenCode Router availability.

### `/workspaces/local`

- What it is: local workspace creation route.
- What it does: creates a new local workspace folder and seeds starter files.
- Called from and when: called by host/admin workspace creation flows.
- What it calls: `ensureWorkspaceFiles`, workspace config persistence, audit logging.

### workspace rename / activate / delete routes

- What they are: workspace management endpoints.
- What they do: rename, activate, or remove a workspace from the server.
- Called from and when: called by host/admin workspace-management UI.
- What they call: in-memory config mutation, `server.json` persistence, reload watcher restart, audit logging.

## 5. Workspace Bootstrapping And Local Config Files

### `ensureWorkspaceFiles`

- What it is: workspace seeding helper.
- What it does: creates starter `.opencode` state, commands, skills, agent, `opencode.json`, and `openwork.json`.
- Called from and when: called when creating a local workspace.
- What it calls: OpenWork/OpenCode starter file generation.

### `ensureOpencodeConfig`

- What it is: OpenCode config seeder.
- What it does: seeds `opencode.json` defaults, default agent, scheduler plugin, and starter MCP.
- Called from and when: called during `ensureWorkspaceFiles`.
- What it calls: first-run OpenCode behavior for the workspace.

### `ensureWorkspaceOpenworkConfig`

- What it is: OpenWork config seeder.
- What it does: seeds `openwork.json` with authorized roots, blueprint sessions, and workspace metadata.
- Called from and when: called during `ensureWorkspaceFiles`.
- What it calls: OpenWork-specific workspace behavior and starter session metadata.

### workspace config routes

- What they are: config read/patch/raw text endpoints.
- What they do: read or patch workspace `opencode` and `openwork` config, including raw OpenCode config editor flows.
- Called from and when: called by settings/config UI.
- What they call: JSONC mutation helpers, raw config file writes, reload events, and audit entries.

## 6. OpenCode Integration And Session Read Model

### `resolveWorkspaceOpencodeConnection`

- What it is: OpenCode connection resolver.
- What it does: resolves OpenCode base URL and optional Basic auth for a workspace.
- Called from and when: called by OpenCode proxy and reload flows.
- What it calls: upstream OpenCode connection parameters.

### `proxyOpencodeRequest`

- What it is: OpenCode reverse proxy.
- What it does: forwards `/opencode` traffic to upstream OpenCode while injecting workspace directory and upstream auth.
- Called from and when: called by the main dispatcher for `/opencode` and mounted equivalents.
- What it calls: upstream OpenCode HTTP endpoints.

### `reloadOpencodeEngine`

- What it is: engine reload helper.
- What it does: calls OpenCode `/instance/dispose` to force an engine reload.
- Called from and when: called by `/workspace/:id/engine/reload`.
- What it calls: upstream OpenCode instance reset.

### session routes and `session-read-model.ts`

- What they are: session list/detail/messages/snapshot routes plus normalization helpers.
- What they do: fetch session data from OpenCode and validate/normalize the payloads.
- Called from and when: called by session UI/history surfaces.
- What they call: `fetchOpencodeJson` and `buildSessionList`, `buildSession`, `buildSessionMessages`, `buildSessionSnapshot`.

### `seedOpencodeSessionMessages`

- What it is: direct OpenCode DB seeding helper.
- What it does: inserts starter messages directly into the OpenCode SQLite DB for blueprint sessions.
- Called from and when: used during starter-session materialization.
- What it calls: direct OpenCode DB mutation.

## 7. Reload/Watch Behavior

### `startReloadWatchers`

- What it is: workspace reload-watcher setup.
- What it does: starts per-workspace watchers over root config files and `.opencode` trees.
- Called from and when: called during `startServer`, restarted when workspaces change.
- What it calls: `ReloadEventStore` with debounced reload signals.

### `ReloadEventStore`

- What it is: reload event queue.
- What it does: stores debounced workspace-scoped reload events with cursors.
- Called from and when: instantiated at startup, used by watchers and write routes.
- What it calls: `/workspace/:id/events` polling responses.

### `emitReloadEvent`

- What it is: manual reload signal helper.
- What it does: records reload signals after server-side mutations.
- Called from and when: called after config/plugin/skill/MCP/command/import writes.
- What it calls: client/runtime synchronization for server-caused file changes.

### `/workspace/:id/events` and `/engine/reload`

- What they are: reload polling and explicit engine-reload endpoints.
- What they do: return reload events since a cursor, and explicitly reload the upstream OpenCode engine.
- Called from and when: called by clients that need hot-reload awareness or manual engine reload.
- What they call: `ReloadEventStore` and `reloadOpencodeEngine`.

## 8. File Access, Inbox/Outbox, And Session-Scoped File Editing

### `FileSessionStore`

- What it is: ephemeral file-session manager.
- What it does: tracks scoped file editing sessions and workspace file-event cursors.
- Called from and when: instantiated inside `createRoutes`.
- What it calls: write eligibility, TTL, ownership, and incremental file-event streams.

### file session routes

- What they are: scoped file catalog/read/write/ops endpoints.
- What they do: create a file session, return a catalog snapshot, read files, write files with conflict detection, and apply mkdir/delete/rename ops.
- Called from and when: called by editors and remote file-management tooling.
- What they call: actual workspace filesystem reads/writes, file event logs, approvals, and audit logging.

### simple content routes

- What they are: markdown-oriented read/write routes.
- What they do: provide simpler file content APIs for lighter document flows.
- Called from and when: called by markdown/file editors.
- What they call: actual workspace file reads/writes plus audit and file-event signaling.

### inbox/outbox routes

- What they are: file ingest and artifact download endpoints.
- What they do: manage uploadable inbox files and downloadable artifact files under `.opencode/openwork`.
- Called from and when: called by file injection/download flows.
- What they call: workspace file writes, file listings, and binary download responses.

## 9. Plugins, Skills, MCP, Commands, And Scheduler

### plugin functions

- What they are: `listPlugins`, `addPlugin`, `removePlugin`.
- What they do: expose and mutate OpenCode plugin config and plugin directories.
- Called from and when: called by `/workspace/:id/plugins` routes.
- What they call: `opencode.json` mutation, plugin discovery, reload events.

### skill functions

- What they are: `listSkills`, `upsertSkill`, `deleteSkill`, plus Skill Hub helpers.
- What they do: discover and manage local/global skills, and install remote GitHub-backed skills.
- Called from and when: called by `/workspace/:id/skills*` routes and workspace bootstrap flows.
- What they call: `.opencode/skills` reads/writes, GitHub fetches, reload events.

### MCP functions

- What they are: `listMcp`, `addMcp`, `removeMcp`.
- What they do: manage MCP server config in `opencode.json`.
- Called from and when: called by `/workspace/:id/mcp*` routes.
- What they call: MCP config mutation and tool availability changes.

### command functions

- What they are: `listCommands`, `upsertCommand`, `deleteCommand`, `repairCommands`.
- What they do: manage project/global command markdown files and repair legacy frontmatter.
- Called from and when: called by `/workspace/:id/commands*` and implicitly by `resolveWorkspace`.
- What they call: `.opencode/commands` writes, frontmatter repair, reload events.

### scheduler functions

- What they are: scheduler job inspection/removal helpers.
- What they do: inspect and delete scheduled jobs backed by launchd/systemd and JSON job files.
- Called from and when: called by `/workspace/:id/scheduler/jobs*` routes.
- What they call: job file deletion and OS scheduler unload/remove behavior.

## 10. OpenCode Router / Messaging Integration

### `resolveOpenCodeRouterProxyPolicy`

- What it is: OpenCode Router auth policy resolver.
- What it does: decides what auth and scope is required for router proxy paths.
- Called from and when: called by the main dispatcher for `/opencode-router` paths.
- What it calls: access control for bindings, identities, health, and other router APIs.

### `proxyOpenCodeRouterRequest`

- What it is: OpenCode Router reverse proxy.
- What it does: forwards raw OpenCode Router requests to the local router service.
- Called from and when: called for `/opencode-router` and mounted equivalents.
- What it calls: localhost OpenCode Router health/config/send endpoints.

### router identity persistence helpers

- What they are: Telegram/Slack identity config writers.
- What they do: persist messaging identity config into `opencode-router.json`.
- Called from and when: called by workspace router-management routes.
- What they call: local router config mutation while preserving legacy fallback fields.

### `tryPostOpenCodeRouterHealth` / `tryFetchOpenCodeRouterHealth`

- What they are: best-effort router apply/fetch helpers.
- What they do: apply or fetch router health/config state without requiring a restart.
- Called from and when: called after router config changes and health/bind/send flows.
- What they call: live router process control/status behavior.

### workspace router routes

- What they are: `/workspace/:id/opencode-router/*` routes.
- What they do: manage health, Telegram/Slack setup, identities, bindings, and outbound sends.
- Called from and when: called by messaging/connectors UI.
- What they call: router config files, live router process state, identity pairing state, and outbound routing behavior.

## 11. Portable Export/Import And Sharing

### `exportWorkspace`

- What it is: portable workspace export builder.
- What it does: builds a portable workspace bundle including config, skills, commands, and allowed portable files.
- Called from and when: called by `/workspace/:id/export`.
- What it calls: workspace reads, config sanitization, portable file planning, and sensitive-data warnings.

### `importWorkspace`

- What it is: portable workspace import applier.
- What it does: applies imported bundle data into a workspace in replace or merge mode.
- Called from and when: called by `/workspace/:id/import`.
- What it calls: config writes, skills/commands writes, portable file writes, reload events.

### portable config and file helpers

- What they are: `sanitizePortableOpencodeConfig`, `planPortableFiles`, `listPortableFiles`, `writePortableFiles`, export-safety helpers.
- What they do: restrict export/import to portable config/files and detect or strip sensitive data.
- Called from and when: called by export/import flows.
- What they call: safe config/file selection and secret-aware export behavior.

### shared bundle publishing/fetching

- What they are: `publishSharedBundle`, `fetchSharedBundle`.
- What they do: publish and fetch named bundle payloads via a trusted OpenWork publisher.
- Called from and when: called by `/share/bundles/publish` and `/share/bundles/fetch`.
- What they call: remote publisher services and trusted-origin bundle fetch behavior.

## 12. Audit Trail And Blueprint Session Materialization

### audit functions

- What they are: `recordAudit`, `readAuditEntries`, `readLastAudit`.
- What they do: append and read per-workspace JSONL audit logs.
- Called from and when: called after most mutation flows and by `/workspace/:id/audit`.
- What they call: audit persistence under OpenWork data directories.

### blueprint session helpers

- What they are: blueprint template normalization/materialization helpers.
- What they do: parse starter-session templates from `openwork.json`, track what was already materialized, create OpenCode sessions, and seed starter messages.
- Called from and when: called by blueprint/session materialization routes and workspace bootstrap flows.
- What they call: upstream OpenCode session creation, direct OpenCode DB seeding, and `openwork.json` updates.

## 13. Runtime Control And Operational Endpoints

### `/health` and related status routes

- What they are: health and operational summary endpoints.
- What they do: report reachability, uptime, actor identity, runtime status, and toy UI/debug support.
- Called from and when: called by probes, status pages, and manual operator/debug flows.
- What they call: server uptime/version state, auth resolution, runtime control service, and toy UI assets.

### `/runtime/versions` and `/runtime/upgrade`

- What they are: runtime-control proxy endpoints.
- What they do: proxy runtime version and upgrade behavior. These are the legacy current-server route names; the Server V2 plan normalizes equivalent server-wide runtime endpoints under `/system/runtime/*`.
- Called from and when: called by upgrade/admin flows.
- What they call: `fetchRuntimeControl` and the configured runtime control base URL.

### `fetchRuntimeControl`

- What it is: runtime control HTTP client.
- What it does: calls the configured runtime control base URL with bearer auth.
- Called from and when: called by runtime version/upgrade routes.
- What it calls: external runtime control plane.

## Key Takeaways

- The current server is dominated by one large orchestration file, `apps/server/src/server.ts`, with many meaningful domains hanging off it.
- The best decomposition candidates for the new server are:
  - startup/config/runtime wiring
  - auth/tokens/approvals
  - workspace lifecycle/config
  - OpenCode proxy + session read model
  - file session API
  - OpenCode Router integrations
  - portable export/import + sharing
  - plugins/skills/MCP/commands/scheduler
- The strongest existing seams are service-style modules such as `TokenService`, `ApprovalService`, `ReloadEventStore`, `FileSessionStore`, `session-read-model.ts`, `portable-files.ts`, `workspace-export-safety.ts`, and `skill-hub.ts`.
- The weakest area is route ownership: many domains still terminate directly inside `createRoutes` instead of domain routers/controllers.
