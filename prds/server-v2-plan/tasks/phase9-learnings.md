# Phase 9 Learnings

Read this file before starting Phase 9. Prepend any new Phase 9 learnings under `## Entries`.

## Entries

### 2026-04-15 - Phase 9 - Phase completion can tolerate explicit legacy overrides once the canonical path is singular
- Context: After the Phase 9 cutover, the default desktop/app path now starts Server V2, remote registration/sync/routing is server-owned, runtime control lives under `/system/runtime/*`, and local reconnect/status recovers from live Server V2 state. A few orchestrator-only code paths still remain for explicit legacy override or detached Docker sandbox launch glue.
- Learning: The phase can be considered complete once the default runtime graph is singular and server-owned, even if a small, documented compatibility shell remains for non-default launch glue or explicit legacy override paths.
- Action for later phases: Treat the remaining orchestrator code as cleanup debt only; do not route new product behavior through it, and remove it once detached sandbox launch and legacy override support are no longer needed.

### 2026-04-15 - Phase 9 - Desktop reconnect can recover Server V2 by probing persisted port and token state instead of daemon snapshots
- Context: After switching desktop startup defaults to Server V2, app reconnect and status flows still risked losing the live local server after an app relaunch because the Tauri manager state is in-memory while the child server may still be healthy.
- Learning: A small desktop-side probe that reuses the persisted workspace port plus client/host token store is enough to rediscover a live Server V2 process without falling back to orchestrator state as the canonical reconnect source.
- Action for later phases: Keep reconnect/status recovery pointed at live Server V2 health and persisted server tokens, and continue deleting orchestrator snapshot reads where they are now only compatibility fallback.

### 2026-04-15 - Phase 9 - Remote-connect migration must fail honestly once the local server becomes the registry owner
- Context: Phase 9 added Server V2 routes for remote server registration, remote workspace sync, and remote config/file/session proxying, while the app still had fallback branches that could silently persist remote workspaces in Tauri state when local server registration failed.
- Learning: Once Server V2 owns the remote workspace registry, app-side fallback persistence becomes misleading because it makes the UI look functional while bypassing the canonical server mapping and policy layer.
- Action for later phases: When migrating another control-plane slice behind Server V2, remove or loudly fail any legacy fallback that would hide a broken server-owned path.

### 2026-04-15 - Phase 9 - Server V2 contract changes require immediate OpenAPI and SDK regeneration
- Context: Adding `/system/servers/connect`, `/system/servers/:id/sync`, and `/system/runtime/upgrade` changed the standalone contract and broke app typecheck until the generated SDK was refreshed.
- Learning: Root-mounted Server V2 route/schema changes are not complete until `apps/server-v2/openapi/openapi.json` and `packages/openwork-server-sdk/generated/*` are regenerated in the same task.
- Action for later phases: After changing Server V2 schemas or documented routes, run `pnpm sdk:generate` before app verification so capability and route types stay aligned.

### 2026-04-15 - Phase 9 - Residual host-shell responsibilities are now narrow and explicit
- Context: Phase 9 moved remote registration/sync, remote workspace ops, runtime upgrade, and managed/router ownership into Server V2, but some desktop/orchestrator responsibilities still remain outside the main server.
- Learning: The remaining host-shell debt is now concentrated in startup-mode selection, detached sandbox launch wiring, legacy orchestrator status/debug surfaces, and desktop reconnect fallbacks that still read workspace/auth snapshot files.
- Action for later phases: Finish the cutover by moving reconnect/status truth to live Server V2 state, then shrink the remaining host shell to startup/launch glue only.
