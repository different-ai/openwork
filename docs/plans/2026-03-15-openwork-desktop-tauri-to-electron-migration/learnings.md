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
