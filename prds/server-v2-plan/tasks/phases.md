# Server V2 Implementation Phases

## How To Use This Folder

- Every agent must read `prds/server-v2-plan/tasks/phases.md`, `prds/server-v2-plan/tasks/general-learnings.md`, `prds/server-v2-plan/tasks/open-questions.md`, and the current phase learnings file before starting work.
- Each phase has a matching `phaseN-steps.json` file with the execution checklist for that phase.
- Each phase also has a matching `phaseN-learnings.md` file. After an agent finishes, it should prepend any new phase-specific learnings there.
- If a learning matters outside the current phase, prepend it to `prds/server-v2-plan/tasks/general-learnings.md` too.
- If something is unclear and needs human input, the agent should make the best reasonable guess, add an entry to `prds/server-v2-plan/tasks/open-questions.md`, and continue with the best guess.
- Agents should prefer deleting temporary migration code as soon as a slice is fully moved, but they should not remove compatibility layers that are still needed by later phases.

## Phase Ordering Rules

- Phases are ordered for dependency flow, but some implementation inside adjacent phases can overlap once the upstream contract is stable.
- Do not start a later phase by bypassing an earlier ownership boundary decision.
- When a phase changes a contract or architectural assumption, the agent must record that in the learnings files so later phases do not rebuild stale assumptions.

## Phases

### Phase 1 - Foundations, Package Skeleton, And Contract Loop

Focus on creating the real `apps/server-v2/` package, the initial Hono app, shared middleware/context/layout, and the OpenAPI -> SDK generation loop. This phase should make Server V2 bootable as its own process and should establish the route, schema, error, and generation conventions that every later phase depends on.

Primary references: `prds/server-v2-plan/plan.md`, `prds/server-v2-plan/architecture.md`, `prds/server-v2-plan/sdk-generation.md`, `prds/server-v2-plan/local-dev.md`.

Outputs:
- `apps/server-v2/` exists as a real package/process.
- A minimal Hono app boots independently and serves system health routes.
- OpenAPI generation works from Hono route definitions.
- `packages/openwork-server-sdk/` exists and can generate a typed client from the spec.
- CI and local scripts can detect contract drift.

### Phase 2 - Server DB, Registry, And State Import

Focus on making the new server the durable owner of OpenWork state that should not remain app-owned or orchestrator-owned. This includes sqlite bootstrap, canonical tables, repository/services, filesystem layout decisions, and idempotent import of existing desktop and orchestrator state.

Primary references: `prds/server-v2-plan/plan.md`, `prds/server-v2-plan/ideal-flow.md`, `prds/server-v2-plan/schema.md`, `prds/server-v2-plan/app-audit.md`, `prds/server-v2-plan/tauri-audit.md`, `prds/server-v2-plan/orchestrator-audit.md`.

Outputs:
- Server-owned sqlite schema and migration runner.
- Durable `servers`, `workspaces`, runtime-state, config-item, share, router, and cloud tables.
- Import path for current desktop/orchestrator state into server-owned records.
- Hidden control/help workspaces and canonical local-server records.
- Observable startup migration status and tests for idempotency.

### Phase 3 - Runtime Supervision And Local Process Ownership

Focus on moving runtime ownership into Server V2. This phase should make the server resolve runtime assets, launch OpenCode by explicit path, supervise `opencode-router`, persist runtime health, and expose runtime status through server-owned `/system/*` endpoints.

Primary references: `prds/server-v2-plan/architecture.md`, `prds/server-v2-plan/spawning-opencode.md`, `prds/server-v2-plan/distribution.md`, `prds/server-v2-plan/ideal-flow.md`, `prds/server-v2-plan/orchestrator-audit.md`.

Outputs:
- Runtime asset resolution model for dev and release.
- `createLocalOpencode(...)` helper and runtime supervisor.
- Router supervision owned by the server.
- Server-owned runtime health/status endpoints.
- Crash, restart, and diagnostics behavior recorded in runtime state.

### Phase 4 - App And Desktop Migration Boundary

Focus on creating the client-side migration seam so the UI and desktop shell can switch to Server V2 without scattering raw env checks or transport logic. This phase should add the rollout flag, `createSdk({ serverId })`, thin legacy shims, and the Tauri startup branch for launching Server V2.

Primary references: `prds/server-v2-plan/ui-migration.md`, `prds/server-v2-plan/sdk-generation.md`, `prds/server-v2-plan/app-audit.md`, `prds/server-v2-plan/tauri-audit.md`.

Outputs:
- One logical rollout flag shared by app routing and desktop startup.
- App-owned `createSdk({ serverId })` boundary over the generated SDK.
- Thin legacy compatibility helpers kept outside feature code.
- Tauri branch that launches Server V2 instead of the legacy local stack.
- Initial verification that flag-off and flag-on both work.

### Phase 5 - Workspace And Server Read Surfaces

Focus on the first real product-facing read slices: server status, capabilities, workspace inventory, workspace detail, and server/workspace registry reads. This phase should prove the server-owned registry model and should migrate the first visible UI surfaces onto Server V2.

Primary references: `prds/server-v2-plan/plan.md`, `prds/server-v2-plan/architecture.md`, `prds/server-v2-plan/ideal-flow.md`, `prds/server-v2-plan/schema.md`, `prds/server-v2-plan/current-server-audit.md`.

Outputs:
- Workspace-first server discovery endpoints.
- Canonical workspace serialization for local, remote, control, and help workspaces.
- Capabilities and system status surfaced from Server V2.
- First migrated app screens backed by Server V2 read routes.
- Compatibility normalization between old and new payloads where needed.

### Phase 6 - Sessions, Messages, And Streaming

Focus on the main OpenCode-backed collaboration surface. This phase should wrap OpenCode session and message primitives behind workspace-first OpenWork routes, provide typed SSE helpers, and move the session UI onto Server V2 for both reads and writes.

Primary references: `prds/server-v2-plan/ideal-flow.md`, `prds/server-v2-plan/architecture.md`, `prds/server-v2-plan/current-server-audit.md`, `prds/server-v2-plan/schema.md`.

Outputs:
- Workspace-first session/message endpoints.
- Local OpenCode and remote OpenWork backend routing for session operations.
- Typed SSE route(s) plus handwritten SDK stream helpers.
- App session list/detail/composer flows using Server V2.
- Integration coverage for success, failure, and streaming cases.

### Phase 7 - Files, Config Projection, And Reload

Focus on moving workspace-scoped filesystem and config behavior behind the server. This phase should cover file-session APIs, simple file routes, config materialization/projection, reload events, file watching, and startup reconciliation or config absorption.

Primary references: `prds/server-v2-plan/current-server-audit.md`, `prds/server-v2-plan/schema.md`, `prds/server-v2-plan/ideal-flow.md`, `prds/server-v2-plan/app-audit.md`, `prds/server-v2-plan/tauri-audit.md`.

Outputs:
- Server-owned file read/write and file-session APIs.
- Workspace config directories separated from user data directories.
- Projection from server-owned config records into effective OpenCode config.
- Reload event and reconciliation model owned by the server.
- Reduced Tauri/app ownership for config and filesystem mutation.

### Phase 8 - Managed Resources, Sharing, And Settings Surfaces

Focus on the OpenWork-managed product metadata that should live in the server DB: MCPs, skills, plugins, providers, router identities/bindings, workspace shares, cloud signin state, and import/export/share flows. This phase should make settings surfaces server-backed instead of file-backed UI logic.

Primary references: `prds/server-v2-plan/current-server-audit.md`, `prds/server-v2-plan/schema.md`, `prds/server-v2-plan/ideal-flow.md`, `prds/server-v2-plan/app-audit.md`.

Outputs:
- CRUD and workspace-assignment flows for managed config items.
- Server-owned router config/status product surfaces.
- Workspace-scoped share/expose flows.
- Portable import/export and shared bundle flows on Server V2.
- Cloud and provider metadata moved toward server ownership.

### Phase 9 - Remote Connectivity, Host Modes, And Orchestrator Collapse

Focus on absorbing the remaining orchestrator control-plane behavior into Server V2, while preserving only the thinnest host-shell responsibilities if they are still required. This phase should move runtime control, workspace activation/disposal, remote server connectivity, and CLI wrappers onto the main server API surface.

Primary references: `prds/server-v2-plan/architecture.md`, `prds/server-v2-plan/orchestrator-audit.md`, `prds/server-v2-plan/ideal-flow.md`, `prds/server-v2-plan/distribution.md`, `prds/server-v2-plan/tauri-audit.md`.

Outputs:
- Server-owned replacements for daemon/control-plane APIs.
- Remote server connectivity and remote workspace routing through the local server registry.
- CLI and desktop reconnect flows pointed at the main server API.
- Orchestrator reduced to an optional thin host shell, or removed where no longer needed.
- Clear record of any remaining host-only responsibilities.

### Phase 10 - Distribution, Dev Experience, Cutover, And Cleanup

Focus on making Server V2 the default and only meaningful runtime. This phase should complete dev/watch tooling, Bun compile packaging, sidecar embedding and extraction, release/signing work, cutover flags, legacy deletion, and final release validation.

Primary references: `prds/server-v2-plan/distribution.md`, `prds/server-v2-plan/local-dev.md`, `prds/server-v2-plan/ui-migration.md`, `prds/server-v2-plan/plan.md`.

Outputs:
- Local dev graph that keeps server, spec, SDK, and app in sync.
- Bun-compiled distribution path with embedded sidecars and runtime extraction.
- Desktop bundles Server V2 and launches it by default.
- Legacy server/orchestrator control-plane code removed after cutover.
- Final release gates, tests, and rollout notes captured.
