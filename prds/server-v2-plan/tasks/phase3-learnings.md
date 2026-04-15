# Phase 3 Learnings

Read this file before starting Phase 3. Prepend any new Phase 3 learnings under `## Entries`.

## Entries

### 2026-04-14 - Phase 3 - Router materialization should replace bindings without touching session rows
- Context: Server V2 now owns router config/db materialization under its runtime working directory instead of relying on app- or orchestrator-owned files.
- Learning: Rewriting the router `bindings` table from server-owned `router_bindings` records while leaving the router `sessions` table intact keeps the server authoritative for routing policy without destroying active peer/session continuity on every restart.
- Action for later Phase 3 work: Keep future router apply/reload work scoped to the managed config/bindings surfaces and avoid resetting the entire router database unless a migration explicitly requires it.

### 2026-04-14 - Phase 3 - Dev and release runtime ownership can share one manifest model
- Context: Server V2 now stages dev binaries under `.local/runtime-assets/` and can also resolve release assets from a managed runtime directory.
- Learning: Using the same runtime manifest structure for both staged dev assets and release assets keeps health/status routes, checksum validation, and later extraction work aligned even though the bytes come from different sources.
- Action for later Phase 3 work: Reuse the current manifest shape when Phase 10 adds release extraction/embedding instead of inventing a second runtime inventory format.
