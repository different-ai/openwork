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
