# Server V2 Schema And State Model

## Status: Draft
## Date: 2026-04-13

## Purpose

This document defines the preferred server-owned sqlite schema direction for Server V2, along with the related filesystem layout and API-shape decisions.

It also identifies desktop-owned state that should be moved into the server database as part of the thin-client transition.

## Core Rule

The local OpenWork server should become the durable owner of product state that is not inherently owned by OpenCode.

That means:

- OpenCode owns session/project runtime state
- OpenWork server owns workspace registry, config registry, remote connections, and product metadata
- the desktop app should stop being the long-term owner of those records

## Database Scope

The sqlite DB is for OpenWork-owned metadata and relationships.

It should not become a duplicate source of truth for:

- session messages
- archived flags
- session titles
- other OpenCode-native session state

Those should still come live from OpenCode or remote OpenWork servers.

## Tables

### `servers`

Purpose:

- store the set of known server connections the local product knows about

Rows should represent:

- one local server
- zero or more remote servers

Suggested columns:

- `id`
- `kind` (`local`, `remote`)
- `hosting_kind` (`desktop`, `self_hosted`, `cloud`)
- `label`
- `base_url`
- `token_ref` or encrypted token material
- `capabilities_json`
- `is_local`
- `is_enabled`
- `created_at`
- `updated_at`
- `last_seen_at`

Notes:

- `server` is a real model in the product, even if it is not yet exposed directly in the UI.
- The app can still render a workspace-first experience while the server keeps the canonical registry.
- Remote and cloud servers should both be modeled as remote OpenWork servers at the product level; `hosting_kind` captures whether a remote server is cloud-hosted or not.

### `workspaces`

Purpose:

- store the canonical OpenWork workspace registry

Suggested columns:

- `id`
- `server_id`
- `kind` (`local`, `remote`, `control`, `help`)
- `display_name`
- `slug`
- `is_hidden`
- `status`
- `opencode_project_id` nullable
- `remote_workspace_id` nullable
- `data_dir` nullable
- `config_dir` nullable
- `notes_json` nullable
- `created_at`
- `updated_at`

Rules:

- every workspace points at exactly one server
- local workspaces keep a stable OpenWork workspace ID that is separate from the OpenCode project ID
- remote workspaces map to exactly one workspace on a remote OpenWork server
- control/help workspaces are real workspaces with `is_hidden = true`
- the local OpenWork server is still the canonical routing layer that the app talks to, even when a workspace belongs to a remote server

### `server_runtime_state`

Purpose:

- store server-wide supervision and health state for bundled runtime dependencies

Suggested columns:

- `server_id`
- `runtime_version`
- `opencode_status`
- `opencode_version`
- `opencode_base_url` nullable
- `router_status`
- `router_version` nullable
- `restart_policy_json` nullable
- `last_started_at` nullable
- `last_exit_json` nullable
- `updated_at`

Notes:

- this is the server-owned place for runtime health, crash history, and extracted-runtime metadata
- this is distinct from workspace-level diagnostic state because OpenCode and router are supervised at the server level

### `workspace_runtime_state`

Purpose:

- optional server-owned state about runtime health and derived metadata for each workspace

Suggested columns:

- `workspace_id`
- `backend_kind` (`local_opencode`, `remote_openwork`)
- `last_sync_at`
- `last_session_refresh_at`
- `last_error_json`
- `health_json`

Notes:

- this is not the source of truth for sessions
- it is just runtime/cache/diagnostic state the server may want

### `mcps`

Purpose:

- store MCP definitions and related auth/config metadata as OpenWork-managed records

Suggested columns:

- `id`
- `kind`
- `display_name`
- `config_json`
- `auth_json`
- `source` (`openwork_managed`, `imported`, `discovered`)
- `created_at`
- `updated_at`

### `skills`

Purpose:

- store OpenWork-managed skill metadata

Suggested columns:

- `id`
- `slug`
- `display_name`
- `body_ref` or `content_hash`
- `source` (`openwork_managed`, `imported`, `discovered`, `cloud_synced`)
- `cloud_item_id` nullable
- `created_at`
- `updated_at`

### `plugins`

Purpose:

- store plugin definitions and enabled-state metadata

Suggested columns:

- `id`
- `plugin_key`
- `display_name`
- `config_json`
- `source`
- `created_at`
- `updated_at`

### `provider_configs`

Purpose:

- store provider definitions, credentials references, and assignment metadata

Suggested columns:

- `id`
- `provider_key`
- `display_name`
- `config_json`
- `auth_json`
- `source`
- `created_at`
- `updated_at`

### `cloud_signin`

Purpose:

- store local server-owned cloud auth/session metadata

Suggested columns:

- `id`
- `cloud_base_url`
- `user_id`
- `org_id`
- `auth_json`
- `last_validated_at`
- `created_at`
- `updated_at`

Notes:

- cloud sign-in should stop being purely app-owned preference state
- the server should be able to own and apply this state directly

### `workspace_shares`

Purpose:

- store share/access state for local workspaces that are exposed remotely

Suggested columns:

- `id`
- `workspace_id`
- `access_key_ref` or encrypted key material
- `status` (`active`, `revoked`, `disabled`)
- `last_used_at` nullable
- `audit_json` nullable
- `created_at`
- `updated_at`
- `revoked_at` nullable

Notes:

- access should be scoped to one workspace, not granted server-wide by default
- the initial product shape can assume zero or one active share record per local workspace, while leaving room for later expansion

### `router_identities`

Purpose:

- store server-owned router identities and their persisted config/auth metadata

Suggested columns:

- `id`
- `server_id`
- `kind`
- `display_name`
- `config_json`
- `auth_json`
- `is_enabled`
- `created_at`
- `updated_at`

Notes:

- router identity state should be server-level, not app-local
- the server can still project this into router config files or runtime config as needed

### `router_bindings`

Purpose:

- store server-owned router bindings and delivery targets

Suggested columns:

- `id`
- `server_id`
- `router_identity_id`
- `binding_key`
- `config_json`
- `is_enabled`
- `created_at`
- `updated_at`

Notes:

- bindings are what determine whether router startup is needed at all
- later models can add workspace scoping or policy tables without changing the basic server-owned direction

## Linking Tables

These tables are what let OpenWork own config items once and apply them to one or many workspaces.

### `workspace_mcps`

- `workspace_id`
- `mcp_id`
- `created_at`
- `updated_at`

### `workspace_skills`

- `workspace_id`
- `skill_id`
- `created_at`
- `updated_at`

### `workspace_plugins`

- `workspace_id`
- `plugin_id`
- `created_at`
- `updated_at`

### `workspace_provider_configs`

- `workspace_id`
- `provider_config_id`
- `created_at`
- `updated_at`

Notes:

- nothing should be global by default
- when a config item is created, the user chooses which workspaces it should apply to
- when a workspace is created, the server/UI can offer existing config items to attach

## Other Desktop-Owned State That Should Move Into The Server DB

Beyond the core tables above, the server should absorb other state that currently tends to live in the desktop app.

### Cloud settings and user auth

Should move into the server DB:

- cloud base URL
- user auth/session state
- selected org or cloud account metadata
- cloud validation status

Reason:

- this is product state, not presentation state
- the server should be able to own cloud-backed behavior directly

### Cloud-synced item metadata

Should move into the server DB:

- mappings to cloud-synced skills/plugins/providers
- imported/discovered state
- sync status and timestamps

Reason:

- it belongs with the config and workspace registry the server owns

### Workspace share metadata

Should move into the server DB:

- workspace-scoped share/access keys
- share status
- share timestamps and audit fields

Reason:

- remote exposure of local workspaces is a server capability
- this should land in `workspace_shares` or an equivalent server-owned table

### Server/workspace relationship state

Should move into the server DB:

- which workspace belongs to which server
- hidden control/help workspace metadata
- remote workspace mappings
- local OpenWork workspace ID <-> OpenCode project ID mappings

Reason:

- this is the canonical product graph the app should query, not reconstruct locally

## Session Query Strategy

For now:

- session lists and session state can be queried live
- local server queries OpenCode for local workspaces
- local server queries remote OpenWork servers for remote workspaces

Optional later enhancements:

- light server-side cache/index tables
- UI cache for responsiveness

But the authoritative state should remain live in the backend systems.

## Config Reconciliation Strategy

Config reconciliation should use both:

- file watching
- periodic or pull-based reconciliation

### File watching

Use for:

- fast local detection of config changes in managed directories
- quick projection/update of DB state

### Periodic or pull-based reconciliation

Use for:

- startup repair
- recovering from missed file watcher events
- validating that disk state and DB state still match

### Absorption rules

- if a file clearly matches a known managed concept like MCP, Skill, Plugin, or Provider Config, absorb it into the DB
- if it does not match a known managed concept, leave it in the directory for now

## Filesystem Layout

Current preferred direction:

```text
<server-working-dir>/workspaces/<workspaceId>/config
```

Where:

- the user chooses the workspace data directory
- OpenWork creates and owns the config directory
- OpenCode is pointed at the OpenWork-owned config directory
- the user data directory is added as an authorized path

This gives a clean separation between:

- user-owned data
- OpenWork-owned config
- OpenCode-owned runtime state

## API Shape

All session and workspace behavior should be exposed through workspace-first OpenWork routes.

That means:

- the client sends `workspaceId`
- the server resolves the backend mapping
- the server talks to OpenCode or a remote OpenWork server
- the client never needs raw OpenCode endpoint shapes

Recommended principle:

- normalize everything into OpenWork-shaped endpoints
- do not expose raw OpenCode endpoint design directly as the public product API

## Initial Primitive Surface

The initial OpenCode-derived session surface should still include the primitives already listed in `prds/server-v2-plan/ideal-flow.md`, but wrapped in OpenWork route design.

That means:

- session listing
- session creation/update/delete
- session status and todos
- init/fork/abort/share/unshare/summarize
- message list/get/send/update/delete
- prompt async / command / shell
- revert / unrevert

The naming and nesting should be workspace-first.

## Recommended Next Step

The next useful design doc after this one is a route-shape doc that turns these schema decisions into:

- workspace-first REST route patterns
- request/response envelope shape
- mapping rules from OpenWork routes to OpenCode SDK calls
