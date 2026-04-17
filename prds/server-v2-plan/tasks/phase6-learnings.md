# Phase 6 Learnings

Read this file before starting Phase 6. Prepend any new Phase 6 learnings under `## Entries`.

## Entries

### 2026-04-14 - Phase 6 - Session migration works best as a scoped routing layer, not a full client swap
- Context: The app still needs direct OpenCode health/provider/config calls during connect, while Phase 6 moves session reads, writes, and events behind Server V2.
- Learning: Adding separate workspace-scoped `sessionRouting` metadata to the existing OpenCode client keeps non-session OpenCode calls untouched while moving session and SSE traffic onto Server V2 with much less UI churn than replacing every client instance wholesale.
- Action for later Phase 6 work: Reuse the same scoped-routing pattern for any remaining OpenCode-backed feature area that must migrate without breaking connect-time health and capability probes.

### 2026-04-14 - Phase 6 - Preserve the raw `{ type, properties }` event shape at the server boundary
- Context: Both the Solid session store and the React session surface already consume normalized OpenCode event records shaped like `{ type, properties }`.
- Learning: Keeping Server V2 SSE payloads in that same normalized shape allows the server to become the only streaming boundary without forcing an app-wide event-model rewrite during the same phase.
- Action for later Phase 6 work: Keep future server-owned streaming surfaces typed and documented, but prefer compatibility-preserving event envelopes when migrating existing consumers.
