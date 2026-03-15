# OpenWork Desktop Tauri-to-Electron Migration Audit and Plan

> Canonical status: this is the program-level source of truth for the desktop migration.
>
> Research/spec only. No product code changes happen in this phase.
>
> Execution rule for future work: split implementation across subagents by workstream. Do not let one subagent change renderer IPC, child-process supervision, packaging, and docs all at once.
>
> Exact contract companion: `docs/plans/2026-03-15-openwork-electron-preload-main-api.md`
>
> Execution queue: `docs/plans/2026-03-15-openwork-desktop-tauri-to-electron-migration/steps.json`
>
> Shared learnings log: `docs/plans/2026-03-15-openwork-desktop-tauri-to-electron-migration/learnings.md`

## Goal

Document every meaningful place where OpenWork Desktop currently depends on Tauri or Rust, map each dependency to an Electron equivalent, and identify which parts should be rewritten in Electron main/preload versus moved into OpenWork server or openwork-orchestrator instead of being reimplemented one-for-one.

## Current Desktop Shape

OpenWork Desktop is currently four systems glued together:

1. `packages/app`
   - SolidJS renderer.
   - Contains direct Tauri imports plus a large desktop wrapper layer in `packages/app/src/app/lib/tauri.ts`.
2. `packages/desktop/src-tauri`
   - Rust/Tauri shell.
   - Registers plugins, exposes 55 Tauri commands, supervises child processes, watches local files, manages updater/env/protocol concerns, and persists desktop state.
3. Local host runtimes and sidecars
   - `opencode`
   - `openwork-server`
   - `opencode-router`
   - `openwork-orchestrator`
   - `chrome-devtools-mcp`
   - Docker-backed sandbox flows
4. Packaging/release/docs
   - Tauri config, Cargo manifests, sidecar prep scripts, updater metadata, GitHub Actions, contributor docs, and agent skills all assume Tauri/Rust.

## Electron Target Shape

| Current concept | Electron target | Notes |
| --- | --- | --- |
| Tauri `Builder` + plugins | Electron main process + preload bridge | `contextIsolation: true`, no `nodeIntegration` |
| `#[tauri::command]` | `ipcMain.handle` + typed preload API | Do not expose raw Node APIs to renderer |
| Tauri event bus | `webContents.send` + `ipcRenderer.on` | Keep event names if useful |
| `@tauri-apps/plugin-dialog` | `dialog.showOpenDialog` / `showSaveDialog` | Main/preload only |
| `@tauri-apps/plugin-opener` | `shell.openExternal`, `shell.openPath`, `shell.showItemInFolder` | Main/preload only |
| `@tauri-apps/plugin-process` relaunch | `app.relaunch`, `app.quit`, `app.exit` | Main only |
| `@tauri-apps/plugin-updater` | `electron-updater` or equivalent | Move update orchestration fully into main |
| `@tauri-apps/plugin-deep-link` | `app.setAsDefaultProtocolClient`, `open-url`, `second-instance` | Main owns protocol ingress |
| `@tauri-apps/plugin-http` | Prefer plain `fetch`; fall back to main-process network only when needed | Avoid recreating unnecessary native fetch layer |
| Tauri path APIs | `app.getPath`, Node `path`, preload helpers | Keep renderer path access narrow |
| Tauri `externalBin` sidecars | `extraResources` / unpacked binaries | Never execute from inside ASAR |
| Tauri capability ACLs | Preload allowlist + Electron security hardening | Security boundary becomes code, not JSON schema |
| Rust managers in `AppHandle.manage(...)` | Main-process singleton services | Engine/orchestrator/server/router supervisors |
| Rust file watcher | `chokidar` or `fs.watch` in main | Consider moving parity logic into OpenWork server |

## Migration Principles

1. Do not port Tauri APIs blindly.
   - If a flow can move behind OpenWork server or openwork-orchestrator, prefer that over replacing Rust with Electron IPC.
2. Keep the renderer boring.
   - The renderer should talk to a typed preload API, not to arbitrary Node or shell primitives.
3. Keep privileged work in main.
   - Child-process spawn, Docker, scheduler, updater, protocol handling, shell open/reveal, destructive resets.
4. Prefer shared/server parity for filesystem-backed config.
   - `.opencode`, `opencode.json`, skills, commands, workspace metadata.
5. Treat sidecars and auth material as first-class security concerns.
   - Current orchestrator auth snapshots and local tokens should be revisited during the migration.

## Non-Negotiables

1. Final desktop product has no Tauri runtime dependency.
2. Final desktop product has no Rust desktop shell or Cargo-based desktop build.
3. No required desktop capability is allowed to disappear just because it was previously implemented in Tauri or Rust.
4. If a Tauri/Rust feature exists today, the migration must either:
   - reimplement it in Electron main/preload, or
   - replace it with a custom Electron-owned service, or
   - move it behind OpenWork server / openwork-orchestrator while preserving the product behavior.
5. The end state should leave no Tauri-specific build, packaging, updater, protocol, capability, or docs artifacts in the desktop path.

## Inventory Summary

- Direct renderer files with explicit Tauri references: 17
- Renderer files with desktop-only `isTauriRuntime()` branching: 22
- Tauri command entrypoints in Rust: 55
- Rust/Tauri support modules to rewrite, retire, or move: 20+
- Packaging/release/docs/skill files with Tauri or Cargo assumptions: 20+
- Cross-package runtime assumption outside `packages/desktop`: `packages/orchestrator/src/cli.ts` allows `tauri://localhost` and `http://tauri.localhost`

## 1. Renderer Dependency Inventory

### 1.1 Direct renderer imports of Tauri APIs

| File | Function/component/symbols | Tauri dependency | What it does now | Electron equivalent | Migration note |
| --- | --- | --- | --- | --- | --- |
| `packages/app/src/index.tsx` | bootstrap `platform.openLink`, `platform.restart`, desktop router selection | `@tauri-apps/plugin-opener`, `@tauri-apps/plugin-process`, `isTauriRuntime()` | Opens external links, relaunches app, switches to `HashRouter` in desktop runtime | preload `openExternal`, preload `relaunch`, runtime marker from preload | Keep route strategy explicit; Electron can keep hash routing if needed |
| `packages/app/src/app/utils/index.ts` | `isTauriRuntime()` | `window.__TAURI_INTERNALS__` | Detects desktop runtime | `window.openworkDesktop` or preload marker using `process.versions.electron` | Central runtime probe must change early |
| `packages/app/src/app/system-state.ts` | `confirmReset`, `checkForUpdates`, `downloadUpdate`, `installUpdateAndRestart` | `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process` | Desktop reset and in-app updater flow | main-process updater service + preload events + `app.relaunch()` | Do not keep updater logic in renderer |
| `packages/app/src/app/app.tsx` | `App` | `@tauri-apps/api/app`, `@tauri-apps/api/event`, `@tauri-apps/api/webview`, `@tauri-apps/plugin-process`, `@tauri-apps/plugin-http`, `@tauri-apps/plugin-deep-link`, `@tauri-apps/plugin-opener` | Version display, event listening, webview zoom, deep-link ingress, desktop-only fetch, relaunch, external links | preload app metadata, IPC events, `webFrame.setZoomFactor`, main-owned protocol handler, main/preload external open | This is the renderer's biggest Tauri-coupled file |
| `packages/app/src/app/context/workspace.ts` | `createWorkspaceStore` | `@tauri-apps/api/event`, `@tauri-apps/api/path` | Watches sandbox progress event, reads home/download directories, calls most desktop wrappers | preload event subscription, `app.getPath('home'/'downloads')`, typed workspace IPC | Large opportunity to move file/config mutations to OpenWork server APIs |
| `packages/app/src/app/context/extensions.ts` | `createExtensionsStore` | `@tauri-apps/api/path`, `@tauri-apps/plugin-opener` | Local skills/config management, reveal skills folder | preload `path.join`, `shell` helpers, or server-backed extension APIs | Strong candidate to reduce desktop-only logic instead of porting it |
| `packages/app/src/app/context/server.tsx` | `ServerProvider` | `@tauri-apps/plugin-http` | Health checks against local OpenWork server | Prefer plain `fetch`; use main only if CORS or trust boundary requires it | Likely removable as a native-only dependency |
| `packages/app/src/app/lib/opencode.ts` | client creation/fetch resolution | `@tauri-apps/plugin-http` | Bypasses browser fetch limitations for local OpenCode URLs | Prefer plain `fetch`, or main-side fetch bridge only if needed | Re-evaluate whether Electron still needs native fetch workaround |
| `packages/app/src/app/lib/openwork-server.ts` | fetch resolution | `@tauri-apps/plugin-http` | Bypasses browser fetch limitations for local OpenWork server URLs | Prefer plain `fetch` | Same as above |
| `packages/app/src/app/lib/tauri.ts` | 65 exported wrappers | `@tauri-apps/api/core`, `@tauri-apps/plugin-http`, `@tauri-apps/plugin-dialog` | Central renderer bridge to Rust commands, dialog plugin, native fetch | Replace with preload-backed `window.openwork.*` API | This is the primary renderer migration seam |
| `packages/app/src/app/pages/session.tsx` | `SessionView`, reveal/open handlers | `@tauri-apps/api/path`, `@tauri-apps/plugin-opener` | Resolves local paths, reveals artifacts, opens workspace files, launches Obsidian-backed flows via wrappers | preload `path.join`, `shell.openPath`, `shell.showItemInFolder` | Keep actual shell opens out of renderer |
| `packages/app/src/app/pages/settings.tsx` | `SettingsView` | `@tauri-apps/plugin-opener` plus wrapper calls | Reveals config files, restarts local services, shows build info, nukes dev config, runs sandbox probe | preload shell helpers and typed IPC to main services | Another large desktop-control surface |
| `packages/app/src/app/pages/mcp.tsx` | `McpView` | `@tauri-apps/plugin-opener` plus wrapper calls | Reads/writes local config, reveals `opencode.json`, starts MCP auth flow | preload shell helpers; prefer server-backed MCP/config APIs | Good candidate for server parity |
| `packages/app/src/app/pages/dashboard.tsx` | `DashboardView` | `@tauri-apps/plugin-opener` | Reveals workspace folder in Finder/Explorer | `shell.openPath` / `shell.showItemInFolder` | Small, straightforward preload API |
| `packages/app/src/app/components/part-view.tsx` | `PartView` reveal handlers | `@tauri-apps/plugin-opener` | Opens/reveals file references from session content | preload shell helpers | Keep path validation in main |
| `packages/app/src/app/components/provider-auth-modal.tsx` | `ProviderAuthModal` | `@tauri-apps/plugin-opener` | Opens provider auth URL in browser | `shell.openExternal` | Simple preload wrapper |
| `packages/app/src/app/components/mcp-auth-modal.tsx` | `McpAuthModal` | `@tauri-apps/plugin-opener` | Opens MCP auth URL in browser | `shell.openExternal` | Simple preload wrapper |

### 1.2 Renderer files with desktop-only branching but no direct Tauri import

These files still encode Tauri/Desktop assumptions and need an Electron-aware replacement, even if they do not import a Tauri package directly.

| File | Current assumption | Electron replacement |
| --- | --- | --- |
| `packages/app/src/app/pages/config.tsx` | Desktop runtime toggles drive local config UX | Swap to a generic `isDesktopRuntime()` capability check |
| `packages/app/src/app/pages/onboarding.tsx` | Desktop-only onboarding branches | Replace with capability-driven checks from preload/server |
| `packages/app/src/app/pages/scheduled.tsx` | Scheduled tasks require desktop runtime and non-Windows checks | Keep OS checks, but source capability from preload/main |
| `packages/app/src/app/entry.tsx` | Desktop defaults OpenCode URL to localhost host mode | Resolve from preload/config instead of Tauri detection |
| `packages/app/src/app/context/openwork-server.ts` | Desktop runtime controls local host assumptions | Use desktop capability and host metadata from preload |

## 2. `packages/app/src/app/lib/tauri.ts` Wrapper Inventory

This file is the renderer contract that future Electron work should replace first.

### 2.1 Workspace, local config, and command file wrappers

| Functions | Current backend | Electron equivalent | Preferred long-term disposition |
| --- | --- | --- | --- |
| `workspaceBootstrap`, `workspaceSetActive`, `workspaceCreate`, `workspaceCreateRemote`, `workspaceUpdateRemote`, `workspaceUpdateDisplayName`, `workspaceForget` | Tauri `invoke(...)` to Rust workspace commands | preload `ipcRenderer.invoke('workspace:*')` | Keep minimal local workspace registry in main; move shareable semantics into server where possible |
| `workspaceAddAuthorizedRoot` | Rust command updates `.opencode/openwork.json` authorized roots | preload IPC to main file service | Consider moving to server/shared authorization model |
| `workspaceExportConfig`, `workspaceImportConfig` | Rust zip/unzip helpers | preload IPC to main archive service | Could move to shared OpenWork server implementation later |
| `workspaceOpenworkRead`, `workspaceOpenworkWrite` | Rust reads/writes `.opencode/openwork.json` | preload IPC or server endpoint | Prefer server parity over permanent desktop-only file IO |
| `opencodeCommandList`, `opencodeCommandWrite`, `opencodeCommandDelete` | Rust file wrappers | preload IPC or server endpoint | Strong candidate to move behind OpenWork server APIs |

### 2.2 Engine, orchestrator, sandbox, and server wrappers

| Functions | Current backend | Electron equivalent | Preferred long-term disposition |
| --- | --- | --- | --- |
| `engineStart`, `engineStop`, `engineRestart`, `engineInfo`, `engineDoctor`, `engineInstall` | Rust command layer supervising local OpenCode | typed main-process host supervisor | Keep in main if Electron still hosts local runtimes |
| `orchestratorStatus`, `orchestratorWorkspaceActivate`, `orchestratorInstanceDispose`, `orchestratorStartDetached` | Rust wrapper over orchestrator state and CLI/HTTP flows | typed main-process supervisor or direct orchestrator HTTP client | Thin HTTP wrappers should move toward orchestrator/server ownership |
| `sandboxDoctor`, `sandboxStop`, `sandboxCleanupOpenworkContainers`, `sandboxDebugProbe` | Rust Docker inspection and cleanup | main-process diagnostic service using `child_process` | Keep strictly in main; consider pushing more of this into orchestrator |
| `openworkServerInfo`, `openworkServerRestart` | Rust OpenWork server host manager | main-process local host supervisor | Could be simplified if server host mode moves into orchestrator only |

### 2.3 Native dialogs and shell UI wrappers

| Functions | Current backend | Electron equivalent | Preferred long-term disposition |
| --- | --- | --- | --- |
| `pickDirectory`, `pickFile`, `saveFile` | `@tauri-apps/plugin-dialog` | `dialog.showOpenDialog`, `dialog.showSaveDialog` via preload | Keep in preload/main only |
| `setWindowDecorations` | Tauri command toggling main window decorations | `BrowserWindow` title-bar/window controls from main | Keep in main only |

### 2.4 Skills, packages, config, and local authoring wrappers

| Functions | Current backend | Electron equivalent | Preferred long-term disposition |
| --- | --- | --- | --- |
| `opkgInstall`, `importSkill`, `installSkillTemplate` | Rust shell/file commands | main-process spawn + file copy | Prefer eventual server/shared flows for install/import where possible |
| `listLocalSkills`, `readLocalSkill`, `writeLocalSkill`, `uninstallSkill` | Rust file system commands | preload IPC to main file service | Best long-term home is server-backed extension management |
| `readOpencodeConfig`, `writeOpencodeConfig` | Rust config file read/write | preload IPC or server endpoint | Prefer server-backed config APIs |

### 2.5 Maintenance, updater, scheduler, Obsidian, and local utility wrappers

| Functions | Current backend | Electron equivalent | Preferred long-term disposition |
| --- | --- | --- | --- |
| `updaterEnvironment` | Rust updater env probe | main-process updater capability service | Keep in main |
| `appBuildInfo` | Rust app metadata command | preload app metadata | Keep in main |
| `nukeOpencodeDevConfigAndExit` | Rust cleanup + app exit | main-process cleanup + `app.quit()` | Keep in main |
| `resetOpenworkState`, `resetOpencodeCache` | Rust destructive file cleanup | main-process file cleanup | Keep in main |
| `obsidianIsAvailable`, `openInObsidian`, `writeObsidianMirrorFile`, `readObsidianMirrorFile` | Rust app detection, shell exec, mirror file IO | main-process shell/file services | Evaluate whether this feature stays desktop-only |
| `schedulerListJobs`, `schedulerDeleteJob` | Rust launchd/systemd inspection/removal | main-process OS integration or scheduler API | Strong candidate to move into `opencode-scheduler` or server |
| `opencodeDbMigrate`, `opencodeMcpAuth` | Rust wrapper around OpenCode CLI | main-process spawn helpers | Could also move behind OpenCode/OpenWork server flows |

### 2.6 OpenCodeRouter wrappers

| Functions | Current backend | Electron equivalent | Preferred long-term disposition |
| --- | --- | --- | --- |
| `getOpenCodeRouterStatus`, `getOpenCodeRouterStatusDetailed`, `opencodeRouterInfo`, `opencodeRouterStart`, `opencodeRouterStop`, `opencodeRouterRestart` | Rust router status/start/stop wrappers | main-process router supervisor | Thin pieces could later move to router/server API |
| `getOpenCodeRouterGroupsEnabled`, `setOpenCodeRouterGroupsEnabled` | Tauri/native `fetch` against localhost router config endpoint | Prefer plain `fetch` first; fall back to main bridge only if needed | Likely does not need a native-only layer under Electron |

## 3. Rust / Tauri Command Inventory

The Rust shell exposes 55 Tauri command entrypoints from `packages/desktop/src-tauri/src/lib.rs`.

### 3.1 App bootstrap and plugin registration

| File | Tauri/Rust surface | Electron replacement |
| --- | --- | --- |
| `packages/desktop/src-tauri/src/lib.rs` | `tauri::Builder`, plugin registration, `.manage(...)`, `generate_handler!`, `RunEvent` cleanup | Electron `app.whenReady()`, singleton services, `ipcMain.handle`, `BrowserWindow`, `before-quit` cleanup |
| `packages/desktop/src-tauri/src/main.rs` | Rust binary entrypoint | `packages/desktop/src/main.ts` or equivalent Electron main entrypoint |

### 3.2 Command files and their Electron equivalents

| File | Commands | What they do now | Electron equivalent | Better long-term home |
| --- | --- | --- | --- | --- |
| `packages/desktop/src-tauri/src/commands/engine.rs` | `engine_info`, `engine_stop`, `engine_restart`, `engine_doctor`, `engine_install`, `engine_start` | Start/stop local OpenCode runtime, probe binaries, install OpenCode, manage auth/runtime state | main-process engine supervisor + preload IPC | Keep host supervision in main |
| `packages/desktop/src-tauri/src/commands/orchestrator.rs` | `orchestrator_status`, `orchestrator_workspace_activate`, `orchestrator_instance_dispose`, `orchestrator_start_detached`, `sandbox_doctor`, `sandbox_stop`, `sandbox_cleanup_openwork_containers`, `sandbox_debug_probe` | Detached host orchestration, Docker sandbox lifecycle, health/status wrappers, progress event emission | main-process orchestrator/sandbox supervisor + IPC events | Move as much detached-host logic as possible into `packages/orchestrator` |
| `packages/desktop/src-tauri/src/commands/openwork_server.rs` | `openwork_server_info`, `openwork_server_restart` | Query/restart locally hosted OpenWork server | main-process host supervisor | Potentially collapsible if orchestrator becomes the single desktop host entrypoint |
| `packages/desktop/src-tauri/src/commands/opencode_router.rs` | `opencodeRouter_info`, `opencodeRouter_start`, `opencodeRouter_stop`, `opencodeRouter_status`, `opencodeRouter_config_set` | Manage `opencode-router` child process and CLI config/status | main-process router supervisor | Thin status/config wrappers can move to router/server API over time |
| `packages/desktop/src-tauri/src/commands/workspace.rs` | `workspace_bootstrap`, `workspace_forget`, `workspace_set_active`, `workspace_update_display_name`, `workspace_create`, `workspace_create_remote`, `workspace_update_remote`, `workspace_add_authorized_root`, `workspace_openwork_read`, `workspace_openwork_write`, `workspace_export_config`, `workspace_import_config` | Local workspace registry, local and remote workspace metadata, config archive import/export, authorized roots | main-process workspace service + archive/file helpers | Move file-backed settings toward OpenWork server parity |
| `packages/desktop/src-tauri/src/commands/skills.rs` | `list_local_skills`, `read_local_skill`, `write_local_skill`, `install_skill_template`, `uninstall_skill` | Local skill discovery and mutation across project/global roots | main-process file service | Better as server-backed extension APIs |
| `packages/desktop/src-tauri/src/commands/command_files.rs` | `opencode_command_list`, `opencode_command_write`, `opencode_command_delete` | Local command markdown CRUD | main-process file service | Better as server-backed command APIs |
| `packages/desktop/src-tauri/src/commands/config.rs` | `read_opencode_config`, `write_opencode_config` | Project/global `opencode.json(c)` read/write | main-process file service | Better as server-backed config APIs |
| `packages/desktop/src-tauri/src/commands/opkg.rs` | `opkg_install`, `import_skill` | Host-side package install and recursive skill import | main-process spawn + file copy | Could move toward server/shared install flows |
| `packages/desktop/src-tauri/src/commands/misc.rs` | `reset_opencode_cache`, `reset_openwork_state`, `app_build_info`, `nuke_opencode_dev_config_and_exit`, `obsidian_is_available`, `open_in_obsidian`, `write_obsidian_mirror_file`, `read_obsidian_mirror_file`, `opencode_db_migrate`, `opencode_mcp_auth` | Reset, metadata, Obsidian integration, mirror storage, OpenCode CLI admin wrappers | main-process cleanup/shell/file services | CLI wrappers may not deserve permanent Electron reimplementation |
| `packages/desktop/src-tauri/src/commands/scheduler.rs` | `scheduler_list_jobs`, `scheduler_delete_job` | Read and remove launchd/systemd jobs | main-process OS integration | Better owned by scheduler package/service |
| `packages/desktop/src-tauri/src/commands/updater.rs` | `updater_environment` | Determine whether updater is safe/supported in current runtime | main-process updater service | Keep in main |
| `packages/desktop/src-tauri/src/commands/window.rs` | `set_window_decorations` | Toggle native titlebar/chrome | main-process `BrowserWindow` control | Keep in main |

### 3.3 Rust-emitted event surfaces

| Event | Current source | Electron equivalent | Note |
| --- | --- | --- | --- |
| `openwork://reload-required` | `packages/desktop/src-tauri/src/workspace/watch.rs` | `webContents.send('openwork://reload-required', payload)` | Triggered by local workspace/config file watch changes |
| `openwork://sandbox-create-progress` | `packages/desktop/src-tauri/src/commands/orchestrator.rs` | `webContents.send('openwork://sandbox-create-progress', payload)` | Triggered during detached sandbox startup |

## 4. Rust Support Modules That Must Be Rewritten, Retired, or Moved

| File/module | Current role | Electron equivalent | Disposition |
| --- | --- | --- | --- |
| `packages/desktop/src-tauri/build.rs` | Build-time sidecar staging, build metadata, Tauri build hook | JS packaging hooks (`beforePack`, `afterPack`, custom prebuild) | Rewrite in JS |
| `packages/desktop/src-tauri/Cargo.toml` | Rust/Tauri dependency graph | Electron package manifest(s) | Delete after migration |
| `packages/desktop/src-tauri/Cargo.lock` | Rust lockfile | none | Delete after migration |
| `packages/desktop/src-tauri/tauri.conf.json` | Window, bundle, updater, sidecars, deep-link config | Electron builder/forge config | Rewrite |
| `packages/desktop/src-tauri/tauri.dev.conf.json` | Dev bundle ID/name/scheme config | Electron dev build config | Rewrite |
| `packages/desktop/src-tauri/capabilities/default.json` | Tauri capability ACL | preload allowlist + security policy | Delete/replace |
| `packages/desktop/src-tauri/gen/schemas/*` | Generated Tauri capability schemas | none | Delete |
| `packages/desktop/src-tauri/src/engine/spawn.rs` | Spawn packaged/path OpenCode binary, build env, pick ports | main-process `child_process.spawn` service | Rewrite in TS/JS |
| `packages/desktop/src-tauri/src/engine/doctor.rs` | Resolve sidecar/path binary and probe versions | main-process binary resolver + `execFile` | Rewrite in TS/JS |
| `packages/desktop/src-tauri/src/engine/manager.rs` | Engine child-process state | main-process singleton service | Rewrite in TS/JS |
| `packages/desktop/src-tauri/src/orchestrator/mod.rs` | Spawn and query local orchestrator daemon, persist auth snapshot | main-process supervisor + HTTP client | Rewrite; also consider moving logic into `packages/orchestrator` |
| `packages/desktop/src-tauri/src/orchestrator/manager.rs` | Orchestrator child-process state | main-process singleton service | Rewrite |
| `packages/desktop/src-tauri/src/openwork_server/mod.rs` | Spawn and track local OpenWork server, derive connect URLs | main-process supervisor | Rewrite or reduce if server hosting moves |
| `packages/desktop/src-tauri/src/openwork_server/spawn.rs` | Build OpenWork server spawn args/env | main-process spawn helper | Rewrite |
| `packages/desktop/src-tauri/src/openwork_server/manager.rs` | OpenWork server child-process state | main-process singleton service | Rewrite |
| `packages/desktop/src-tauri/src/opencode_router/spawn.rs` | Spawn router sidecar and health port | main-process spawn helper | Rewrite |
| `packages/desktop/src-tauri/src/opencode_router/manager.rs` | Router child-process state | main-process singleton service | Rewrite |
| `packages/desktop/src-tauri/src/workspace/watch.rs` | Watch workspace/config files and emit reload events | `chokidar` or `fs.watch` in main | Rewrite; maybe move parity logic into server later |
| `packages/desktop/src-tauri/src/workspace/state.rs` | Persist workspace list in app data | `app.getPath('userData')` + JSON store | Rewrite |
| `packages/desktop/src-tauri/src/workspace/files.rs` | Seed starter files, merge config, download enterprise creator skills | main-process file/bootstrap service | Rewrite; some content seeding may move elsewhere |
| `packages/desktop/src-tauri/src/workspace/commands.rs` | Command-file helpers | Shared TS helper or server helper | Rewrite/shared |
| `packages/desktop/src-tauri/src/config.rs` | Resolve/read/write `opencode.json(c)` | Shared TS helper or server helper | Rewrite/shared |
| `packages/desktop/src-tauri/src/fs.rs` | Recursive copy helper | `fs.cp` / utility library | Rewrite/shared |
| `packages/desktop/src-tauri/src/paths.rs` | Home/XDG/PATH/sidecar resolution | Node `os`, `path`, `process.resourcesPath` | Rewrite |
| `packages/desktop/src-tauri/src/platform/unix.rs` | Hidden/background spawn behavior on Unix | spawn options in Node | Rewrite |
| `packages/desktop/src-tauri/src/platform/windows.rs` | Hidden/background spawn behavior on Windows | `windowsHide`, platform spawn options | Rewrite |
| `packages/desktop/src-tauri/src/bun_env.rs` | Child-process env sanitization for Bun/Node | shared TS env sanitizer | Rewrite |
| `packages/desktop/src-tauri/src/updater.rs` | Updater environment checks | main-process updater helper | Rewrite |

## 5. Packaging, Release, CI, and Docs Inventory

### 5.1 Package manifests and scripts

| File | Current Tauri/Rust assumption | Electron equivalent |
| --- | --- | --- |
| `package.json` | Root `dev` and `tauri` scripts shell into Tauri CLI | Replace desktop runner with Electron dev/build scripts |
| `packages/desktop/package.json` | `tauri dev`, `tauri build`, Tauri CLI devDependency | Make this the Electron desktop package with main/preload/build config |
| `packages/app/package.json` | Renderer depends on `@tauri-apps/api` and six Tauri plugins | Remove Tauri dependencies; add preload-safe platform API as needed |
| `packages/app/scripts/bump-version.mjs` | Updates `Cargo.toml` and `tauri.conf.json` in lockstep with app/desktop versions | Remove Cargo/Tauri sync logic; keep desktop package and updater/build metadata aligned |

### 5.2 Tauri config, bundle metadata, and sidecars

| File | Current assumption | Electron equivalent |
| --- | --- | --- |
| `packages/desktop/src-tauri/tauri.conf.json` | Window config, updater endpoint/pubkey, external sidecars, protocol scheme | `electron-builder` or `electron-forge` config with `files`, `extraResources`, `protocols`, `publish`, `mac`/`win`/`linux` targets |
| `packages/desktop/src-tauri/tauri.dev.conf.json` | Separate dev app identity and `openwork-dev` scheme | Electron dev config or explicit development protocol handling |
| `packages/desktop/src-tauri/entitlements.plist` | Tauri/macOS entitlements | Electron hardened runtime entitlements |
| `packages/desktop/src-tauri/Info.dev.plist` | Dev macOS bundle metadata and protocol entries | Electron `extendInfo` or equivalent |
| `packages/desktop/src-tauri/icons/*` | Tauri icon bundle layout, plus generated mobile icon assets | Reuse desktop icons in Electron builder; review whether mobile artifacts can be deleted |

### 5.3 Sidecar prep and release scripts

| File | Current assumption | Electron equivalent |
| --- | --- | --- |
| `packages/desktop/scripts/prepare-sidecar.mjs` | Writes sidecars into `src-tauri/sidecars`, uses Tauri target conventions | Stage unpacked binaries into Electron resources |
| `packages/desktop/scripts/tauri-before-dev.mjs` | Dev bootstrap assumes Tauri and WebKitGTK requirements | Replace with Electron dev bootstrap; drop WebKitGTK checks |
| `scripts/release/install-opencode-sidecar.mjs` | Stages sidecars for Tauri bundle layout | Stage for Electron resources |
| `scripts/release/review.mjs` | Validates desktop, Tauri, and Cargo versions match | Validate desktop package + build config + updater metadata instead |
| `scripts/release/verify-tag.mjs` | Confirms release tag matches Tauri and Cargo versions | Stop reading Cargo/Tauri config |
| `scripts/release/generate-latest-json.mjs` | Generates Tauri updater `latest.json` | Replace with Electron updater metadata or let builder publish it |
| `scripts/stats.mjs`, `scripts/stats.test.mjs` | Treat `.sig`, `.app.tar.gz`, `latest.json` as desktop updater assets | Update to Electron artifact taxonomy (`latest*.yml`, `.blockmap`, `zip`, `exe`, etc.) |

### 5.4 CI and GitHub Actions

| File | Current assumption | Electron equivalent |
| --- | --- | --- |
| `.github/workflows/build-desktop.yml` | Installs Rust + WebKitGTK, runs Cargo tests, builds with Tauri | Install Electron packaging deps, run renderer/main/preload tests, build with Electron packager |
| `.github/workflows/release-macos-aarch64.yml` | `build_tauri`, `publish-tauri`, consolidated `latest.json`, Tauri asset naming | Rename to Electron build/publish workflow; publish Electron updater metadata |
| `.github/workflows/prerelease.yml` | Same as release flow but prerelease-oriented, still Tauri-first | Mirror Electron release flow |
| `.github/actions/run-tauri-release-build/action.yml` | Wraps `tauri-apps/tauri-action` | Replace with custom Electron build/publish action |
| `.github/actions/setup-desktop-build-env/action.yml` | Sets up Rust and Cargo cache for desktop builds | Simplify for Node/Electron packaging only |

### 5.5 Documentation and skill files that encode Tauri assumptions

| File | Current assumption | Electron migration update |
| --- | --- | --- |
| `README.md` | Contributor setup requires Rust, Tauri CLI, WebKitGTK; folder picker described as Tauri plugin | Rewrite for Electron desktop stack |
| `README_ZH.md` | Same as English README | Rewrite |
| `README_ZH_hk.md` | Same as English README | Rewrite |
| `AGENTS.md` | Technology stack says Tauri 2.x, IPC says Tauri commands + events, release steps mention Cargo/Tauri sync | Rewrite |
| `ARCHITECTURE.md` | Uses phrase "Tauri-only file operations" | Rename to desktop-shell or Electron fallback terminology |
| `RELEASE.md` | Version bump says app + desktop + Tauri + Cargo | Rewrite |
| `.opencode/skills/tauri-solidjs/SKILL.md` | Tauri-specific development skill | Replace with Electron desktop skill |
| `.opencode/skills/openwork-core/SKILL.md` | Recommends `pnpm tauri dev` and Tauri commands for system access | Rewrite |
| `services/openwork-share/README.md` | Deep-link docs implicitly rely on Tauri registration | Update wording to Electron protocol handling while preserving URL contract |
| `STATS_V2.md` | Asset taxonomy assumes Tauri updater artifacts | Rewrite |

## 6. Cross-Package Tauri Assumptions Outside `packages/desktop`

| File | Assumption | Electron consequence |
| --- | --- | --- |
| `packages/orchestrator/src/cli.ts` | CORS/default allowed origins include `tauri://localhost` and `http://tauri.localhost` | Add Electron desktop origin/protocol strategy or simplify to the actual runtime origin model |
| `packages/app/pr/*` product docs | Several PRDs and notes describe Tauri fallback behavior and Tauri watcher events | Future migration work must update product/internal planning docs too |

## 7. Capabilities That Must Survive, Even If The Implementation Moves

Nothing in this section is optional product scope. These capabilities are required; the only question is where they should live after Tauri/Rust is gone.

| Capability group | Current surfaces | Requirement after migration | Preferred implementation options |
| --- | --- | --- | --- |
| Local config mutation | `readOpencodeConfig`, `writeOpencodeConfig`, `workspaceOpenworkRead`, `workspaceOpenworkWrite` | Must remain available | Electron main file service, or OpenWork server APIs consumed by Electron |
| Skills management | `listLocalSkills`, `readLocalSkill`, `writeLocalSkill`, `installSkillTemplate`, `uninstallSkill`, `importSkill`, `opkgInstall` | Must remain available | Electron main + file/process services, or server-backed extension management |
| Command file management | `opencodeCommandList`, `opencodeCommandWrite`, `opencodeCommandDelete` | Must remain available | Electron main file service, or server-backed command management |
| Orchestrator lifecycle | `orchestratorStatus`, `orchestratorWorkspaceActivate`, `orchestratorInstanceDispose`, `orchestratorStartDetached` | Must remain available | Electron main orchestrator client/supervisor, or OpenWork server proxy over orchestrator |
| OpenWork server host controls | `openworkServerInfo`, `openworkServerRestart` | Must remain available if desktop continues to host locally | Electron main host supervisor |
| Engine lifecycle | `engineStart`, `engineStop`, `engineRestart`, `engineInfo`, `engineDoctor`, `engineInstall` | Must remain available | Electron main child-process supervisor |
| Scheduler administration | `schedulerListJobs`, `schedulerDeleteJob` | Must remain available | Electron main OS integration, or delegated scheduler service invoked from Electron |
| OpenCode admin wrappers | `opencodeDbMigrate`, `opencodeMcpAuth` | Must remain available | Electron main process wrappers, or server/OpenCode-owned admin endpoint |
| Native shell integrations | dialogs, open/reveal path, external URL open, deep links, updater, relaunch, titlebar control, Obsidian integration | Must remain available | Electron main/preload |
| Docker sandbox tooling | `sandboxDoctor`, `sandboxStop`, `sandboxCleanupOpenworkContainers`, `sandboxDebugProbe` | Must remain available | Electron main diagnostic/sandbox service, possibly backed by orchestrator |

Implementation note:

- "Move it" does not mean "drop it".
- "Do not port 1:1" only means we should avoid preserving Tauri's architecture when Electron or OpenWork server gives us a cleaner ownership model.
- The migration target is full capability parity with zero Tauri/Rust desktop artifacts.

## 8. Security and Risk Notes

1. Current Tauri capability ACLs are broad.
   - Electron must replace them with a much narrower preload API.
2. Child-process supervision is the critical boundary.
   - `engine_start`, `orchestrator_start_detached`, Docker helpers, updater, scheduler deletion, and reset flows must never become renderer-direct Node access.
3. Sidecars cannot live inside ASAR.
   - Packaging must explicitly unpack executable resources.
4. Auth persistence needs review.
   - The current orchestrator auth snapshot model should be reconsidered for secure storage.
5. Updater format changes are non-trivial.
   - Tauri `latest.json` and signature flow do not carry over directly.
6. Protocol handling changes ownership.
   - Deep links should enter in Electron main, not renderer.
7. Linux packaging changes significantly.
   - WebKitGTK/runtime dependency story disappears, but Chromium/Electron package size and updater behavior change.
8. Capability parity is mandatory.
   - We are removing Tauri and Rust, not removing desktop features.

## 9. Suggested Subagent Workstreams

### Workstream A: Desktop shell architecture and security boundary

- Define Electron main/preload/renderer contract.
- Replace `isTauriRuntime()` with a generic desktop capability surface.
- Specify `window.openworkDesktop` API shape.
- Deliverable: IPC contract doc and preload API spec.

### Workstream B: Local runtime supervision

- Port engine/orchestrator/openwork-server/opencode-router child-process management.
- Port sidecar resolution, PATH/env setup, dev-mode isolation, cleanup-on-exit.
- Deliverable: Electron main service map and spawn strategy.

### Workstream C: Workspace/config/skills parity

- Separate what stays in Electron main from what moves to OpenWork server.
- Cover workspace bootstrap, import/export, `.opencode/openwork.json`, skills, command files, config files.
- Deliverable: parity matrix with keep/move decisions per API.

### Workstream D: Native integrations

- Dialogs, shell open/reveal, deep links, updater, window decorations, Obsidian, scheduler, Docker diagnostics.
- Deliverable: Electron native integration spec.

### Workstream E: Packaging and release

- Replace Tauri config, Cargo, updater metadata, sidecar bundle strategy, GitHub Actions, notarization/signing, Linux artifacts, AUR flow.
- Deliverable: packaging architecture decision and release pipeline plan.

### Workstream F: Docs, skills, and contributor tooling

- Update README, AGENTS, ARCHITECTURE, RELEASE, skills, internal docs, and asset taxonomy docs.
- Deliverable: docs migration checklist.

## 10. Recommended Execution Order

1. Freeze the contract.
   - Approve Electron architecture, preload API shape, protocol strategy, updater choice, sidecar packaging approach.
2. Build shell skeleton.
   - Main process, preload bridge, runtime detection, basic window lifecycle.
3. Port local runtime supervision.
   - Engine, orchestrator, OpenWork server, router, cleanup behavior.
4. Port native UI integrations.
   - Dialogs, shell, deep links, updater, titlebar/window controls.
5. Decide what moves to server.
   - Workspace/config/skills/commands/scheduler/MCP auth surfaces.
6. Replace renderer dependencies.
   - Remove direct `@tauri-apps/*` imports and swap to preload/server APIs.
7. Replace packaging and release.
   - CI, notarization, artifact publishing, updater metadata, AUR assumptions.
8. Update docs and skills.
   - Contributor guidance, release guidance, agent skills, internal docs.

## 11. Open Questions To Resolve Before Coding

1. Do we keep GitHub Releases as the updater backend, or choose a different Electron-friendly distribution model?
2. Do we preserve `openwork://` and `openwork-dev://`, or simplify to one scheme?
3. Do we keep bundling all sidecars, or move some to first-run download/cache?
4. Does desktop keep owning scheduler deletion and Docker cleanup, or do those move to orchestrator/server packages?
5. Does desktop continue to host OpenWork server directly, or does `openwork-orchestrator` become the single host path?
6. How much of local config/skills/commands editing is still allowed as a desktop-only fallback after Electron lands?
7. What is the secure replacement for current orchestrator auth snapshot persistence?

## 12. Bottom Line

OpenWork is not just using Tauri as a thin window wrapper. Tauri and Rust currently own:

- the renderer's desktop bridge
- all privileged local IPC
- local child-process supervision
- deep-link and updater plumbing
- local workspace/config/skills/command file mutation
- Docker and scheduler administration
- sidecar packaging and release metadata
- contributor docs and agent skills

The clean migration path is not "drop Tauri and hope Electron covers the basics." The clean migration path is:

1. define an Electron main/preload contract,
2. preserve every required desktop capability behind that contract,
3. move portable workspace/config behavior toward OpenWork server parity where it improves ownership,
4. keep truly local/privileged behaviors in Electron main or custom Electron-owned services,
5. then replace packaging, updater, docs, and release flow so no Tauri/Rust desktop artifacts remain.
