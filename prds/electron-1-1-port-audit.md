# Electron 1:1 Port Audit

## Goal

Port the current desktop product on `origin/dev` from Tauri 2.x to Electron without changing user-visible behavior.

Parity means keeping all of the following working:

- local desktop host mode
- orchestrator and direct runtime modes
- deep links: `openwork://` and `openwork-dev://`
- single-instance handoff behavior
- folder/file pickers and save dialogs
- open URL, open path, reveal in folder
- auto-update and release-channel behavior
- workspace file watching and reload-required events
- sidecar staging and version metadata
- desktop bootstrap config and forced sign-in flows
- window focus, relaunch, decorations, and zoom behavior
- renderer access to localhost/OpenWork/OpenCode HTTP surfaces

## Current State

- There is no shipping Electron implementation in the current tree. A repo-wide search for `electron` found no existing desktop shell to extend.
- Tauri is not isolated to `apps/desktop`; it leaks into the renderer, package manifests, CI, release scripts, docs, locales, and planning docs.
- The minimum realistic scope is: replace the native shell, replace the renderer/native bridge, then update every build/release/doc surface that still assumes Tauri.

## Hard Blockers

These capabilities need an Electron equivalent before the port can be called 1:1:

1. `invoke`-style IPC for the current native command surface.
2. Desktop-safe HTTP/fetch behavior currently handled by `@tauri-apps/plugin-http`.
3. Folder/file/save dialogs.
4. Open URL/open path/reveal path behavior.
5. Relaunch/restart behavior.
6. Single-instance + forwarded deep-link handling.
7. Updater integration and release-channel endpoint selection.
8. Webview zoom behavior.
9. Window decoration toggling.
10. Workspace file watching and native event emission.
11. Sidecar spawning, supervision, shutdown, and cleanup.
12. Desktop bootstrap config persistence.

## Native Contract That Must Be Recreated

The current Tauri bridge is not small.

- `apps/app/src/app/lib/tauri.ts` exports `63` wrappers.
- `apps/desktop/src-tauri/src/commands/*.rs` exposes `57` `#[tauri::command]` handlers.

Current command count by Rust module:

```text
apps/desktop/src-tauri/src/commands/workspace.rs: 14
apps/desktop/src-tauri/src/commands/orchestrator.rs: 8
apps/desktop/src-tauri/src/commands/engine.rs: 6
apps/desktop/src-tauri/src/commands/skills.rs: 6
apps/desktop/src-tauri/src/commands/misc.rs: 5
apps/desktop/src-tauri/src/commands/opencode_router.rs: 5
apps/desktop/src-tauri/src/commands/command_files.rs: 3
apps/desktop/src-tauri/src/commands/scheduler.rs: 2
apps/desktop/src-tauri/src/commands/openwork_server.rs: 2
apps/desktop/src-tauri/src/commands/desktop_bootstrap.rs: 2
apps/desktop/src-tauri/src/commands/config.rs: 2
apps/desktop/src-tauri/src/commands/window.rs: 1
apps/desktop/src-tauri/src/commands/updater.rs: 1
```

## Exact Change Inventory

### 1. Root Workspace Surface

These files change because the workspace entrypoints and dependency graph still expose Tauri directly.

```text
package.json
pnpm-lock.yaml
```

Notes:

- `package.json` currently exposes a root `tauri` script and routes desktop dev/build through the Tauri-based package.
- `pnpm-lock.yaml` will change when `@tauri-apps/*` packages are removed and Electron packages are added.

### 2. App Renderer And Shared Desktop Bridge

Everything below is in scope because it either imports `@tauri-apps/*`, imports `app/lib/tauri`, checks `isTauriRuntime()`, references `__TAURI_INTERNALS__`, or documents Tauri-specific renderer behavior.

Total files: `58`

#### Shared app modules

```text
apps/app/package.json
apps/app/scripts/bump-version.mjs
apps/app/src/app/bundles/apply.ts
apps/app/src/app/bundles/sources.ts
apps/app/src/app/lib/den.ts
apps/app/src/app/lib/opencode.ts
apps/app/src/app/lib/openwork-server.ts
apps/app/src/app/lib/release-channels.ts
apps/app/src/app/lib/tauri.ts
apps/app/src/app/mcp.ts
apps/app/src/app/types.ts
apps/app/src/app/utils/index.ts
apps/app/src/app/utils/plugins.ts
apps/app/src/index.react.tsx
apps/app/src/react-app/ARCHITECTURE.md
```

What changes here:

- Replace the Tauri-specific runtime boundary with an Electron preload/IPC boundary.
- Remove direct `@tauri-apps/*` dependencies from the renderer.
- Rename or replace `app/lib/tauri.ts`; a parity-first port should move this to a generic desktop bridge early.
- Rework update-channel copy and assumptions in `release-channels.ts`.
- Update version bump flow so it no longer edits `Cargo.toml`, `Cargo.lock`, or `tauri.conf.json`.
- Revisit router selection in `index.react.tsx`; it currently uses `HashRouter` when `isTauriRuntime()` is true.

#### React shell and kernel

```text
apps/app/src/react-app/kernel/platform.tsx
apps/app/src/react-app/kernel/server-provider.tsx
apps/app/src/react-app/kernel/system-state.ts
apps/app/src/react-app/shell/app-root.tsx
apps/app/src/react-app/shell/desktop-runtime-boot.ts
apps/app/src/react-app/shell/font-zoom.ts
apps/app/src/react-app/shell/providers.tsx
apps/app/src/react-app/shell/session-route.tsx
apps/app/src/react-app/shell/settings-route.tsx
apps/app/src/react-app/shell/startup-deep-links.ts
```

What changes here:

- `platform.tsx` currently hardcodes Tauri open-link and relaunch behavior.
- `server-provider.tsx`, `openwork-server.ts`, `opencode.ts`, `den.ts`, and `bundles/sources.ts` use Tauri HTTP fetch in desktop mode.
- `system-state.ts` uses Tauri relaunch and reset flow.
- `font-zoom.ts` uses `@tauri-apps/api/webview` directly.
- `startup-deep-links.ts` depends on Tauri deep-link and event APIs.
- `session-route.tsx` and `settings-route.tsx` assume Tauri-native workspace/bootstrap behavior.

#### React domain files

```text
apps/app/src/react-app/domains/bundles/skill-destination-modal.tsx
apps/app/src/react-app/domains/cloud/forced-signin-page.tsx
apps/app/src/react-app/domains/connections/mcp-auth-modal.tsx
apps/app/src/react-app/domains/connections/mcp-view.tsx
apps/app/src/react-app/domains/connections/openwork-server-store.ts
apps/app/src/react-app/domains/connections/provider-auth/provider-auth-modal.tsx
apps/app/src/react-app/domains/connections/provider-auth/store.ts
apps/app/src/react-app/domains/connections/store.ts
apps/app/src/react-app/domains/session/chat/session-page.tsx
apps/app/src/react-app/domains/session/sidebar/workspace-session-list.tsx
apps/app/src/react-app/domains/session/surface/message-list.tsx
apps/app/src/react-app/domains/settings/pages/advanced-view.tsx
apps/app/src/react-app/domains/settings/pages/appearance-view.tsx
apps/app/src/react-app/domains/settings/pages/automations-view.tsx
apps/app/src/react-app/domains/settings/pages/config-view.tsx
apps/app/src/react-app/domains/settings/pages/debug-view.tsx
apps/app/src/react-app/domains/settings/pages/mcp-view.tsx
apps/app/src/react-app/domains/settings/pages/recovery-view.tsx
apps/app/src/react-app/domains/settings/pages/updates-view.tsx
apps/app/src/react-app/domains/settings/panels/authorized-folders-panel.tsx
apps/app/src/react-app/domains/settings/state/automations-store.ts
apps/app/src/react-app/domains/settings/state/debug-view-model.ts
apps/app/src/react-app/domains/settings/state/extensions-store.ts
apps/app/src/react-app/domains/workspace/share-workspace-state.ts
```

What changes here:

- Replace direct bridge imports with the new Electron desktop bridge.
- Replace Tauri-only file/path/dialog helpers.
- Rework updater UI to target Electron update semantics.
- Keep forced-signin/deep-link auth flows working after the native deep-link layer changes.
- Keep settings pages working for filesystem-backed edits, scheduler access, local-skill management, and reveal/open actions.

#### Locale strings

These locale files all contain the current `app.error.tauri_required` copy and need wording changes once Tauri is gone.

```text
apps/app/src/i18n/locales/ca.ts
apps/app/src/i18n/locales/en.ts
apps/app/src/i18n/locales/es.ts
apps/app/src/i18n/locales/fr.ts
apps/app/src/i18n/locales/ja.ts
apps/app/src/i18n/locales/pt-BR.ts
apps/app/src/i18n/locales/th.ts
apps/app/src/i18n/locales/vi.ts
apps/app/src/i18n/locales/zh.ts
```

### 3. Story Book / Demo Runtime

These files still pull Tauri packages into the demo shell.

```text
apps/story-book/package.json
apps/story-book/src/index.tsx
```

What changes here:

- Remove `@tauri-apps/*` dependencies from Story Book.
- Replace the demo platform implementation so it no longer references Tauri opener/process APIs.

### 4. Native Desktop Shell Replacement

This is the core of the port. The current desktop package is Tauri/Rust-based and must be replaced or fully reimplemented behind Electron main/preload.

Total files: `64`

#### Package and build scripts

```text
apps/desktop/package.json
apps/desktop/scripts/chrome-devtools-mcp-shim.ts
apps/desktop/scripts/dev-windows.mjs
apps/desktop/scripts/prepare-sidecar.mjs
apps/desktop/scripts/tauri-before-build.mjs
apps/desktop/scripts/tauri-before-dev.mjs
```

What changes here:

- Replace `tauri dev` / `tauri build` entrypoints with Electron equivalents.
- Keep sidecar staging, but retarget output paths away from `src-tauri`.
- Rework Windows desktop dev launcher for Electron.
- `chrome-devtools-mcp-shim.ts` may stay logically the same, but its build/staging path changes with the shell.

#### Tauri manifests, build metadata, and generated capability artifacts

```text
apps/desktop/src-tauri/build.rs
apps/desktop/src-tauri/capabilities/default.json
apps/desktop/src-tauri/Cargo.lock
apps/desktop/src-tauri/Cargo.toml
apps/desktop/src-tauri/entitlements.plist
apps/desktop/src-tauri/gen/schemas/acl-manifests.json
apps/desktop/src-tauri/gen/schemas/capabilities.json
apps/desktop/src-tauri/gen/schemas/desktop-schema.json
apps/desktop/src-tauri/gen/schemas/macOS-schema.json
apps/desktop/src-tauri/gen/schemas/windows-schema.json
apps/desktop/src-tauri/Info.dev.plist
apps/desktop/src-tauri/tauri.conf.json
apps/desktop/src-tauri/tauri.dev.conf.json
```

What changes here:

- `Cargo.toml`/`Cargo.lock`/`build.rs` go away if the native shell is no longer Rust-based.
- Tauri config, capability JSON, and generated schemas are Tauri-specific and must be removed or replaced.
- macOS packaging metadata may still be needed, but not in current Tauri form.

#### Rust bootstrap, managers, helpers, and process orchestration

```text
apps/desktop/src-tauri/src/bun_env.rs
apps/desktop/src-tauri/src/config.rs
apps/desktop/src-tauri/src/desktop_bootstrap.rs
apps/desktop/src-tauri/src/fs.rs
apps/desktop/src-tauri/src/lib.rs
apps/desktop/src-tauri/src/main.rs
apps/desktop/src-tauri/src/paths.rs
apps/desktop/src-tauri/src/types.rs
apps/desktop/src-tauri/src/updater.rs
apps/desktop/src-tauri/src/utils.rs
apps/desktop/src-tauri/src/platform/mod.rs
apps/desktop/src-tauri/src/platform/unix.rs
apps/desktop/src-tauri/src/platform/windows.rs
apps/desktop/src-tauri/src/engine/doctor.rs
apps/desktop/src-tauri/src/engine/manager.rs
apps/desktop/src-tauri/src/engine/mod.rs
apps/desktop/src-tauri/src/engine/paths.rs
apps/desktop/src-tauri/src/engine/spawn.rs
apps/desktop/src-tauri/src/opencode_router/manager.rs
apps/desktop/src-tauri/src/opencode_router/mod.rs
apps/desktop/src-tauri/src/opencode_router/spawn.rs
apps/desktop/src-tauri/src/openwork_server/manager.rs
apps/desktop/src-tauri/src/openwork_server/mod.rs
apps/desktop/src-tauri/src/openwork_server/spawn.rs
apps/desktop/src-tauri/src/orchestrator/manager.rs
apps/desktop/src-tauri/src/orchestrator/mod.rs
apps/desktop/src-tauri/src/workspace/commands.rs
apps/desktop/src-tauri/src/workspace/files.rs
apps/desktop/src-tauri/src/workspace/mod.rs
apps/desktop/src-tauri/src/workspace/state.rs
apps/desktop/src-tauri/src/workspace/watch.rs
```

What changes here:

- `lib.rs` currently owns plugin registration, single-instance behavior, deep-link forwarding, shutdown cleanup, and command registration.
- `workspace/watch.rs` emits `openwork://reload-required` from native file-watch events.
- `desktop_bootstrap.rs` persists the external desktop bootstrap file and seeds Den startup behavior.
- `updater.rs` contains macOS DMG/translocation gating for updates.
- `engine/*`, `orchestrator/*`, `openwork_server/*`, and `opencode_router/*` currently spawn and supervise local child processes.
- `paths.rs` and related helpers contain native-side path resolution and sidecar discovery logic.

#### Rust command modules that the renderer depends on

```text
apps/desktop/src-tauri/src/commands/command_files.rs
apps/desktop/src-tauri/src/commands/config.rs
apps/desktop/src-tauri/src/commands/desktop_bootstrap.rs
apps/desktop/src-tauri/src/commands/engine.rs
apps/desktop/src-tauri/src/commands/misc.rs
apps/desktop/src-tauri/src/commands/mod.rs
apps/desktop/src-tauri/src/commands/opencode_router.rs
apps/desktop/src-tauri/src/commands/openwork_server.rs
apps/desktop/src-tauri/src/commands/orchestrator.rs
apps/desktop/src-tauri/src/commands/scheduler.rs
apps/desktop/src-tauri/src/commands/skills.rs
apps/desktop/src-tauri/src/commands/updater.rs
apps/desktop/src-tauri/src/commands/window.rs
apps/desktop/src-tauri/src/commands/workspace.rs
```

What changes here:

- Every renderer call currently funneled through `app/lib/tauri.ts` must be backed by Electron IPC instead.
- The desktop event contract also needs parity, not just request/response IPC.

### 5. Runtime / Sidecar Build Hooks Outside `apps/desktop`

These packages can mostly keep their product logic, but they still contain shell-coupled assumptions that must change for Electron packaging.

```text
apps/orchestrator/src/cli.ts
apps/server-v2/script/build.ts
```

What changes here:

- `apps/server-v2/script/build.ts` still supports `--bundle-dir` embedding for Tauri sidecar layouts.
- `apps/orchestrator/src/cli.ts` remains product-runtime logic, but any shell packaging, path, or supervision assumptions tied to the Tauri app layout must be reviewed during the cutover.

### 6. CI, Release, And Ops Scripts

These files will keep failing or generating the wrong artifacts until they are rewritten for Electron.

```text
.github/workflows/alpha-macos-aarch64.yml
.github/workflows/build-desktop.yml
.github/workflows/prerelease.yml
.github/workflows/release-macos-aarch64.yml
.github/workflows/windows-signed-artifacts.yml
scripts/find-unused.README.md
scripts/find-unused.sh
scripts/openwork-debug.sh
scripts/release/review.mjs
scripts/release/verify-tag.mjs
```

What changes here:

- CI currently caches Cargo, builds Tauri bundles, uploads Tauri artifacts, and signs/notarizes Tauri outputs.
- Release review/verify scripts compare desktop package version against `Cargo.toml` and `tauri.conf.json`.
- `openwork-debug.sh` kills Tauri dev processes.
- `find-unused.sh` and its README explicitly whitelist Tauri hooks/configs.

### 7. Live Product And Developer Docs

These are active docs, not just historical notes. They should be updated in the same implementation stream so the repo stops advertising Tauri as the current shell.

```text
AGENTS.md
ARCHITECTURE.md
README.md
translated_readmes/README_JA.md
translated_readmes/README_ZH_hk.md
translated_readmes/README_ZH.md
```

Why they change:

- `AGENTS.md` still says the desktop/mobile shell is Tauri 2.x and calls out Tauri commands/events as IPC.
- `ARCHITECTURE.md` explicitly frames native-shell fallback behavior around Tauri and documents Tauri updater/channel behavior.
- `README.md` and translated readmes currently require Rust + Tauri CLI and describe Tauri folder-picker and desktop build steps.

### 8. Planning Docs That Become Stale

These docs are not build blockers, but they will actively mislead future work if the Electron port lands and they still describe the desktop layer as Tauri-first.

```text
prds/openwork-desktop-bootstrap-config/desktop-bootstrap-and-org-runtime-config.md
prds/react-incremental-adoption.md
prds/server-v2-plan/app-audit.md
prds/server-v2-plan/distribution.md
prds/server-v2-plan/final-cutover-checklist.md
prds/server-v2-plan/ideal-flow.md
prds/server-v2-plan/plan.md
prds/server-v2-plan/tauri-audit.md
prds/server-v2-plan/ui-migration.md
```

## Recommended Cutover Order

1. Keep `apps/app` behavior frozen and define a generic desktop bridge that matches the current Tauri contract.
2. Stand up an Electron main/preload shell under `apps/desktop` that can satisfy the same bridge.
3. Port native process supervision, deep links, single-instance handling, updater logic, dialogs, open/reveal helpers, and file watching.
4. Swap renderer imports off direct `@tauri-apps/*` usage.
5. Replace Tauri build/release/versioning logic in scripts and GitHub Actions.
6. Update docs, translated readmes, and locale copy.
7. Delete the remaining Tauri-only codepaths and configs only after desktop parity is verified.

## Decisions To Make Before Implementation

1. Keep the package name `@openwork/desktop` and replace internals in place, or create a parallel Electron package and cut over later.
2. Keep a HashRouter-based desktop renderer, or move Electron to a different route/bootstrap strategy.
3. Keep GitHub-hosted updater artifacts/endpoints, or change updater infrastructure while doing the shell migration.
4. Reimplement native process/file-watch logic in Node/Electron only, or keep a small Rust helper binary for pieces like watcher/process supervision.

## Bottom Line

This is not just an `apps/desktop` rewrite.

A full 1:1 Electron port touches:

- root workspace scripts and lockfile
- `58` renderer/shared-app files
- `2` Story Book files
- `64` desktop shell files
- `2` runtime/build hook files outside the shell package
- `10` CI/release/ops script files
- `6` live product/developer docs
- `9` planning docs that become stale after cutover

If the goal is strict parity, the safest path is to port the current Tauri contract first, then simplify after the Electron app is feature-complete.
