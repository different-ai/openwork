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

### 2026-04-14 - Phase 5 - Keep partial remote-workspace compatibility inside the server-version boundary
- Context: Server V2 now owns the canonical workspace registry and the app boot/switcher reads from it, but remote workspace execution still uses legacy direct-connect behavior in the app.
- Learning: During read-slice migration, the safest place to merge Server V2 workspace summaries with legacy-only remote connection fields is the `server-version` normalization boundary keyed by stable workspace IDs, rather than leaking compatibility branches throughout UI feature code or re-exposing every secret in the public server payload.
- Action for later phases: Continue moving remote activation/session/file flows behind Server V2, and delete the boundary merge once the app no longer needs legacy remote connection fields.

### 2026-04-14 - Phase 5 - Desktop Server V2 startup must hand client and host tokens into the new process
- Context: Phase 5 adds auth and scope checks to Server V2 read surfaces and updates the desktop host path to use them.
- Learning: Desktop-hosted Server V2 needs the same persisted client/host token handoff that legacy local-server mode already had, otherwise scoped read routes such as hidden workspace access and server inventory cannot be exercised safely during migration.
- Action for later phases: Reuse the existing desktop token store and token handoff when write, approval, and admin surfaces move onto Server V2.

### 2026-04-14 - Phase 4 - Packaged Server V2 binaries should read version pins from the bundled runtime manifest
- Context: Phase 4 adds a real desktop-hosted `openwork-server-v2` launch path and smoke-tested it against Tauri sidecars in release-style asset mode.
- Learning: Compiled Server V2 binaries cannot rely on repo-local files like `constants.json` always existing at runtime, so release asset resolution must use the bundled `manifest.json` as the source of truth for pinned OpenCode/router versions.
- Action for later phases: Keep packaged desktop and standalone release flows manifest-driven, and avoid reintroducing repo-relative metadata lookups into release-only bootstrap paths.

### 2026-04-14 - Phase 4 - Reuse the runtime manifest when desktop bundles Server V2
- Context: Phase 4 adds the desktop startup branch for `openwork-server-v2` and needs the packaged desktop sidecars to satisfy Server V2 runtime asset resolution.
- Learning: Writing a release-style `manifest.json` beside the bundled desktop sidecars keeps the desktop host path aligned with the Phase 3 runtime manifest/checksum model, so later packaging and extraction work can build on one runtime inventory contract.
- Action for later phases: Keep Tauri bundling, release extraction, and runtime verification pointed at the shared manifest shape instead of creating desktop-specific sidecar metadata.

### 2026-04-14 - Phase 3 - Keep startup and runtime diagnostics in one persisted health document
- Context: Phase 3 adds OpenCode/router supervision, restart policy state, runtime manifests, and child-process diagnostics to Server V2.
- Learning: Extending `server_runtime_state.health_json` with a `runtime` section keeps startup import details, live runtime status, manifests, and crash diagnostics in one canonical observable document instead of splitting operational truth across multiple stores.
- Action for later phases: Add future runtime controls, upgrade state, and reconciliation details to the same persisted health document unless a truly separate retention boundary is required.

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
