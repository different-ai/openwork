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

### 2026-04-15 - Phase 9 - Compatibility code stops blocking a migration once the default graph no longer depends on it
- Context: Phase 9 leaves a few orchestrator-specific paths in place for explicit legacy override and detached Docker sandbox launch glue, but the default desktop/app runtime graph now goes through Server V2 and the local server owns remote registration, runtime control, and reconnect truth.
- Learning: A migration can close with some compatibility code still present if that code is explicitly non-default, documented as residual shell glue, and no longer required for the canonical product path.
- Action for later phases: When deciding whether a migration is truly complete, judge by the default runtime graph and ownership boundaries, not by whether every compatibility hook has already been deleted.

### 2026-04-15 - Phase 9 - Desktop relaunch recovery should probe the canonical server before restarting anything
- Context: Once desktop startup defaults to Server V2, the app process can restart while the local server it launched is still healthy, which makes in-memory manager state an unreliable reconnect source.
- Learning: Persisting just enough port/token metadata and probing the live server on reconnect is a safer migration bridge than reconstructing runtime truth from legacy daemon snapshot files or blindly restarting local services.
- Action for later phases: Prefer live server probes plus minimal persisted connection metadata for reconnect flows, and remove leftover snapshot-based recovery once every local runtime path has a server-owned probe.

### 2026-04-15 - Phase 9 - Silent legacy fallbacks can fake migration completion
- Context: Phase 9 made Server V2 the owner of remote server registration, remote workspace sync, and remote workspace routing, but a few app branches still attempted to fall back to desktop-local workspace persistence when the new server-owned path failed.
- Learning: During control-plane migration, silent fallback branches are worse than explicit failure because they hide that the canonical server-owned route is broken while leaving stale state in side stores.
- Action for later phases: When a slice becomes server-owned, either route through the server or fail honestly; do not keep background compatibility writes that preserve the appearance of completion.

### 2026-04-15 - Phase 8 - Server-owned settings can migrate behind a cache bridge before full bootstrap parity exists
- Context: Phase 8 moved cloud signin persistence and validation into Server V2, but the desktop app still needed a temporary local cache because the legacy browser-localStorage handoff into the new server is not fully solved yet.
- Learning: A thin cache-sync bridge lets the server become the durable owner of product settings now, while the app keeps only reconnect/bootstrap convenience state until the final host handoff is ready.
- Action for later phases: Reuse this pattern only as a migration bridge, document when the cache is authoritative versus mirrored, and delete the bridge once desktop startup can hand the server the canonical state directly.

### 2026-04-15 - Phase 8 - Root-mounted compatibility aliases are a practical bridge during ownership cutover
- Context: Phase 8 moved managed-resource, bundle, export/import, and router product logic into Server V2, but some app surfaces still called legacy-shaped root paths like `/workspace/:id/*` through shared client helpers.
- Learning: A root-mounted server can preserve one canonical documented contract while temporarily serving compatibility aliases at sibling paths, which keeps feature ownership moving server-side without reintroducing the old `/v2` mount or scattering emergency client rewrites.
- Action for later phases: Keep compatibility aliases explicitly temporary, track which app surfaces still depend on them, and remove them once the Phase 4 seam routes those calls only through the canonical Server V2 paths.

### 2026-04-14 - Phase 7 - Canonical config can move before the runtime path does
- Context: Phase 7 stores local workspace config in the server DB/config-dir, but still rematerializes compatibility copies into each workspace data dir so the current local OpenCode/runtime path keeps seeing project config during migration.
- Learning: Moving the source of truth first is safe as long as the server also projects compatibility files into the legacy runtime locations that still gate execution.
- Action for later phases: Keep server-owned config canonical, preserve compatibility projection until every local runtime consumer reads from the new config-dir path, then remove the duplicate materialization in one cleanup step.

### 2026-04-14 - Phase 7 - Capability-gated slice migration works better than all-at-once workspace migration
- Context: Phase 7 moves local workspace config, file sessions, simple content, inbox, artifacts, and reload reads onto Server V2 while remote file/config mutation still stays on the legacy direct path.
- Learning: Routing each migrated slice through the server-version and capability boundary lets the app adopt Server V2 incrementally without pretending remote parity exists before the server truly owns it.
- Action for later phases: Keep migrating by capability-backed slices, and do not mark cross-workspace or remote ownership complete until the server path replaces the remaining direct fallback flows.

### 2026-04-14 - Phase 6 - Keep session routing separate from baseline OpenCode connectivity during migration
- Context: Phase 6 moves session and streaming traffic behind Server V2, but the app still depends on direct OpenCode health, provider, and config calls while connect-time migration remains in progress.
- Learning: Attaching workspace-scoped Server V2 session routing as explicit client metadata lets migrated session flows use the server boundary without breaking the existing direct OpenCode probes that still gate connection bootstrap.
- Action for later phases: When moving additional OpenCode-backed slices behind Server V2, prefer explicit per-slice routing metadata over forcing every OpenCode call through one temporary compatibility proxy.

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
