# Phase 2 Learnings

Read this file before starting Phase 2. Prepend any new Phase 2 learnings under `## Entries`.

## Entries

### 2026-04-14 - Phase 2 - Preserve legacy workspace IDs during registry import
- Context: Phase 2 imports `openwork-workspaces.json` and orchestrator snapshots into the new `servers` and `workspaces` tables while also carrying selected/watched workspace hints forward.
- Learning: Reusing the desktop `ws_<hash>` identity rules for imported local and remote workspaces avoids selection drift, keeps repeated imports idempotent, and lets later phases migrate the app onto Server V2 without rewriting every stored workspace reference.
- Action for later Phase 2 work: Keep the current stable hash rules as the canonical imported-ID bridge unless a later migration explicitly rewrites every dependent reference.

### 2026-04-14 - Phase 2 - Persist bootstrap and import diagnostics in runtime state
- Context: Startup migration/import behavior now needs to stay visible without asking developers to query sqlite manually.
- Learning: Storing startup/bootstrap diagnostics under `server_runtime_state.health_json` keeps migration results, ignored legacy state, and warnings observable through normal server metadata routes without creating a second ad hoc status channel.
- Action for later Phase 2 work: Extend the existing runtime-state diagnostics payload in later phases instead of inventing parallel bootstrap audit stores.
