# Phase 5 Learnings

Read this file before starting Phase 5. Prepend any new Phase 5 learnings under `## Entries`.

## Entries

### 2026-04-14 - Phase 5 - Keep remote connection secrets in the migration boundary until remote execution fully moves
- Context: Phase 5 migrates workspace discovery and sidebar summaries onto Server V2, but the app still uses legacy direct-connect flows for remote workspace activation and sandbox recovery.
- Learning: Server V2 can own the canonical workspace registry and public remote workspace shape without immediately re-exposing stored remote auth tokens, as long as the app normalizes Server V2 workspace summaries with legacy desktop-only remote connection fields at the migration boundary by stable workspace ID.
- Action for later Phase 5 work: Keep remote token and host-secret compatibility isolated in the `server-version` adapter/normalizer until remote session and control flows migrate behind Server V2.

### 2026-04-14 - Phase 5 - Desktop-hosted Server V2 read auth needs the same token handoff as legacy local server mode
- Context: Phase 5 adds real auth and scope checks to Server V2 read routes, including host-only hidden workspace and server inventory reads.
- Learning: If the desktop shell launches Server V2 without passing through the persisted client and host tokens, the new read surfaces remain effectively anonymous and the app cannot exercise scoped routes during rollout.
- Action for later Phase 5 work: Preserve the desktop token handoff when later phases add write routes, approvals, and host-only controls to Server V2.
