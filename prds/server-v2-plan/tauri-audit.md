# Tauri Audit

## Scope

This audit covers the desktop-native layer under `apps/desktop`, especially `apps/desktop/src-tauri/**` and the desktop scripts that are directly part of dev/build/runtime.

## Alignment Note

This audit documents the current desktop-native footprint, not the final target-state boundary.

To fully match `prds/server-v2-plan/ideal-flow.md`, durable workspace registry state, workspace watchers, config and file mutation, remote workspace persistence, and runtime/workspace control should move behind the main server, leaving the desktop shell with only native bootstrap, reconnect state, and UI-hosting duties.

The goal is to document the desktop app lifecycle and every meaningful place where the desktop shell touches the local system, native runtime, sidecars, files, or OS services.

This document now assumes the target architecture is a single main server API surface, with bootstrap and supervision responsibilities also collapsing into the server over time.

## Disposition Labels

- `Stay`: should remain in the desktop shell because it is truly native-shell, OS, packaging, windowing, or local UI-hosting behavior.
- `Move`: should move behind the server because it is real workspace behavior or runtime coordination.
- `Split`: the trigger or presentation may stay in the desktop shell, but the actual workspace/runtime capability should move behind the server.

## High-Level Lifecycle

1. Tauri boots the desktop shell.
2. The shell registers native plugins, commands, deep-link handling, and exit behavior.
3. Dev/build scripts prepare sidecars and frontend assets.
4. The desktop layer starts or reconnects to the local OpenWork server host path.
5. Any deeper runtime ownership of OpenCode, router, or orchestrator behavior is migration debt that should collapse inward behind the server over time.
6. Workspace state is loaded and persisted.
7. Native file watchers, dialogs, updater checks, and process management continue during the session.

## App Shell Bootstrap

Disposition guidance:

- `run()` -> `Stay`
- `stop_managed_services()` -> `Stay`
- deep-link forwarding helpers -> `Stay`
- window visibility helpers -> `Stay`
- `set_dev_app_name()` -> `Stay`

### `run()`

- What it does: boots the native desktop shell, installs Tauri plugins, registers all Tauri commands, and wires the application lifecycle.
- Called from and when: called from the desktop app entrypoint at application launch.
- Ends up calling: Tauri plugin setup, command registration, window lifecycle hooks, deep-link hooks, updater support, shell/process support, and cleanup on exit.

### `stop_managed_services()`

- What it does: best-effort shutdown for native child services managed by the desktop shell.
- Called from and when: called on app exit and exit-request flows.
- Ends up calling: child-process kill paths for the engine, orchestrator, OpenWork server, and router.

### `forwarded_deep_links()`, `emit_native_deep_links()`, `emit_forwarded_deep_links()`

- What they do: normalize incoming deep links and forward them into the frontend as native events.
- Called from and when: called when a second app instance is launched or when the OS opens the app via URL.
- Ends up calling: Tauri event emission into the frontend.

### `show_main_window()` / `hide_main_window()`

- What they do: show, focus, or hide the native window.
- Called from and when: called during reopen, second-instance handoff, and close interception flows.
- Ends up calling: native window APIs.

### `set_dev_app_name()`

- What it does: renames the macOS process to `OpenWork - Dev` in dev mode.
- Called from and when: called during desktop setup in dev mode.
- Ends up calling: macOS process metadata APIs.

## Dev And Build Pipeline

Disposition guidance:

- `tauri-before-dev.mjs` -> `Stay`
- `tauri-before-build.mjs` -> `Stay`
- `prepare-sidecar.mjs` -> `Stay`
- `dev-windows.mjs` -> `Stay`
- `chrome-devtools-mcp-shim.ts` -> `Stay`
- `build.rs` -> `Stay`

### `tauri-before-dev.mjs`

- What it does: prepares sidecars, validates Linux desktop dependencies, detects or starts the UI dev server, and keeps process trees under control in dev mode.
- Called from and when: called by Tauri `beforeDevCommand` during `pnpm dev` for the desktop app.
- Ends up calling: sidecar preparation, `pkg-config`, the app dev server, process spawn/kill logic, and local HTTP checks against the Vite server.

### `tauri-before-build.mjs`

- What it does: prepares sidecars and builds the frontend before packaging.
- Called from and when: called by Tauri `beforeBuildCommand` during desktop builds.
- Ends up calling: sidecar prep and frontend build commands.

### `prepare-sidecar.mjs`

- What it does: builds and stages all bundled sidecars and downloads the pinned OpenCode binary.
- Called from and when: called by both dev and build prep scripts.
- Ends up calling: Bun compile steps, GitHub release downloads, filesystem copies into `src-tauri/sidecars`, and version metadata generation.

### `dev-windows.mjs`

- What it does: Windows-specific desktop dev launcher that cleans up stale processes and injects the right toolchain environment before running Tauri.
- Called from and when: called by `pnpm dev:windows`.
- Ends up calling: PowerShell/taskkill-style cleanup, Windows compiler environment setup, and `tauri dev`.

### `chrome-devtools-mcp-shim.ts`

- What it does: creates the bundled shim for Chrome DevTools MCP.
- Called from and when: built during sidecar prep, later executed when that sidecar is needed.
- Ends up calling: `npm exec` for the Chrome DevTools MCP package.

### `build.rs`

- What it does: injects build metadata and ensures sidecar placeholders or binaries exist during Rust compilation.
- Called from and when: called by Cargo during desktop compilation.
- Ends up calling: compile-time file generation/copy behavior and build metadata injection.

## OpenCode Engine Lifecycle

Disposition guidance:

- `engine_start()` -> `Move`
- `spawn_engine()` -> `Move`
- `find_free_port()` / `build_engine_args()` -> `Move`
- `engine_stop()` / `engine_restart()` -> `Move`
- `engine_info()` -> `Split`
- `engine_doctor()` and related helpers -> `Split`
- `engine_install()` -> `Split`
- `EngineManager` -> `Move`
- `bun_env_overrides()` -> `Move`

Reasoning: the desktop app should keep the ability to launch the OpenWork server, but OpenCode runtime ownership and coordination should move behind the server boundary over time.

### `engine_start()`

- What it does: starts the local OpenCode runtime and the supporting native stack around it.
- Called from and when: called from the UI when the user starts a local runtime, creates a workspace, reconnects, or begins a local session flow.
- Ends up calling: local project-directory setup, `opencode.json` seeding, port selection, credential generation, engine spawn, OpenWork server startup, and OpenCodeRouter startup.

### `spawn_engine()`

- What it does: launches `opencode serve` directly, either from a bundled sidecar or an installed binary.
- Called from and when: called by `engine_start()` in direct-engine mode.
- Ends up calling: process spawning, working-directory setup, PATH/env overrides, and OpenCode HTTP serving.

### `find_free_port()` / `build_engine_args()`

- What they do: allocate a local port and define the exact command arguments for OpenCode serve.
- Called from and when: called during engine startup.
- Ends up calling: localhost TCP allocation and process argument setup.

### `engine_stop()` / `engine_restart()`

- What they do: stop or restart the local engine stack.
- Called from and when: called from UI controls and restart/recovery flows.
- Ends up calling: child-process shutdown/restart across engine, router, orchestrator, and hosted OpenWork server.

### `engine_info()`

- What it does: reports current engine/runtime status, including reconnecting to orchestrator auth/state after relaunch.
- Called from and when: called by the UI during startup probes, status refresh, and settings pages.
- Ends up calling: in-memory manager state access and orchestrator state/auth file reads.

### `engine_doctor()` and related helpers

- What they do: detect whether OpenCode is installed and usable, inspect binary paths, and run lightweight capability probes.
- Called from and when: called from onboarding and settings diagnostics.
- Ends up calling: filesystem path checks and child-process execution such as `--version` and `serve --help`.

### `engine_install()`

- What it does: installs OpenCode from the official install script.
- Called from and when: called from onboarding or settings when the user asks to install OpenCode.
- Ends up calling: shell execution, network download, and writes under the user install directory.

### `EngineManager`

- What it does: stores the live engine child process, ports, credentials, and captured logs.
- Called from and when: used throughout engine startup, status, stop, and reconnect flows.
- Ends up calling: process lifecycle and in-memory runtime state management.

### `bun_env_overrides()`

- What it does: normalizes Bun-related environment for child processes.
- Called from and when: used whenever the desktop shell launches Bun-based sidecars.
- Ends up calling: child-process env mutation.

## Orchestrator Lifecycle

Disposition guidance:

- all orchestrator lifecycle and sandbox functions in this section -> `Move`

Reasoning: these are runtime and workspace orchestration concerns, not UI concerns.

### `spawn_orchestrator_daemon()`

- What it does: launches the OpenWork orchestrator daemon sidecar.
- Called from and when: called by `engine_start()` when the runtime mode uses the orchestrator.
- Ends up calling: child-process spawn, daemon HTTP startup, OpenCode management, PATH/env setup, and sidecar discovery.

### `wait_for_orchestrator()` / `fetch_orchestrator_health()` / `fetch_orchestrator_workspaces_with_timeout()`

- What they do: poll the orchestrator until it is healthy and query its workspace/runtime state.
- Called from and when: called during startup and UI status refresh.
- Ends up calling: localhost HTTP requests against orchestrator endpoints.

### `resolve_orchestrator_data_dir()`, `read_orchestrator_state()`, `read_orchestrator_auth()`, `write_orchestrator_auth()`, `clear_orchestrator_auth()`

- What they do: manage orchestrator runtime state and auth snapshots on disk.
- Called from and when: used during engine/orchestrator startup, reconnect, shutdown, and recovery.
- Ends up calling: reads and writes under the orchestrator data directory.

### `request_orchestrator_shutdown()` / `OrchestratorManager::stop_locked()`

- What they do: gracefully stop the orchestrator if possible, and kill it if needed.
- Called from and when: called during engine stop and app exit.
- Ends up calling: orchestrator `/shutdown` and child-process kill fallback.

### `orchestrator_status()`

- What it does: reports orchestrator/OpenCode/workspace status to the UI.
- Called from and when: called by settings and runtime status UI.
- Ends up calling: JSON state reads and localhost health/workspace requests.

### `orchestrator_workspace_activate()`

- What it does: registers and activates a workspace inside the orchestrator.
- Called from and when: called when the user points the app at a local workspace in orchestrator mode.
- Ends up calling: orchestrator workspace creation and activation endpoints.

### `orchestrator_instance_dispose()`

- What it does: disposes a running workspace instance.
- Called from and when: called from cleanup/dispose UI.
- Ends up calling: orchestrator disposal endpoints.

### `orchestrator_start_detached()`

- What it does: starts a detached host stack, optionally sandboxed, and reports progress back to the UI.
- Called from and when: called when the user creates a detached worker or remote sandbox.
- Ends up calling: `openwork-orchestrator start --detach`, token generation, health polling, optional owner-token issuance, and progress event emission.

### `sandbox_doctor()`, `sandbox_stop()`, `sandbox_cleanup_openwork_containers()`, `sandbox_debug_probe()`

- What they do: inspect and clean up Docker-based sandbox environments.
- Called from and when: called from developer/debug settings and recovery flows.
- Ends up calling: Docker CLI commands, temporary probe workspaces, and local filesystem cleanup.

## Hosted OpenWork Server Lifecycle

Disposition guidance:

- `start_openwork_server()` -> `Split`
- `spawn_openwork_server()` -> `Stay`
- `resolve_openwork_port()` -> `Stay`
- token and state helpers in `openwork_server/mod.rs` -> `Split`
- `build_urls()` -> `Stay`
- `openwork_server_info()` / `openwork_server_restart()` -> `Split`
- `OpenworkServerManager` -> `Split`

Reasoning: the desktop shell should keep launch/supervision of the local OpenWork server process, but token semantics, runtime info, and restart/control behavior should keep shrinking into the server over time.

### `start_openwork_server()`

- What it does: starts the local desktop-hosted OpenWork server and tracks its tokens, URLs, and health.
- Called from and when: called by engine startup and explicit OpenWork server restart flows.
- Ends up calling: port selection, token generation/load, server spawn, health checks, optional owner-token issuance, and persistence of port/token state; the launch path should stay, while token/control semantics should move inward.

### `spawn_openwork_server()`

- What it does: launches the `openwork-server` sidecar.
- Called from and when: called by `start_openwork_server()`.
- Ends up calling: child-process spawn, cwd selection, and env var injection including OpenCode base URL, OpenCode creds, and OpenWork tokens.

### `resolve_openwork_port()`

- What it does: picks an OpenWork server port with reuse and conflict avoidance.
- Called from and when: called on host-mode server start.
- Ends up calling: local TCP port selection logic.

### token and state helpers in `openwork_server/mod.rs`

- What they do: load/create workspace client/host/owner tokens and persist preferred ports and state.
- Called from and when: called on every hosted-server start and reconnect.
- Ends up calling: filesystem reads and writes in app data; the minimum host bootstrap state may stay, but owner/control semantics should move behind the server.

### `build_urls()`

- What it does: derives shareable LAN and mDNS URLs when remote access is enabled.
- Called from and when: called during hosted-server startup.
- Ends up calling: hostname and local-IP discovery.

### `openwork_server_info()` / `openwork_server_restart()`

- What they do: expose OpenWork server runtime info and restart it with the current engine credentials/workspaces.
- Called from and when: called from settings, remote-access, and recovery UI.
- Ends up calling: manager state reads or a full restart path; these are transitional control-plane responsibilities that should simplify as the server absorbs more runtime ownership.

### `OpenworkServerManager`

- What it does: stores hosted-server child state, URLs, tokens, and captured logs.
- Called from and when: used throughout hosted-server lifecycle management.
- Ends up calling: in-memory child-process/runtime state management, including some control-plane state that should shrink over time.

## OpenCodeRouter Lifecycle

Disposition guidance:

- router child launch and stop helpers -> `Split`
- router status/config/product API functions -> `Move`

Reasoning: router config, status, and product-facing control should become part of server-owned workspace behavior, and even router child launch should ideally end up under server-owned supervision.

### `opencodeRouter_start()`

- What it does: starts the router sidecar and captures its startup state.
- Called from and when: called automatically after engine start and from router settings UI.
- Ends up calling: router spawn, health-port allocation, and child-process log capture.

### `spawn_opencode_router()`

- What it does: launches `opencode-router serve` with the active OpenCode connection.
- Called from and when: called by `opencodeRouter_start()`.
- Ends up calling: child-process spawn and localhost router startup.

### `opencodeRouter_status()` / `opencodeRouter_info()`

- What they do: report router health, config, and CLI-derived status.
- Called from and when: called from router settings/status UI.
- Ends up calling: localhost router health/config endpoints and router CLI commands.

### `opencodeRouter_stop()`

- What it does: stops the router process.
- Called from and when: called from UI stop/recovery actions.
- Ends up calling: child-process kill.

### `opencodeRouter_config_set()`

- What it does: mutates router configuration via the router CLI.
- Called from and when: called from router settings UI.
- Ends up calling: router CLI config writes.

## Workspace State, Files, And Watchers

Disposition guidance:

- `workspace_bootstrap()` -> `Split`
- workspace state load/save/repair helpers -> `Split`
- `workspace_create()` -> `Move`
- `ensure_workspace_files()` -> `Move`
- enterprise creator skills seeding helpers -> `Move`
- remote workspace create/update/forget/set-selected/set-runtime-active helpers -> `Split`
- authorized-root and `openwork.json` read/write helpers -> `Move`
- workspace import/export config helpers -> `Move`
- workspace watch/update helpers -> `Move`

Reasoning: the app should keep only transient selection and reconnect state. The durable registry of servers/workspaces, plus mutation, file writes, config writes, import/export, and reload watching, should move behind the server.

### `workspace_bootstrap()`

- What it does: loads persisted workspace state, repairs it, and starts the native file watcher.
- Called from and when: called very early from the UI during app bootstrap.
- Ends up calling: workspace-state reads and watcher setup.

### `load_workspace_state()`, `load_workspace_state_fast()`, `save_workspace_state()`, `repair_workspace_state()`

- What they do: persist and normalize the desktop app’s current workspace registry.
- Called from and when: used throughout startup, workspace mutation, and selection flows.
- Ends up calling: `openwork-workspaces.json` reads/writes and path canonicalization; in the ideal model this becomes transitional reconnect/cache state rather than the canonical registry.

### `workspace_create()`

- What it does: creates a new local workspace and seeds its initial OpenWork/OpenCode files.
- Called from and when: called from onboarding and create-workspace UI.
- Ends up calling: directory creation, starter file writes, and workspace-state updates.

### `ensure_workspace_files()`

- What it does: writes `.opencode` and related starter config files into a workspace.
- Called from and when: called by `workspace_create()`.
- Ends up calling: filesystem writes under the workspace path.

### `spawn_enterprise_creator_skills_seed()` / `seed_enterprise_creator_skills()`

- What they do: download and unpack starter skills from GitHub in the background.
- Called from and when: called for starter workspace setup.
- Ends up calling: network download, ZIP extraction, and workspace file writes.

### `workspace_create_remote()`, `workspace_update_remote()`, `workspace_forget()`, `workspace_set_selected()`, `workspace_set_runtime_active()`

- What they do: manage the app-side list of local and remote workspaces in the current implementation.
- Called from and when: called from workspace selection, remote connect, and remote disconnect flows.
- Ends up calling: workspace-state mutation and watcher target changes; durable remote workspace persistence should move behind the server.

### `workspace_add_authorized_root()`, `workspace_openwork_read()`, `workspace_openwork_write()`

- What they do: manage `.opencode/openwork.json` data for authorized roots and related settings.
- Called from and when: called from settings/permissions UI.
- Ends up calling: workspace-local config file reads and writes; in the ideal model this is server-side materialization into the OpenWork-managed workspace config directory.

### `workspace_export_config()` / `workspace_import_config()`

- What they do: export or import portable workspace config bundles.
- Called from and when: called from import/export UI.
- Ends up calling: zip creation/extraction and workspace filesystem mutation.

### `update_workspace_watch()` / `WorkspaceWatchState`

- What they do: watch the active workspace root and `.opencode/` for changes that require reload handling.
- Called from and when: watcher is armed at bootstrap and updated when runtime-active workspace changes.
- Ends up calling: native filesystem watching and frontend reload events.

## Local Config, Commands, And Skills

Disposition guidance:

- `read_opencode_config()` / `write_opencode_config()` -> `Move`
- command-file functions -> `Move`
- skill functions -> `Move`
- `copy_dir_recursive()` -> `Move`

Reasoning: these are explicit workspace/config mutation capabilities and belong to the server.

### `read_opencode_config()` / `write_opencode_config()`

- What they do: read and write local or global `opencode.json[c]` files.
- Called from and when: called by settings/config editors and by startup paths that seed project config.
- Ends up calling: config file reads and writes.

### command-file functions in `command_files.rs`

- What they do: list, write, and delete local OpenCode command markdown files.
- Called from and when: called from command-management UI.
- Ends up calling: filesystem mutation under `.opencode/commands`.

### skill functions in `skills.rs`

- What they do: list, read, write, install, import, and remove local skill directories.
- Called from and when: called from skills UI and local import/install flows.
- Ends up calling: skill directory reads, recursive copies, and deletions.

### `copy_dir_recursive()`

- What it does: recursively copies local directories.
- Called from and when: used when importing local skills.
- Ends up calling: filesystem traversal and file copy operations.

## Dialogs, Windowing, Deep Links, Updater

Disposition guidance:

- dialog wrappers -> `Stay`
- `set_window_decorations()` -> `Stay`
- deep-link scheme config and bridge -> `Stay`
- `updater_environment()` -> `Stay`

Reasoning: these are true desktop-shell concerns.

### dialog wrappers used by the frontend

- What they do: open native file/folder/save dialogs.
- Called from and when: called when the user picks folders, files, or export destinations.
- Ends up calling: Tauri dialog plugin and OS-native dialogs.

### `set_window_decorations()`

- What it does: toggles native window decorations.
- Called from and when: called from hide-titlebar preference changes.
- Ends up calling: native window APIs.

### deep-link scheme config and bridge

- What they do: register `openwork://` and `openwork-dev://`, receive deep links, and forward them into the UI.
- Called from and when: called at OS/app integration time and when deep links are opened.
- Ends up calling: OS URL-handler integration and frontend event routing.

### `updater_environment()`

- What it does: detects whether native auto-update is safe/supported on the current install.
- Called from and when: called from startup and settings/about UI.
- Ends up calling: executable/app-bundle path inspection.

## Scheduler, Reset, Cache, Auth

Disposition guidance:

- scheduler commands -> `Move`
- `reset_opencode_cache()` -> `Split`
- `reset_openwork_state()` -> `Split`
- `nuke_openwork_and_opencode_config_and_exit()` -> `Split`
- `opencode_mcp_auth()` -> `Move`
- `app_build_info()` -> `Stay`

Reasoning: job/MCP/runtime behavior should move to the server, while destructive app reset and app metadata remain partly shell-owned.

### scheduler commands

- What they do: inspect and remove scheduled OpenCode jobs.
- Called from and when: called from scheduler UI.
- Ends up calling: scheduler file reads plus OS scheduler removal through `launchctl` or `systemctl --user`.

### `reset_opencode_cache()`

- What it does: deletes local OpenCode cache directories.
- Called from and when: called from reset/repair UI.
- Ends up calling: filesystem deletion under XDG/macOS/Windows cache locations.

### `reset_openwork_state()`

- What it does: stops managed services and clears OpenWork desktop state.
- Called from and when: called from reset UI.
- Ends up calling: process shutdown and filesystem deletion in app-data/config/cache paths.

### `nuke_openwork_and_opencode_config_and_exit()`

- What it does: performs a broader local reset across OpenWork and OpenCode state, then exits.
- Called from and when: called from destructive settings/reset flows.
- Ends up calling: large-scale filesystem deletion and app exit.

### `opencode_mcp_auth()`

- What it does: runs `opencode mcp auth <server>` in an authorized workspace.
- Called from and when: called from MCP authorization UI.
- Ends up calling: local process spawn, path validation, and any browser/OAuth flow the child process triggers.

### `app_build_info()`

- What it does: exposes desktop build/version metadata.
- Called from and when: called from about/settings UI.
- Ends up calling: compile-time metadata reads only.

## Supporting Native Path And Platform Helpers

Disposition guidance:

- PATH helpers -> `Stay`
- platform process-launch helpers -> `Stay`
- Tauri capability manifest -> `Stay`

Reasoning: these are implementation details of the native desktop shell itself.

### `prepended_path_env()` / `sidecar_path_candidates()`

- What they do: construct a safe PATH that includes bundled sidecars and common tool locations.
- Called from and when: used when launching engine, orchestrator, router, and similar sidecars.
- Ends up calling: child-process env mutation.

### platform `command_for_program()` / `configure_hidden()` helpers

- What they do: normalize native process spawning behavior across Unix and Windows.
- Called from and when: used by diagnostics, sandbox helpers, and auth/process tools.
- Ends up calling: OS-specific process-launch behavior.

### Tauri capability manifest

- What it does: grants the desktop app permission to use native dialogs, deep links, updater, HTTP, process, opener, and shell features.
- Called from and when: applied by the Tauri runtime.
- Ends up calling: Tauri capability gating for the whole native shell.

## Coverage Limits

- This audit stays focused on code in `apps/desktop`.
- It describes the frontend boundary only when needed to explain who triggers a native call.
- It does not attempt to re-document all downstream behavior inside `apps/server`, `apps/orchestrator`, or OpenCode itself.
