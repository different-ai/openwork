# Phase 10 Learnings

Read this file before starting Phase 10. Prepend any new Phase 10 learnings under `## Entries`.

## Entries

### 2026-04-15 - Phase 10 - Shared Docker bind mounts need an explicit dependency-install lock
- Context: The Docker dev stack originally started multiple services that all ran `pnpm install` against the same bind-mounted repo, which produced `ERR_PNPM_ENOTEMPTY` races inside `node_modules`.
- Learning: When multiple dev containers share one repo volume, dependency installation needs a simple lock/done-file handshake or a dedicated setup step so services do not mutate `node_modules` concurrently.
- Action for later Phase 10 work: Keep multi-container dev stacks serialized around shared install work, especially when `pnpm` and large frameworks like Next are involved.

### 2026-04-15 - Phase 10 - Cutover scaffolding should be removed by turning defaults into constants before deleting deeper compatibility code
- Context: The desktop startup mode and app-side routing still carried rollout-flag branches even after Server V2 had become the default product path.
- Learning: A safe first cleanup step is to replace rollout decisions with one constant default (`Server V2`) so remaining legacy code becomes clearly residual instead of silently still participating in normal execution.
- Action for later Phase 10 work: Remove top-level rollout switches early once the default path is credible, then delete deeper legacy compatibility code in follow-up cleanup.

### 2026-04-15 - Phase 10 - Embedded runtime bundles must outrank dev asset discovery in compiled binaries
- Context: A compiled Server V2 binary can still resolve the repo root when launched from a checkout, which made the release runtime path incorrectly fall back to `.local/runtime-assets` even though an embedded bundle was present.
- Learning: Release bundle detection must take precedence over development-root discovery, otherwise compiled binaries launched from source trees can silently boot the wrong runtime source.
- Action for later Phase 10 work: Keep release-source detection ahead of dev-source detection whenever an embedded or filesystem release bundle is available.

### 2026-04-15 - Phase 10 - Contract generation must run against an isolated working directory
- Context: The Server V2 OpenAPI generator builds a real app dependency graph, and once more filesystem/config ownership moved server-side it could accidentally reconcile managed workspace state from a developer's live local data during `openapi:generate`.
- Learning: Contract generation should use an explicit temporary working directory plus in-memory persistence so spec and SDK regeneration stay deterministic and side-effect-free.
- Action for later Phase 10 work: Keep watch/contract commands isolated from real user data, and do not let generator boot paths mutate imported workspaces or managed files.

### 2026-04-15 - Phase 10 - Managed runtime extraction is valuable even before final single-binary embedding lands
- Context: Server V2 now copies release sidecars from a bundled runtime source directory into a persistent app-data runtime directory with extraction locking, atomic replace, and conservative cleanup, while the final Bun-embedded single-binary packaging step is still outstanding.
- Learning: The important runtime contract is that Server V2 executes from a managed extracted runtime directory under its own working dir; where the source bytes come from can evolve without changing that operational model.
- Action for later Phase 10 work: Keep release startup pointed at the managed runtime directory and finish true Bun embedding as a packaging-source improvement, not a change to runtime ownership.
