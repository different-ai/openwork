# Phase 1 Learnings

Read this file before starting Phase 1. Prepend any new Phase 1 learnings under `## Entries`.

## Entries

### 2026-04-14 - Phase 1 - Standalone base URL must stay root-mounted
- Context: Phase 1 replaced the earlier legacy-leaning `/v2` assumptions with a real standalone `apps/server-v2/` process.
- Learning: Server V2 should publish its contract from `/`, with operational routes under `/system/*` and workspace-first resources reserved under `/workspaces/:workspaceId`, so the generated SDK models the standalone server instead of a legacy subpath mount.
- Action for later Phase 1 work: Keep app adapters and future route groups pointed at the server root instead of reintroducing `/v2` path prefixes.

### 2026-04-14 - Phase 1 - Stable contract generation needs write-if-changed on OpenAPI output
- Context: The local dev watch graph depends on `src/** -> openapi/openapi.json -> packages/openwork-server-sdk/generated/**` without restart loops.
- Learning: Generating `apps/server-v2/openapi/openapi.json` via the live Hono app and only rewriting the file when contents change keeps SDK regeneration honest while avoiding noisy watcher churn.
- Action for later Phase 1 work: Preserve the current `app.request("/openapi.json")` generation path and extend it instead of introducing handwritten spec files.
