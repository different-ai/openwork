# Phase 8 Learnings

Read this file before starting Phase 8. Prepend any new Phase 8 learnings under `## Entries`.

## Entries

### 2026-04-15 - Phase 8 - Cloud signin can move server-side before the desktop handoff is fully solved
- Context: Server V2 now owns durable cloud signin reads/writes/validation, while the app still carries a transient local cache and `Q-20260414-01` remains open for the longer-term bootstrap handoff from historical browser localStorage.
- Learning: The migration can still be honest and useful now by treating browser storage as a cache/mirror, syncing writes into Server V2, and hydrating back from the server once the app reconnects, instead of pretending the app must remain the source of truth until every bootstrap edge is solved.
- Action for later Phase 8 work: Keep server-owned cloud records canonical, keep cache-sync logic thin, and replace the cache bootstrap bridge once a durable desktop-to-server handoff exists.

### 2026-04-15 - Phase 8 - Workspace sharing should surface workspace-scoped keys, not host-wide owner tokens
- Context: Phase 8 added real `workspace_shares` records, but the app share modal still showed host owner/collaborator tokens for local workspaces.
- Learning: Once the server owns workspace share records, the UI should prefer the workspace-scoped access key and only fall back to host-wide tokens as a temporary compatibility path when the new route is unavailable.
- Action for later Phase 9 work: Keep local sharing routed through `/workspaces/{id}/share`, remove the host-token fallback after cutover, and preserve the distinction between workspace exposure and host admin access.

### 2026-04-15 - Phase 8 - Compatibility aliases can finish a server-ownership slice before every UI caller is seam-aware
- Context: Phase 8 moved managed resources, export/import, bundles, and router product behavior behind Server V2, but several app callsites still invoked legacy-shaped `createOpenworkServerClient(...)` methods that were not yet passing explicit Server V2 routing metadata.
- Learning: Keeping the canonical documented contract root-mounted under `/system/*` and `/workspaces/*` while also serving temporary root-mounted compatibility aliases like `/workspace/:id/*` lets the server become the real owner of a slice without blocking on a same-phase app-wide callsite rewrite.
- Action for later Phase 8 work: Delete the compatibility aliases only after the remaining app/desktop surfaces route those calls through the explicit Server V2 seam and tests prove the aliases are unused.

### 2026-04-15 - Phase 8 - Managed-item assignment needs to own rematerialization, reload, and stale-file cleanup together
- Context: Phase 8 added DB-backed assignment flows for MCPs, skills, plugins, providers, and router state, and surfaced them through new Server V2 routes.
- Learning: Assignment updates are only trustworthy when the same server-side path also rematerializes the effective workspace config, emits reload signals, and removes stale managed skill files that were detached by reassignment or deletion.
- Action for later Phase 8 work: Keep future managed-resource mutations centralized so assignment, projection, reload, and cleanup stay in one transaction-shaped flow instead of drifting into separate watchers or UI follow-up code.
