# Server V2 Ideal Flow

## Status: Draft
## Date: 2026-04-13

## Purpose

This document captures the desired end-state runtime model for OpenWork Server V2.

It is more concrete than the incremental migration docs. It describes the ideal product flow once the desktop app is a thin UI, the server owns workspace behavior, and orchestrator responsibilities have been folded into the server itself.

## Core Principle

The desktop app is just a UI.

The server is the real system.

That means:

- the desktop app starts the server on launch
- the desktop app talks to the server over a port plus tokens
- all meaningful product data shown in the UI comes from the server
- all workspace, file, AI, config, and runtime behavior lives behind the server

## High-Level Runtime Flow

Target flow:

```text
DesktopApp
-> starts local OpenWork server
-> connects to that server over port + token
-> asks server for workspaces
-> asks server for sessions within each workspace
-> renders server-backed state

OpenWork server
-> owns local sqlite state
-> owns workspace/config/runtime mapping
-> talks to OpenCode via SDK
-> talks to remote OpenWork servers for remote workspaces
```

## Server And Workspace Registry Model

The local OpenWork server should maintain the canonical registry of servers and workspaces.

That registry includes:

- one local server
- zero or more remote servers
- all local, remote, control, and help workspaces

Each workspace points at one server.

Important nuance:

- `server` is a real system concept
- but it does not need to be a first-class user-facing concept yet

The user should mainly experience:

- workspaces
- sessions inside workspaces

while the server keeps the canonical mapping and the app only renders or caches what the server returns.

## Desktop App Responsibilities

The desktop app should only do these things:

- launch the local OpenWork server
- store enough local connection state to reconnect to the server
- maintain transient UI state
- maintain knowledge of which servers it is connected to
- render workspaces, sessions, messages, settings, and actions from server data
- send user intent to the server

The desktop app should not directly own:

- workspace data models
- workspace config mutation
- file reads or writes
- AI/session/task behavior
- OpenCode SDK interaction
- direct runtime orchestration logic

## Server Responsibilities

The local OpenWork server becomes the primary owner of:

- workspace registry
- workspace config registry
- session discovery and session interaction
- local sqlite persistence
- OpenCode project/session integration
- local runtime supervision
- remote OpenWork workspace connections
- exposing local workspaces for remote consumption

In the target model, the local desktop-hosted server should be able to do everything the app needs without the app performing its own parallel business logic.

## Server Database

The server should have its own sqlite database.

This database is the source of truth for OpenWork-managed metadata and relationships.

At minimum it should track:

- `servers`
  - known local or remote server connections
  - connection metadata, base URLs, auth/token state, capability flags
- `workspaces`
  - local and remote workspaces
  - workspace kind, display metadata, connection mapping, status
- `workspace_sessions_cache` or equivalent lightweight indexes if needed
  - optional server-side cache/index for faster listing
- `mcps`
  - config and auth metadata
- `skills`
  - skill metadata and OpenWork-managed ownership
- `plugins`
  - plugin metadata and enabled state
- `provider_configs`
  - provider definitions, auth references, workspace assignments
- `cloud_signin`
  - cloud auth/session metadata for the local server
- linking tables between config items and workspaces
  - so one config item can be attached to one or many workspaces

The sqlite DB is for OpenWork-owned metadata.

OpenCode remains the owner of session state.

For now, the server can query sessions live from OpenCode or remote servers.

It does not need a durable authoritative session cache yet.

The UI can eventually keep a cache for responsiveness if needed.

## Workspace Model

There are three important workspace categories.

### 1. Local workspaces

Each local workspace:

- belongs to the local OpenWork server
- has a stable OpenWork workspace ID
- maps to exactly one OpenCode project
- has its own OpenWork-managed config directory
- has its own user data directory / work directory

### 2. Remote workspaces

Each remote workspace:

- belongs to a remote OpenWork server
- maps to exactly one workspace on that remote OpenWork server
- is consumed through the remote server API, not by talking to OpenCode directly

### 3. Internal workspaces

There should also be two local special-purpose workspaces:

- Control Workspace
- Help Workspace

These should:

- be preconfigured by the local server
- exist as real server-managed workspaces
- not appear in the normal user-facing workspace list
- be accessible through dedicated UI flows instead of the standard workspace switcher

These give the product stable built-in surfaces for control/help behavior without mixing them into the user’s normal workspace list.

For now they should remain hidden.

Later they can be surfaced through settings and help/support areas rather than the standard workspace list.

## Local Workspace Mapping To OpenCode

Each local workspace should map to one OpenCode project.

That means:

- OpenWork owns the workspace record
- OpenWork workspace ID remains separate from the OpenCode project ID
- OpenCode owns the underlying session state for that project
- OpenWork server is responsible for translating between workspace IDs and OpenCode project/session identifiers

The server should query OpenCode through the SDK for:

- sessions in that project
- messages in a session
- archived state
- session names
- forks and other session primitives
- any other OpenCode-native session/project capability we need to expose

## Remote Workspace Mapping

Each remote workspace should map to a single workspace on a remote OpenWork server.

That means:

- the local UI does not treat a remote workspace as a direct OpenCode connection
- the local server talks to the remote OpenWork server
- the remote OpenWork server is responsible for its own OpenCode integration

This preserves one product model:

- UI <-> OpenWork server

instead of:

- UI <-> OpenCode directly for some things
- UI <-> OpenWork server for others

## Exposing A Local Workspace Remotely

The local server should be able to expose a local workspace for remote consumption.

This should be modeled as:

- one local OpenWork server
- one exposed workspace access surface per workspace
- remote consumers connect to the OpenWork server and are scoped to the workspace they were granted

That access should be workspace-scoped.

Each shared local workspace should have its own access key scoped just to that workspace.

Important principle:

- local configs affect the local server only
- workspace-specific config should apply only to the workspace it is attached to

## Startup Flow

Ideal startup flow:

1. Desktop app launches.
2. Desktop app starts the local OpenWork server.
3. Desktop app establishes a connection to the server using port + token.
4. Desktop app asks the server for the list of visible workspaces.
5. For each workspace, the desktop app asks the server for sessions in that workspace.
6. The server resolves the workspace to its backend:
   - local OpenCode project for local workspaces
   - remote OpenWork server workspace for remote workspaces
7. The server queries the relevant backend live for those sessions.
8. The desktop app renders only the data returned by the server.

The server should also expose explicit runtime health endpoints for its local dependencies, including OpenCode.

Recommended namespace:

- use `/system/*` for server-wide runtime and operational surfaces
- for example: `/system/opencode/health`, `/system/runtime/versions`, `/system/runtime/upgrade`

At minimum, the UI should be able to ask whether OpenCode is running and which version is active.

## OpenCode Router Startup Flow

`opencode-router` should be started by the new OpenWork server, not by the desktop app.

Current baseline being replaced:

- today, the orchestrator decides whether router support is needed
- today, the orchestrator resolves the router binary
- today, the orchestrator spawns and supervises the router child process

Target flow:

1. Desktop app launches the local OpenWork server.
2. The server boots its sqlite state and runtime registry.
3. The server evaluates whether router support is needed.
4. If router support is needed, the server:
   - resolves the `opencode-router` binary
   - materializes the effective router config from server-owned state
   - launches the router child process
   - waits for router health
   - tracks router status in memory and optionally in runtime state tables
5. The server exposes router status and router-backed capabilities through its own API.

The desktop app should not:

- launch `opencode-router` directly
- supervise `opencode-router` directly
- talk to `opencode-router` directly

The server should own the full lifecycle.

### Recommended shape

- one router process per local OpenWork server
- server-level identities and bindings
- workspace-aware routing enforced by the server when needed

This is simpler than one router process per workspace and fits the server-first ownership model better.

### Startup decision model

The server should decide whether router startup is needed based on:

- whether any router identities or bindings are configured
- whether any server-owned features require router-backed behavior
- whether messaging-related capabilities are enabled

Recommended behavior:

- if no router-backed capability is configured, router can stay off
- once messaging/bindings are configured, router should be started and supervised by the server

### Runtime behavior

The server should also own:

- router restart
- router health checks
- router config apply/reload behavior
- router status reporting to the UI

That makes `opencode-router` just another runtime dependency of the OpenWork server, not a separate app-owned or orchestrator-owned control surface.

## Session Ownership Model

The state of a session should be managed by OpenCode.

That includes:

- session identity
- session name
- archived state
- messages
- message ordering/history
- forks
- other OpenCode-native session semantics

The OpenWork server should query OpenCode via the SDK to get those.

OpenWork should not duplicate the source of truth for those fields in its own sqlite DB unless it needs a cache or index for performance.

## Workspace Config Ownership Model

The config of a workspace should be managed by OpenWork.

That includes:

- MCPs
- providers
- plugins
- skills
- any OpenWork-owned workspace settings

When a user adds a config item:

- by default it should be added to the workspace currently active in the UI
- the UI should also let the user apply that item to other workspaces
- nothing should be globally applied by default

When that happens:

1. The server creates or updates the config item in its own sqlite DB.
2. The server creates rows in a dedicated linking table that associates the config item with one or more workspaces.
3. The server materializes the effective OpenCode config for each affected workspace.
4. The server updates the OpenCode config file(s) needed for that workspace only.

When the server starts OpenCode, it should also be able to generate the effective OpenCode config object from its own database state and pass that config into the OpenCode runtime directly.

This lets OpenWork own the config model while still projecting it into the OpenCode format OpenCode needs.

When a user creates a new workspace, the product should also offer a list of existing config items that can be applied to that new workspace.

## Config Directory Separation

The ideal layout separates:

- user data directory / project data directory
- OpenWork-managed config directory
- OpenCode-managed runtime state

When a user adds a new local workspace:

1. OpenWork prompts for the directory the user wants to work with.
2. That chosen directory becomes the workspace data directory.
3. OpenWork creates a separate workspace config directory under an OpenWork-controlled path.
4. OpenCode is pointed at the OpenWork-controlled config directory.
5. The user’s chosen data directory is added as an authorized path in config.

This gives a cleaner split between:

- files owned by the user
- files controlled by OpenWork
- files controlled by OpenCode

Initial config path direction:

```text
<server-working-dir>/workspaces/<workspaceId>/config
```

## Config Absorption Model

If a user manually adds config item files into a workspace config path, the server should detect that and absorb it into the local sqlite database.

That means the server should eventually support:

- watching workspace config directories
- detecting unmanaged additions/changes/removals
- parsing those items into OpenWork-owned models
- reconciling them back into the DB as imported or externally-managed records

This gives the system a path to coexist with manual edits instead of fighting them.

For now:

- if a file clearly matches a known managed concept such as an MCP, Skill, Plugin, or similar item, the server can absorb it
- if it does not match a known managed concept, the server should leave it in place and not force it into the DB

## Session Interaction Flow

For anything related to a session, the client should always talk to the OpenWork server with the workspace ID.

Example shape:

```text
client action
-> OpenWork server request with workspaceId (+ sessionId if needed)
-> server resolves workspace backend
-> local OpenCode project/session OR remote OpenWork workspace
-> response comes back through OpenWork server
```

For local workspaces:

- the server forwards to the correct OpenCode project/session using the SDK

For remote workspaces:

- the server forwards to the remote OpenWork server

The client should not need to know which backend type it is talking to beyond workspace/server identity.

The server should maintain the mapping between:

- OpenWork workspace ID
- backend type
- OpenCode project ID or remote OpenWork workspace ID

## OpenCode Primitive Exposure

To make this work, the OpenWork server will need to expose the OpenCode primitives it depends on.

The initial minimum set of upstream OpenCode capabilities that the server must wrap should include at least:

### Session list and lifecycle

- `GET /session`
  - list sessions
- `POST /session`
  - create session
- `GET /session/status`
  - get session status
- `DELETE /session/{sessionID}`
  - delete session
- `PATCH /session/{sessionID}`
  - update session

### Session structure and control

- `GET /session/{sessionID}/todo`
  - get session todos
- `POST /session/{sessionID}/init`
  - initialize session
- `POST /session/{sessionID}/fork`
  - fork session
- `POST /session/{sessionID}/abort`
  - abort session
- `POST /session/{sessionID}/share`
  - share session
- `DELETE /session/{sessionID}/share`
  - unshare session
- `GET /session/{sessionID}/diff`
  - get message diff
- `POST /session/{sessionID}/summarize`
  - summarize session

### Messages

- `GET /session/{sessionID}/message`
  - get session messages
- `POST /session/{sessionID}/message`
  - send message
- `GET /session/{sessionID}/message/{messageID}`
  - get message
- `DELETE /session/{sessionID}/message/{messageID}`
  - delete message
- `DELETE /session/{sessionID}/message/{messageID}/part/{partID}`
  - delete message part
- `PATCH /session/{sessionID}/message/{messageID}/part/{partID}`
  - update message part

### Prompt and command execution

- `POST /session/{sessionID}/prompt_async`
  - send async message
- `POST /session/{sessionID}/command`
  - send command
- `POST /session/{sessionID}/shell`
  - run shell command
- `POST /session/{sessionID}/revert`
  - revert message
- `POST /session/{sessionID}/unrevert`
  - restore reverted messages

The OpenWork server becomes the adapter and policy layer over those upstream primitives.

The public API exposed to clients should not use those raw session-first routes directly.

Instead, the public API should be normalized around workspace-first OpenWork routes, for example:

- `GET /workspaces/{workspaceId}/sessions`
- `POST /workspaces/{workspaceId}/sessions`
- `GET /workspaces/{workspaceId}/sessions/status`
- `GET /workspaces/{workspaceId}/sessions/{sessionId}`
- `PATCH /workspaces/{workspaceId}/sessions/{sessionId}`
- `DELETE /workspaces/{workspaceId}/sessions/{sessionId}`
- `GET /workspaces/{workspaceId}/sessions/{sessionId}/messages`
- `POST /workspaces/{workspaceId}/sessions/{sessionId}/messages`
- `POST /workspaces/{workspaceId}/sessions/{sessionId}/fork`
- `POST /workspaces/{workspaceId}/sessions/{sessionId}/abort`

That means the public API shape should be normalized around:

- workspace ID first
- then session ID / message ID / other nested IDs

instead of exposing raw OpenCode-shaped session-first routes directly to clients.

## Recommended Data Boundaries

### OpenCode owns

- project/session/message state
- session runtime behavior
- OpenCode-native semantics around forks/history

### OpenWork server owns

- workspace registry
- config registry and config/workspace assignment
- connection registry for local and remote servers
- special internal workspaces
- projection of OpenWork config into OpenCode workspace config
- exposure of workspace/session/runtime primitives to the UI

### Desktop app owns

- connection to the local server
- transient UI state
- rendering and interaction state

## Implications For Migration

This target implies:

- Tauri-owned local workspace/config/file behavior must move behind the server
- orchestrator-owned runtime/workspace behavior must move behind the server
- the app should stop depending on direct local mutation as a normal path
- remote workspace support should normalize around "one workspace on one remote OpenWork server"

The migration rollout itself should be handled in a separate migration plan so existing users can be moved safely and smoothly.

## Decisions Captured So Far

1. Session lists can be queried live from OpenCode or remote servers for now. The UI can maintain a cache later if needed.
2. The system has a real `servers` model and a real `workspaces` model. Each workspace points at exactly one server, even if `server` is not yet a first-class user-facing concept.
3. Control Workspace and Help Workspace stay hidden for now, and can later surface through settings/help areas.
4. The preferred initial config path is under the server working directory, shaped like `workspaces/<workspaceId>/config`.
5. Nothing is global by default. When a config item is created, the user chooses which workspaces it applies to. When a workspace is created, the user can choose existing config items to apply.
6. Config reconciliation should use both file watching and periodic/pull-based reconciliation over time.
7. Config absorption should only occur for recognized managed concepts. Unknown/manual files should remain in place.
8. A remotely exposed local workspace should use workspace-scoped access, with its own access key.
9. Local workspaces keep a stable OpenWork workspace ID that is separate from the OpenCode project ID, and the server stores the mapping.
10. Session and message primitives should be exposed through workspace-first OpenWork-shaped endpoints, not raw OpenCode endpoint shapes.
11. The migration rollout itself should be described in a separate migration plan.

## Questions To Address Next

1. What exact schema should represent the `servers` table, `workspaces` table, config item tables, and workspace-config linking tables?
2. Which other desktop-owned data should move into the server DB as part of this same ownership shift, such as cloud settings, user auth, and synced-item metadata?
3. What exact filesystem layout should we use around the config directory beyond the initial `workspaces/<workspaceId>/config` direction?
4. What exact workspace-first OpenWork route naming should wrap the required OpenCode session/message primitives?
