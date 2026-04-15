# General Learnings

Read this file before starting any phase.

## How To Add Entries

- Prepend new entries under `## Entries` so the newest learning stays closest to the top.
- Add only learnings that matter across multiple phases.
- Keep phase-local learnings in the relevant `phaseN-learnings.md` file.

## Suggested Entry Format

```md
### 2026-04-14 - Phase N - Short title
- Context:
- Learning:
- Action for later phases:
```

## Entries

### 2026-04-14 - Phase 2 - Keep imported workspace IDs aligned with legacy desktop hashes
- Context: Server V2 now imports the desktop workspace registry and orchestrator snapshots into its canonical sqlite tables.
- Learning: Preserving the legacy `ws_<hash>` rules for imported local and remote workspaces keeps selected/watched workspace references stable, makes imports idempotent, and avoids migration drift while the app still carries old workspace IDs.
- Action for later phases: Reuse the current workspace ID derivation rules for imports and any compatibility adapters until a later phase performs an explicit whole-system ID migration.

### 2026-04-14 - Phase 1 - `openapi-ts` config files must use `-f`
- Context: The Server V2 SDK generator is pinned to `@hey-api/openapi-ts@0.95.0` and now runs from `packages/openwork-server-sdk/openapi-ts.config.ts`.
- Learning: `openapi-ts -f openapi-ts.config.ts` loads the config file, while `-c` selects an HTTP client and can silently break generation expectations.
- Action for later phases: Reuse the existing `pnpm --filter @openwork/server-sdk generate` script instead of hand-writing new CLI invocations.

### 2026-04-14 - Phase 1 - Standalone Server V2 should stay root-mounted
- Context: The new server process now owns `/system/*` directly and generates an SDK with a root base URL instead of a legacy `/v2` suffix.
- Learning: Reintroducing `/v2` into the standalone contract would leak legacy mount assumptions into the SDK, tests, and future app adapters.
- Action for later phases: Keep Server V2 endpoints root-mounted and let versioning remain a deployment concern rather than a path convention.
