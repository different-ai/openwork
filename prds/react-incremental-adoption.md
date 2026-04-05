# PRD: Incremental React Adoption with Isolated Testing

## Status: Draft
## Date: 2026-04-05

## Problem

The OpenWork app is 100% SolidJS. The session UI has resilience issues (white screens, flicker, route/runtime/selection mismatches) rooted in overlapping owners of truth. The plan is to incrementally adopt React for the session experience layer, then expand to replace the entire app while keeping the existing app running at every step. Each phase must be testable in isolation against a real dev stack before merging.

## Current Architecture

### Frontend
- Framework: SolidJS only in `apps/app/`
- Monolith: `app.tsx` is the app orchestrator and threads session state deeply
- Session view: `pages/session.tsx`
- State: Solid signals + stores
- Router: `@solidjs/router`
- Prepared seam: `@openwork/ui` already exports both React and Solid component builds
- Platform: Tauri 2.x for desktop/mobile, browser APIs for web

### Backend
- Server: `Bun.serve()` with a hand-rolled router
- Session data: OpenCode-owned, historically read through OpenCode proxy routes
- New read path: workspace-scoped session read APIs now exist on OpenWork server
- Activation: cheap on server, but client/runtime choreography can still be slow or inconsistent

### Styling
- Tailwind CSS v4 + `@tailwindcss/vite`
- CSS variables and DLS tokens drive color/system styling
- Dark mode uses `data-theme` and variable swaps, not `dark:`
- No CSS-in-JS

## Three-Stage Transition

### Stage 1: React Island

React lives inside the Solid app as a guest.

```text
Tauri/Web shell
  -> Solid app
       -> ReactIsland
            -> React session surface
```

Solid still owns routing, shell, and platform wiring. React owns only the migrated session surface.

### Stage 2: React Expands

React takes over more app surfaces one domain at a time until it owns enough that the shell can invert.

```text
Tauri/Web shell
  -> React app
       -> React sidebar
       -> React session view
       -> SolidIsland for remaining Solid surfaces
```

### Stage 3: React Owns Everything

```text
Tauri shell
  -> React app
       -> react/shell/
       -> react/session/
       -> react/workspace/
       -> react/connections/
       -> react/app-settings/
       -> react/cloud/
       -> react/kernel/
```

At that point `solid-js` and `vite-plugin-solid` can be removed.

## State Ownership Rule

At any moment, each state concern has exactly one owner.

- Session messages: React once migrated
- Session transition state: React once migrated
- Workspace list/sidebar: Solid until that domain moves
- Routing: Solid until shell inversion
- Platform/Tauri IPC: framework-agnostic adapter surface, eventually React-consumed directly

Never let Solid and React co-own the same concern.

## Bridge Contract

The Solid-to-React island contract should start minimal and shrink over time.

```ts
interface IslandProps {
  workspaceUrl: string
  workspaceToken: string
  workspaceId: string
  sessionId: string | null
  onNavigate?: (path: string) => void
}
```

As React takes over more shell state, this contract shrinks toward zero.

## File Structure

Use the same domain ownership logic as the Solid app, but with component-enclosed state.

```text
apps/app/src/react/
  feature-flag.ts
  island.tsx
  shell/
  session/
  workspace/
  connections/
  cloud/
  app-settings/
  automations/
  kernel/
```

Within `session/`, shared session truth lives at the boundary and component-local state lives with the component that renders it.

Example shape:

```text
session/
  transition-controller.ts
  session-store.ts
  session-snapshot-query.ts
  session-view.tsx
  composer/
  message-list/
  session-sidebar/
```

## Styling Strategy

The styling system is already framework-agnostic.

- Tailwind classes carry over unchanged
- CSS variables and DLS tokens carry over unchanged
- `ow-*` classes remain usable from React
- Dark mode behavior carries over unchanged

The only syntax change is `class` -> `className`.

React-specific helper:

```ts
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

React surfaces should visually match the Solid surfaces they replace until intentional redesign happens.

## Isolation Strategy

Each phase should be testable in isolation.

### Runtime isolation
- Keep the Solid path as default until the React slice is proven
- Enable React with a flag such as:

```text
localStorage.setItem('openwork:react-session', 'true')
```

### Stack isolation
- Validate against independent OpenWork stacks/workspaces when needed
- Prefer browser verification plus host-run typecheck/build for fast iteration

### Verification artifacts
- Update `test-actions.md`
- Capture screenshots when validating UI behavior
- Keep transition/debug visibility first-class

## Phase Roadmap

### Phase 0: Build Infrastructure
- Add React runtime support to the app build
- Add feature flag support
- Add island mount support

### Phase 1: React Session View (Read-Only)
- React transcript surface
- Read-only rendering from session snapshot data

### Phase 2: React Session Composer
- React-owned draft/send/stop flow
- Poll or stream session updates through the new read boundary

### Phase 3: Transition Controller + Debug Panel
- Explicit transition model
- Render source visibility
- Debug surface for humans and agents

### Phase 4: Backend Read APIs
- `GET /workspace/:id/sessions`
- `GET /workspace/:id/sessions/:sessionId`
- `GET /workspace/:id/sessions/:sessionId/messages`
- `GET /workspace/:id/sessions/:sessionId/snapshot`

### Phase 5: React Session Default
- Flip the session surface to React by default
- Keep a temporary escape hatch back to Solid if needed

### Phase 6+: Domain-by-Domain Migration
- Workspace sidebar
- Settings
- Connections
- Cloud
- Shell inversion
- Solid removal

## Current Branch Progress

This repo branch currently includes:

- Phase 4 backend workspace-scoped session read APIs
- Current frontend hook-up to use those read APIs for mounted OpenWork session reads
- Phase 1 React read-only session transcript
- Phase 2 React session composer surface
- Phase 3 React transition model and debug panel

## Success Criteria

- No blank session pane during React-driven session switches
- Clear rendered vs intended session ownership
- Workspace-scoped reads that do not depend on activation choreography
- Incremental replacement path that preserves inspectability and allows rollback per slice
