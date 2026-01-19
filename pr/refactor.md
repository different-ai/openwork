# PRD - Refactor App.tsx (50 percent size reduction)

## Summary

Create a low-risk refactor plan that cuts `src/App.tsx` from ~2000 lines to ~1000 lines by extracting cohesive state modules and view-prop builders. The work is purely structural and must preserve all behavior. Every extraction step has explicit checks so a simple agent can execute it safely.

## Goals

- Reduce `src/App.tsx` line count by about 50 percent without changing runtime behavior.
- Keep all signals scoped to the App reactive root by using factory functions.
- Ensure each extraction step is reversible and validated by a consistent test gate.
- Produce a repeatable plan that any agent can follow with minimal judgment calls.

## Non-Goals

- No UI changes or copy changes.
- No data model or storage changes.
- No SDK or API updates.
- No new abstractions that change how state is consumed.

## Definitions

- Extraction: Moving related state and helpers into a new module while keeping logic the same.
- Factory module: A `createXState(...)` or `buildXProps(...)` function called inside App to keep signals scoped.
- Test gate: A single command that must pass after each extraction step.

## Guiding Principles

- Small, reversible moves over large rewrites.
- Preserve function names and signal behavior.
- Avoid new shared global state.
- Keep all props to views identical.

## Current State

- `src/App.tsx` contains routing, state, effects, preference storage, template logic, update flow, and view prop builders.
- There is no single place to see what belongs to which feature.
- Refactors are risky because many flows are coupled in one file.

## Proposal

- Create small modules under `src/app/` that own one domain each.
- Keep App.tsx as wiring only: create signals, instantiate factories, render views and modals.
- Use one test gate after every change and a heavier check every few steps.

## Required Test Gate

Add a single script so every step runs the same command.

- `package.json` script:
  - `"test:refactor": "pnpm typecheck && pnpm test:health && pnpm test:sessions"`

## Implementation Plan (step-by-step)

Each step ends with the same two actions:

1) Run `pnpm -C vendor/openwork test:refactor`
2) If it fails, stop and fix or revert the last step.

### Step 0 - Baseline and guardrails

- Action:
  - Record baseline line count: `wc -l src/App.tsx`.
  - Add `test:refactor` script.
- Pay attention:
  - Do not change any runtime logic while adding the script.
- Check:
  - Run `pnpm -C vendor/openwork test:refactor`.

### Step 1 - Demo mode state

- Move to: `src/app/demo-state.ts`.
- Move these items:
  - `demoMode`, `demoSequence`, `setDemoSequenceState`.
  - Demo signals: sessions, statuses, messages, todos, artifacts, working files, authorized dirs, active workspace display.
  - `isDemoMode` memo and all `active*` memos.
  - `selectDemoSession` helper.
- Inputs required:
  - `deriveArtifacts`, `deriveWorkingFiles`, and types `MessageWithParts`, `TodoItem`, `WorkspaceDisplay`.
  - Live session data accessors for real mode.
- Pay attention:
  - Ensure demo state is reset when sequence changes.
  - All `active*` memos must still switch between demo and real state.
- Check:
  - Run `pnpm -C vendor/openwork test:refactor`.

### Step 2 - Template management

- Move to: `src/app/template-state.ts`.
- Move these items:
  - Template lists and load flags.
  - Template modal state and draft signals.
  - `openTemplateModal`, `saveTemplate`, `deleteTemplate`, `runTemplate`.
  - `loadWorkspaceTemplates` and `workspaceTemplates` / `globalTemplates` memos.
- Inputs required:
  - `client`, `workspaceStore.activeWorkspaceRoot`, `loadSessions`, `selectSession`.
  - `defaultModel`, `modelVariant`, `setBusy`, `setBusyLabel`, `setBusyStartedAt`, `setError`.
  - Tauri commands: `workspaceTemplateWrite`, `workspaceTemplateDelete`.
- Pay attention:
  - Preserve busy label values and error messages.
  - `loadWorkspaceTemplates` is used by `createWorkspaceStore` and must keep its signature.
- Check:
  - Run `pnpm -C vendor/openwork test:refactor`.

### Step 3 - Update, reload, reset, cache repair

- Move to: `src/app/system-state.ts`.
- Move these items:
  - Reload state, `reloadCopy`, `canReloadEngine`, `reloadEngineInstance`.
  - Cache repair state and `repairOpencodeCache`.
  - Update flow: check, download, install, auto-check state.
  - Reset modal state and `confirmReset` flow.
- Inputs required:
  - `client`, `mode`, `anyActiveRuns`, `refreshPlugins`, `refreshSkills`.
  - Provider setters, `setError`, `safeStringify`.
  - Tauri commands: `resetOpenworkState`, `resetOpencodeCache`, `updaterEnvironment`.
- Pay attention:
  - Reload gating must still block during active runs and non-host mode.
  - Reset must still clear local storage before relaunch/reload.
- Check:
  - Run `pnpm -C vendor/openwork test:refactor`.

### Step 4 - Provider and model selection

- Move to: `src/app/model-state.ts`.
- Move these items:
  - Provider signals, default model, picker state.
  - `modelOptions`, `filteredModelOptions`, and picker helpers.
- Inputs required:
  - `DEFAULT_MODEL`, `formatModelLabel`, `formatModelRef`.
  - `sessionModelOverrideById`, `selectedSessionId`, `setSessionModelOverrideById`.
- Pay attention:
  - Keep sorting logic identical (connected and free first).
  - Preserve default model fallback behavior when no providers are loaded.
- Check:
  - Run `pnpm -C vendor/openwork test:refactor`.

### Step 5 - Preferences and local storage

- Move to: `src/app/preferences.ts`.
- Move these items:
  - `onMount` preference hydration.
  - All `createEffect` localStorage writes.
- Inputs required:
  - Preference signals and setters (baseUrl, clientDirectory, engineSource, demo settings, model settings, update auto-check).
  - Helpers and constants: `readModePreference`, `writeModePreference`, `parseModelRef`, `formatModelRef`, preference keys.
- Pay attention:
  - Keep legacy keys for compatibility (e.g. `openwork_mode_pref`, `openwork.projectDir`).
  - Do not change any localStorage key names or value formats.
- Check:
  - Run `pnpm -C vendor/openwork test:refactor`.

### Step 6 - View prop builders

- Move to: `src/app/view-props.ts`.
- Move these items:
  - `headerStatus`, `busyHint`, `localHostLabel` memos.
  - `onboardingProps`, `dashboardProps` builders.
- Inputs required:
  - Pass a single dependency object into `buildOnboardingProps` and `buildDashboardProps` to reduce imports.
- Pay attention:
  - Every prop name must match the current view usage.
  - Do not remove any callbacks or rename handlers.
- Check:
  - Run `pnpm -C vendor/openwork test:refactor`.

### Step 7 - App.tsx cleanup

- Remove unused imports and reorder remaining imports.
- App.tsx should only create signals, wire factories, and render views/modals.
- Check:
  - Run `pnpm -C vendor/openwork test:refactor`.
  - Run `pnpm -C vendor/openwork test:e2e`.

## Attention Checklist (every step)

- Do not change view prop names or shapes.
- Keep all async flows, busy labels, and error messages identical.
- Keep all signals and memos created inside the App reactive scope.
- Avoid circular imports between new modules.
- If a move changes import order, re-run the test gate immediately.

## Regression Checks (every step)

- `pnpm -C vendor/openwork test:refactor`
- Manual smoke (optional): `pnpm -C vendor/openwork dev:web` and verify onboarding and dashboard render.

## Acceptance Criteria

- `src/App.tsx` <= 1100 lines.
- All test gates pass after each step.
- Final `pnpm -C vendor/openwork test:e2e` passes.
- No UI or behavior changes.

## Open Questions

- Should `test:refactor` include `pnpm build:web` for extra safety?
- Should the plan enforce a maximum module size to avoid new files getting too large?
