# Phase 4 Learnings

Read this file before starting Phase 4. Prepend any new Phase 4 learnings under `## Entries`.

## Entries

### 2026-04-14 - Phase 4 - Release-mode runtime startup must trust the bundled manifest for version metadata
- Context: The desktop sidecar smoke initially booted `openwork-server-v2`, but runtime bootstrap failed because the compiled server could not resolve `constants.json` while running in packaged-style release asset mode.
- Learning: When Server V2 is launched against bundled sidecars, release-mode runtime resolution must read the pinned OpenCode/router versions from `manifest.json` instead of trying to rediscover repo metadata that may not exist beside the compiled binary.
- Action for later Phase 4 work: Keep future packaged/runtime boot paths manifest-driven so desktop and standalone release binaries do not regress when repo-local source files are absent.

### 2026-04-14 - Phase 4 - Keep Server V2 rollout status capability-limited until feature routes migrate
- Context: Phase 4 adds the shared rollout boundary, app-side `createSdk({ serverId })`, and the desktop startup branch that launches Server V2 for local mode.
- Learning: Treating a successful Server V2 system probe as `limited` instead of `connected` keeps the app from accidentally driving legacy-only write/config surfaces against missing routes while still letting the migrated health and diagnostics probes exercise the new boundary.
- Action for later Phase 4 work: Promote specific feature areas from `limited` to real migrated capability checks only when their app-facing adapters actually route through the Server V2 boundary.

### 2026-04-14 - Phase 4 - Desktop sidecars can feed Server V2 through the Phase 3 runtime manifest shape
- Context: The desktop shell now launches `openwork-server-v2` directly and still needs OpenCode/router bytes available without inventing a second runtime metadata format.
- Learning: Generating a `manifest.json` next to the packaged Tauri sidecars lets Server V2 run in `release` asset mode while reusing the same runtime manifest and checksum model introduced in Phase 3.
- Action for later Phase 4 work: Keep desktop packaging, release extraction, and later sidecar verification on the same manifest contract instead of adding a desktop-only asset registry.
