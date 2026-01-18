# PRD - Refactor: Simplify State and Colocate View Models (OpenWork)

## Summary

This PRD proposes a structural refactor that moves state, data access, and actions closer to the views that consume them. The primary objective is to reduce the centralization of UI state in `src/App.tsx`, improve resilience, and make feature ownership explicit and testable, while preserving all existing behavior and user experience.

The desired end state is a thin `App` component that only wires top-level dependencies, routes between views, and renders global overlays. Each view owns its view-model and effects, and cross-cutting concerns live in small, dedicated modules.

## Goals

- Make `App.tsx` a thin orchestrator rather than a state container.
- Colocate view-specific state, effects, and actions with each view.
- Reduce global signal sprawl and repeated async handling patterns.
- Improve reliability and error handling consistency without over-optimizing.
- Ensure each feature area has a clear, testable API surface.
- Keep UI behavior identical (or strictly safer) during the refactor.

## Non-goals

- No product redesign or visual changes.
- No new backend capabilities or SDK changes.
- No migration away from SolidJS signals/stores.
- No major performance tuning beyond avoiding obvious regressions.
- No new persistent storage system or schema changes.

## Definitions

- View-model: A module co-located with a view that owns state, derived values, effects, and actions for that view.
- Slice: A small shared module that owns a cross-cutting domain (e.g. connection, updates, templates, preferences).
- Orchestrator: The top-level `App` component responsible for dependency injection and routing only.
- Preferences: Local, persisted user settings stored in `localStorage` or equivalent.

## Guiding Principles

- Colocate by default: If only a view needs it, it lives next to that view.
- Shared modules are small and explicit: only cross-view responsibilities live in `src/app/*`.
- Effects live with the data they depend on.
- Async operations are standardized through small helpers (not a framework).
- Keep actions stable and explicit; avoid implicit mutation.
- Prefer incremental, reversible refactors over large rewrites.

## Current State and Problems

### Current State

`src/App.tsx` is an orchestration layer that currently owns:

- View routing and global overlays.
- App-level data loading and persistence.
- Most feature-level state (templates, updates, session state, permissions, model selection).
- Many `createSignal` and `createMemo` pairs with manual `createEffect` persistence.
- Multiple unrelated async flows that each manage `busy`, `busyLabel`, `error`, and `busyStartedAt`.

### Problems

- High coupling: many views are fed by a large prop surface built in `App.tsx`.
- State sprawl: it is difficult to identify which state belongs to which feature.
- Duplicated async handling patterns increase the chance of drift and bugs.
- Local storage effects are scattered, making hydration and persistence fragile.
- Adding new features typically requires touching `App.tsx`, which increases merge risk.
- Testing and reasonability suffer due to a large number of implicit dependencies.

## Proposal

### Overview

Refactor the UI architecture to establish a clean, layered structure:

1. `App.tsx` becomes a thin orchestrator.
2. Each view gets a view-model module that owns state, actions, effects, and selectors.
3. Cross-cutting concerns move into small slices under `src/app/`.
4. Modals own their local state in co-located modules.
5. Local storage persistence is centralized into a preferences module.

### Target Directory Structure

```
vendor/openwork/src/
  app/
    connection.ts
    updates.ts
    templates.ts
    preferences.ts
    session-snapshot.ts
    view-router.ts
  components/
    ModelPickerModal/
      ModelPickerModal.tsx
      state.ts
    TemplateModal/
      TemplateModal.tsx
      state.ts
    ResetModal/
      ResetModal.tsx
      state.ts
  views/
    OnboardingView/
      OnboardingView.tsx
      model.ts
      types.ts
    DashboardView/
      DashboardView.tsx
      model.ts
      selectors.ts
    SessionView/
      SessionView.tsx
      model.ts
      effects.ts
      selectors.ts
```

Notes:

- This layout is illustrative, not mandatory. The key requirement is colocation and ownership clarity.
- View folders can be introduced incrementally using existing filenames.

### Dependency Injection

`App.tsx` will construct shared dependencies and pass them to view-model factories. For example:

- `createConnectionSlice()` provides `client`, connection status, and provider data.
- `createSessionStore()` remains, but its usage is mediated by a `SessionView` model.
- `createWorkspaceStore()` remains, but onboarding and dashboard models read and act through a small interface.

### View-Model API Pattern

Each view model returns a minimal, typed interface consumed directly by the view.

Example interface shape:

```
export type SessionViewModel = {
  state: {
    selectedSessionId: Accessor<string | null>
    messages: Accessor<Message[]>
    busy: Accessor<boolean>
    busyLabel: Accessor<string | null>
    error: Accessor<string | null>
  }
  actions: {
    sendPrompt: () => Promise<void>
    createSession: () => Promise<void>
    selectSession: (id: string) => Promise<void>
  }
  selectors: {
    artifacts: Accessor<Artifact[]>
    workingFiles: Accessor<WorkingFile[]>
  }
}
```

### Preferences Module

Create a dedicated `preferences.ts` module that:

- Defines a schema for local preferences.
- Hydrates once during startup.
- Handles persistence in one place (single `createEffect` per key).
- Exposes signals such as `defaultModel`, `modelVariant`, `showThinking`, and update preferences.

This centralizes storage logic and removes scattered `localStorage` effects in `App.tsx`.

### Async Handling Standardization

Add a small helper, such as `createAsyncState()` or `withAsyncStatus()`, that returns:

- `busy` boolean
- `busyLabel` string or null
- `busyStartedAt` timestamp
- `run(action, label)` wrapper that handles try/catch/finally

This avoids repeating the same busy/error management logic across flows and helps ensure consistent error handling.

### Modal State Colocation

Each modal owns its local state with a co-located `state.ts` file, exporting a small interface for the view to render. `App.tsx` should render the modal and pass a single state object, not a dozen signals.

### Cross-Cutting Slices

Slices are only for state shared by multiple views or global overlays. Candidates:

- `connection.ts`: client lifecycle, provider lists, connection status.
- `updates.ts`: update check state and actions.
- `templates.ts`: template storage and load utilities.
- `preferences.ts`: local settings and persistence.

View models should not reach into slices directly unless needed; most should receive a stable interface via dependencies.

## UX and Flow Implications

This refactor is intentionally UI-neutral. However, the following flows must be preserved exactly:

- Onboarding flow (mode selection, host/client setup, engine doctor in host mode).
- Session flow (prompt submission, model overrides, permissions handling).
- Dashboard flow (templates, plugins, skills, workspaces, updates).
- Reset flow (clear state and relaunch).

All existing UI and behavior remain identical unless a change is required for reliability.

## Data and Storage

### In-Memory State

- View-local state lives in view-models.
- Shared state lives in slices.
- Derived values live in memoized selectors.

### Persistent State

- Preferences are stored in `localStorage` via `preferences.ts`.
- Workspace template persistence remains unchanged (Tauri and file APIs).
- No schema migrations are required in this refactor.

### Data Boundaries

- Views do not access `client` directly. They use view-model actions.
- View-models do not directly mutate global state; they use slice actions or explicit setters.
- Effects remain local to the module that owns their state.

## Reliability and Resilience

### Error Handling

- All async actions go through a standardized wrapper.
- Errors are surfaced via a consistent `error` signal owned by the relevant model.
- Critical errors should be bubbled to global UI when needed via a shared error channel.

### Busy State

- `busy`, `busyLabel`, and `busyStartedAt` are derived from a shared async wrapper per domain.
- View-level busy signals should not override global busy unless explicitly scoped.

### Cleanup and Cancellation

- Any long-lived subscriptions or timeouts must be owned by the model that created them.
- `onCleanup` must live alongside `createEffect` in view-model modules.

### SSE and Connection Recovery

- Connection slices should own reconnection attempts and expose a stable status to views.
- Views should react to status changes but not implement reconnection logic.

## Performance Considerations

- Avoid new caching layers or premature memoization.
- Prefer `createMemo` where it clearly reduces repeated computation.
- Keep computed selectors in view-models to avoid re-deriving in views.
- Avoid large prop objects in `App.tsx` by passing model objects instead.

## Implementation Plan

### Phase 0 - Inventory and Map

- Identify all state in `App.tsx` and label ownership: onboarding, dashboard, session, updates, templates, preferences, modals, connection.
- Create a dependency map for each view and list the API it requires.

### Phase 1 - Preferences Module

- Add `src/app/preferences.ts` with a defined schema.
- Move local storage hydration and persistence into this module.
- Update `App.tsx` to call a single `hydrate()` on mount.

### Phase 2 - Modal State Colocation

- For each modal: move state to `components/<Modal>/state.ts`.
- Replace multiple prop wires with a single `state` object where possible.

### Phase 3 - Session View-Model

- Move prompt send flow, model overrides, artifact derivation, and permission handling into `views/SessionView/model.ts`.
- Ensure the Session view only depends on the model interface.

### Phase 4 - Dashboard and Onboarding View-Models

- Extract `onboardingProps` and `dashboardProps` into models.
- Move view-specific effects (engine doctor refresh, reload banner copy) into models.

### Phase 5 - App Orchestrator

- Reduce `App.tsx` to routing, global overlays, and dependency injection.
- Validate all navigation states and idle states.

### Phase 6 - Stability Pass

- Run through existing flows to verify no regressions.
- Trim unused state and confirm no dangling effects.

## Migration and Compatibility

- This refactor is entirely internal to the UI architecture.
- No changes to serialized data or external APIs.
- Existing session state behavior is preserved.

## Acceptance Criteria

- `src/App.tsx` is primarily orchestration; no view-specific state lives there.
- Each view owns a view-model module that exposes a stable interface.
- Preferences are hydrated and persisted in one module only.
- No functional regressions in onboarding, dashboard, or session flows.
- Async error handling is consistent across all critical actions.
- New features can be added without modifying `App.tsx` directly.

## Success Metrics

- `App.tsx` size reduced by at least 50 percent.
- 80 percent of view data/actions originate from view models.
- No increase in user-facing errors in existing flows.
- No measurable performance regression in session rendering.

## Risks

- Refactor churn could introduce subtle regressions in flows with many side effects.
- Incomplete dependency mapping could lead to duplicated or dangling state.
- Overzealous abstraction could reduce clarity if over-engineered.

## Mitigations

- Incremental refactor by view and by feature slice.
- Preserve existing function names and logic where possible.
- Add lightweight tests or manual checklists for each phase.

## Alternatives Considered

- Keep all state centralized but reorganize into sections in `App.tsx`.
  - Rejected: still high coupling and poor testability.
- Introduce a global store library.
  - Rejected: would be a larger architectural shift than needed.

## QA and Validation

- Manual test of onboarding and engine doctor flows.
- Manual test of template creation, deletion, and run flow.
- Manual test of session prompt flow, permission prompts, and step rendering.
- Manual test of updates flow (check, download, install).

## Rollout Strategy

- Land in small, reviewable commits per phase.
- Avoid mixing architectural changes with UI changes.
- Keep a temporary feature flag only if needed for safety (optional).

## Open Questions

- Should any shared slice be converted to a Solid store for better grouping?
- Do we want a single `createAsyncState()` utility or a domain-specific variant per slice?
- Should view-models live in new folders or keep the current flat view structure?
- How strict should we be about view-model interfaces (narrow vs full access)?

## Appendix - Proposed Interfaces

### View-Model Factory Signature

```
export type ViewModelDeps = {
  connection: ConnectionSlice
  sessions: SessionStore
  workspace: WorkspaceStore
  templates: TemplateSlice
  preferences: Preferences
}

export function createSessionViewModel(deps: ViewModelDeps): SessionViewModel
```

### Example App Orchestrator Sketch

```
const connection = createConnectionSlice()
const preferences = createPreferences()
const templates = createTemplatesSlice({ client: connection.client })

const sessionModel = createSessionViewModel({
  connection,
  sessions: sessionStore,
  workspace: workspaceStore,
  templates,
  preferences,
})
```
