# Learnings

Before any agent starts a step in `steps.json`, it must read this file from top to bottom.

After an agent finishes a step:

- If it discovered any durable, non-obvious, migration-relevant information, prepend a new entry to the top of this file.
- If there are no meaningful new learnings, leave this file unchanged.

Entry format:

```md
## YYYY-MM-DD HH:MM - Step XXX - Short title

- Learning 1
- Learning 2
- Any important constraint, gotcha, or follow-up note
```

Guidance:

- Keep newest entries at the top, directly under this instruction block.
- Record only things that will help later agents avoid mistakes or duplicate investigation.
- Do not log routine status updates here; only reusable learnings.

---

## 2026-03-15 15:00 - Step 035 - Implement router localhost groups config path

- The groups-enabled path does not need a generic loopback proxy: a router-owned Electron method that only talks to `http://127.0.0.1:<healthPort>/config/groups` is narrow enough to preserve security while keeping the existing caller semantics.
- Documenting that restriction in the router service itself helps future steps avoid widening the contract accidentally when more localhost-only router helpers get added.

## 2026-03-15 14:58 - Step 034 - Implement opencode-router lifecycle service

- The router shell fits the same Electron service pattern as engine/openwork-server: keep a child-process-backed state snapshot for `info`, but use the router CLI's `status --json` output to preserve the richer identity/channel DTO used by the UI.
- Router startup reliability depends on separating two concerns: process supervision with log capture, and health-port polling with retry-on-port-collision when the caller did not pin a port explicitly.

## 2026-03-15 14:12 - Step 033 - Implement local OpenWork server lifecycle service

- The local OpenWork server service can stay thin if it derives restart inputs from the current engine state: project directory, OpenCode base URL, and auth fields are already the core contract the existing UI expects.
- Preserving `connectUrl`, `lanUrl`, and `mdnsUrl` behavior does not require native mDNS APIs in the desktop shell; deriving them from `hostname()` plus the first non-internal IPv4 interface is enough to keep the same outward DTO shape.

## 2026-03-15 14:09 - Step 032 - Implement sandbox doctor, cleanup, and debug probe

- The Docker diagnostic path is easiest to keep support-friendly when every command returns structured debug payloads (`status`, `stdout`, `stderr`, selected binary, candidate list) instead of collapsing failures into a single opaque string.
- The debug probe becomes much cheaper to maintain if it composes existing capabilities: run `sandboxDoctor`, reuse `startDetached` for the actual sandbox bring-up, then collect `docker inspect` / `docker logs` and cleanup results into one final report.

## 2026-03-15 14:03 - Step 031 - Implement detached orchestrator start and sandbox progress events

- The detached-host flow can stay orchestration-first in Electron: launch `openwork start --detach ...`, then treat renderer-visible progress as a typed event stream driven by health polling rather than by exposing the spawned process itself.
- Once the event bus exists, sandbox progress becomes just another domain event (`sandboxCreateProgress`), so the preload contract can subscribe with the same pattern as deep links and updater status instead of inventing a special-case IPC shape.

## 2026-03-15 14:00 - Step 030 - Implement orchestrator status activate and dispose service

- The lighter orchestrator flows can stay daemon-owned: read fallback state from `openwork-orchestrator-state.json`, then enrich it with live `/health` and `/workspaces` calls when the daemon base URL is available.
- `activateWorkspace` and `disposeInstance` both depend on the same orchestration pattern: first ensure the workspace exists via `POST /workspaces`, then operate on the returned workspace ID; that keeps Electron aligned with the orchestrator's source of truth instead of inventing its own registry.

## 2026-03-15 13:57 - Step 029 - Implement engine lifecycle service

- Keeping engine runtime state in an Electron-owned singleton lets `start`/`stop`/`restart` stay preload-safe while still tracking auth fields, log tails, runtime mode, and restart inputs for later reuse.
- For orchestrator mode, preserving clean service boundaries means engine lifecycle should only spawn and stop the orchestrator-managed OpenCode process plus auth snapshot, leaving local OpenWork server and router startup for their dedicated later steps.

## 2026-03-15 11:27 - Step 028 - Implement engine binary resolution and doctor service

- Engine doctor logic stays testable if binary resolution is kept as a pure note-producing helper: evaluate `OPENCODE_BIN_PATH`, optional sidecar candidates, PATH lookups, and common GUI-missing tool directories in a deterministic order and return the full note trail alongside the chosen binary.
- GUI apps often miss shell PATH customizations, so the doctor probe should execute with a PATH rebuilt from common tool directories plus the inherited PATH; otherwise Electron can falsely report that a working CLI install is missing.

## 2026-03-15 11:23 - Step 027 - Implement skill import and opkg install service

- Constrained process execution is easiest to enforce by encoding the exact fallback command list in the service (`opkg`, `openpackage`, `pnpm dlx opkg`, `npx opkg`) instead of building a generic command runner and trying to lock it down later.
- Skill-directory imports do not need a separate archive format: once the project skill root helper exists, a guarded recursive copy into `.opencode/skills/<name>` preserves the current desktop-only import behavior with a much smaller surface area than arbitrary filesystem APIs.

## 2026-03-15 11:22 - Step 026 - Implement local skills CRUD and template install service

- Skill discovery is broader than a single folder: preserve the current search order across project ancestry (`.opencode/skills`, legacy `.opencode/skill`, `.claude/skills`) and global roots (`XDG`, `.claude`, `.agents`, `.agent`) before deduping by skill name.
- Skill directories can be either flat (`skills/<name>/SKILL.md`) or one level nested by domain (`skills/<domain>/<name>/SKILL.md`), so both listing and uninstall logic need to scan one level deeper to avoid silently missing valid skills.

## 2026-03-15 11:19 - Step 025 - Implement opencode config CRUD service

- Keeping config-path resolution in its own service preserves the current `.jsonc`-first behavior: prefer `opencode.jsonc`, fall back to `opencode.json`, and create a new `opencode.jsonc` file when neither exists.
- The global config path logic is intentionally shared with command files (`XDG_CONFIG_HOME` first, then `HOME/.config`), so matching that resolution order avoids subtle scope mismatches between desktop config and desktop commands.

## 2026-03-15 11:17 - Step 024 - Implement command file CRUD service

- Reusing the same command-name sanitization and frontmatter serializer for both seeded commands and user-authored command files keeps command markdown stable across workspace bootstrap and later CRUD edits.
- The current scope model is intentionally simple: workspace commands resolve under `<projectDir>/.opencode/commands`, while global commands resolve under `XDG_CONFIG_HOME/opencode/commands` or `HOME/.config/opencode/commands`; matching that split avoids surprising migration drift.

## 2026-03-15 11:15 - Step 023 - Implement authorized roots mutation

- Authorized-root updates are safer when the service first resolves the workspace by normalized local path instead of trusting the raw incoming string; that prevents remote workspaces or typoed paths from mutating arbitrary config files.
- Once `openworkRead` / `openworkWrite` exist, `addAuthorizedRoot` becomes a thin composition layer, which keeps path validation and JSON persistence logic centralized for the next workspace-related steps.

## 2026-03-15 11:14 - Step 022 - Implement workspace archive import/export

- The workspace archive path is easiest to keep compatible when the service itself owns both halves: export only the allowed config files plus `manifest.json`, and import only `opencode.json` / `.opencode/**` entries after a strict archive-path safety check.
- Rewriting imported `authorizedRoots` to `[targetDir]` is an important portability fix, not just bookkeeping; otherwise imported local workspaces keep stale source-machine paths and immediately violate later authorization checks.

## 2026-03-15 11:12 - Step 021 - Implement workspace OpenWork config read and write

- Treating a missing `.opencode/openwork.json` as a generated default with `authorizedRoots: [workspacePath]` preserves the current desktop behavior and keeps later authorization mutations simple.
- Returning the same `ExecResult` shape for writes makes the workspace service easier to extend: config, archive, and authorized-root mutations can all reuse one success/error contract instead of inventing special cases.

## 2026-03-15 11:10 - Step 020 - Implement remote workspace flows

- Remote workspace identity is cleaner when it keys off the actual remote tuple (`baseUrl` + `directory`, or `openworkHostUrl` + `workspaceId`) instead of the display path field; that keeps OpenWork-hosted and plain OpenCode remotes stable even when friendly labels change.
- Mirroring the current Rust semantics means remote-update IPC should be conservative: treat omitted or `null` fields as "no change" for most optional values, and only overwrite fields when the renderer supplies a real non-empty string.

## 2026-03-15 11:08 - Step 019 - Implement local workspace flows

- Normalized-path dedupe is an effective migration guardrail for local workspaces: it avoids hard-coding Rust's old workspace ID hash behavior while still preventing duplicate records when the same folder is re-added under Electron.
- The starter-workspace bootstrap is really two concerns: registry persistence plus workspace seeding. Keeping file seeding in a dedicated `workspace-files.ts` module makes later remote/config/archive steps easier to extend without bloating the registry service itself.

## 2026-03-15 11:03 - Step 018 - Implement workspace registry persistence

- Keeping the persisted filename as `openwork-workspaces.json` under Electron `userData` gives the new registry store an easier migration path from the Rust shell without forcing a one-off import format change.
- A normalization layer at load/save time is worth having early: later workspace mutations can stay focused on business logic while malformed or older on-disk state gets upgraded into a stable `WorkspaceState` shape first.

## 2026-03-15 11:01 - Step 017 - Implement updater download and install event flow

- The renderer no longer needs updater plugin objects if the Electron service owns pending-update state (`checkedAt`, `version`, `notes`) and emits typed `updateStatus` events for `checking`, `available`, `downloading`, `ready`, and `error`.
- `electron-updater` is easiest to integrate incrementally when `check()` drives the availability state, while library events (`download-progress`, `update-downloaded`, `error`) drive the long-running download/install lifecycle through the shared event bus.

## 2026-03-15 10:59 - Step 016 - Implement updater environment and check service

- An Electron updater service can stay renderer-compatible even before packaging is finished: return a structured `available: false` result when the environment says updates are unsupported, and reserve thrown errors for genuine check failures in supported packaged builds.
- `electron-updater` can be integrated at the service layer now, but actual runtime validation is still coupled to the pending Electron postinstall approval; packaged update checks will stay theoretical in this environment until the Electron binary download is allowed.

## 2026-03-15 10:57 - Step 015 - Implement deep-link registration and pending queue

- Deep-link ownership needs a pre-ready phase in Electron: `requestSingleInstanceLock()`, `second-instance`, and macOS `open-url` listeners should be initialized before `app.whenReady()` so startup links are not lost.
- Once the main context owns an event bus, a single renderer-sink bridge in `main.ts` can fan out all typed main-process events to the current BrowserWindow; namespace services then only need to emit typed payloads instead of touching `webContents.send()` directly.

## 2026-03-15 10:52 - Step 014 - Implement path helper service

- For file-system helpers, validating for null bytes without trimming is safer than normalizing aggressively: legitimate path segments can contain leading or trailing spaces, and the renderer already decides when user-input cleanup is appropriate.
- Returning `""` for an empty join segment list avoids Electron/Node's `path.join()` default of `"."`, which would be surprising if a caller expects "no path" rather than the current directory sentinel.

## 2026-03-15 10:51 - Step 013 - Implement shell opener and reveal service

- Electron's shell APIs split cleanly into URL and path flows, so keeping `openExternal` behind protocol validation and `openPath`/`showItemInFolder` behind absolute-path validation preserves the least-privilege boundary without complicating the renderer API.
- `shell.openPath()` reports failures as a returned error string instead of throwing, so the service layer should normalize that into an exception before the IPC boundary.

## 2026-03-15 10:49 - Step 012 - Implement dialogs service

- Electron's dialog helpers work well for parity if the service normalizes `filePaths` back to the current wrapper shape (`string | string[] | null`) and validates `defaultPath` centrally before opening anything.
- `dialog.showOpenDialog()` wants strongly typed `properties` arrays, so building them as explicit unions (instead of generic `string[]`) avoids unnecessary TypeScript friction in later dialog-like services.

## 2026-03-15 10:47 - Step 011 - Implement window zoom and decorations service

- Electron gives a straightforward `webContents.getZoomFactor()` / `setZoomFactor()` path, but frame decorations are effectively constructor-time state; a practical parity strategy is to recreate the main window with the new `frame` value while preserving bounds and current URL.
- Keeping decoration state inside the main-window bootstrap module avoids leaking Electron window details into the preload or renderer contract; the IPC-facing `window-service.ts` can stay small and delegate replacement mechanics to `window/main-window.ts`.

## 2026-03-15 10:44 - Step 010 - Implement app metadata and relaunch service

- The first real Electron service establishes a useful migration pattern: keep the privileged logic in `services/<name>-service.ts`, export a `register<Name>Ipc()` helper for `ipcMain.handle`, and replace only that namespace in `preload.ts` while the rest stay stubbed.
- The old Tauri dev-config nuke flow deletes `userData/opencode-dev` plus orchestrator state under `OPENWORK_DATA_DIR` or `~/.openwork/openwork-orchestrator`; later service shutdown hooks can plug into the `beforeExit` callback without changing the renderer contract.

## 2026-03-15 10:42 - Step 009 - Bootstrap BrowserWindow creation

- Keeping BrowserWindow creation in `packages/desktop/src/main/window/main-window.ts` makes the Electron shell easier to grow: the main entrypoint can stay lifecycle-focused while window defaults, preload resolution, and renderer target rules live together.
- A small `resolveSiblingPath(tsRelative, jsRelative)` helper is enough for the source-phase scaffold to point at `.ts` files during development scaffolding and `.js` files after future build output exists.

## 2026-03-15 10:40 - Step 008 - Scaffold Electron preload entrypoint

- A typed stub preload bridge is a safe intermediate state: `contextBridge.exposeInMainWorld("openworkDesktop", createOpenworkDesktopBridge())` lets renderer/runtime detection switch over early while each namespace can be implemented incrementally in later steps.
- For broad stubbed method factories in TypeScript, the generic function cast needs to go through `unknown` first (`as unknown as T`) to satisfy `strict` mode.

## 2026-03-15 10:38 - Step 007 - Scaffold Electron main entrypoint

- `packages/desktop/tsconfig.json` plus `pnpm --filter @different-ai/openwork typecheck:electron` gives the desktop package its own TypeScript verification path, so later Electron-main steps no longer need to piggyback on another workspace package's compiler setup.
- `pnpm install` added `electron@35.7.5`, but pnpm's build-script approval flow skipped Electron's postinstall download in this environment; actual Electron runtime execution may require approving that build later with `pnpm approve-builds`.

## 2026-03-15 10:35 - Step 006 - Create Electron event bus substrate

- The early Electron event bus can stay decoupled from `BrowserWindow` by exposing typed event subscriptions plus separately registered renderer sinks; later main bootstrap can wire `webContents.send` in as just another sink.
- `IPC_EVENT_CHANNELS` is a good single source for both event-bus envelopes and future preload subscription wiring, which avoids drifting channel strings between main and renderer edges.

## 2026-03-15 10:34 - Step 005 - Create IPC naming and validation helpers

- `packages/desktop/src/main/ipc/` can become the shared main/preload seam early: keep channel builders in `channels.ts`, privileged argument guards in `validation.ts`, and re-export them through `index.ts` for later service bootstrap steps.
- Until `packages/desktop` gets its own TypeScript setup, the new desktop `.ts` helpers can be sanity-checked with `pnpm --filter openwork-orchestrator exec tsc ...` because that package already carries `typescript` and `@types/node`.

## 2026-03-15 10:30 - Step 004 - Add preload global type declarations

- `packages/app/src/app/lib/openwork-desktop.ts` can hold both the importable preload contract types and the global `Window` augmentation, so renderer code gets one shared desktop typing seam before the preload implementation exists.
- In this UI package, `DesktopRuntimeInfo` should use `NodeJS.Platform` and `NodeJS.Architecture`; `node:process` does not export named `Platform` or `Architecture` types for direct import here.

## 2026-03-15 10:27 - Step 003 - Define desktop runtime detection primitive

- `packages/app/src/app/utils/index.ts` can expose `isDesktopRuntime()` backed by `window.openworkDesktop` while keeping `isTauriRuntime()` as a temporary alias, which lets later cutover steps remove the old name without forcing a repo-wide runtime-branch rewrite immediately.

## 2026-03-15 10:25 - Step 002 - Extract shared desktop DTO module

- `packages/app/src/app/lib/desktop-contract.ts` can become the neutral typing seam while `packages/app/src/app/lib/tauri.ts` re-exports those types, which avoids a broad import churn during the early migration steps.
- The clean worktree needed `pnpm install --frozen-lockfile` before UI typecheck would run; after install, `pnpm --filter @different-ai/openwork-ui typecheck` succeeds.

## 2026-03-15 10:20 - Step 001 - Freeze canonical migration docs

- Treat the migration bundle as four linked artifacts: the program plan, the Electron contract, the execution queue, and the shared learnings log.
- When a later step changes migration scope or desktop contract semantics, update both canonical plan docs and keep the execution folder README pointing at them so subagents can find the right source of truth quickly.

No learnings recorded yet.
