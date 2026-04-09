# PRD: Incremental React Adoption with Isolated Testing

## Status: Draft
## Date: 2026-04-05

## Problem

The OpenWork app is 100% SolidJS. The session UI has resilience issues (white screens, flicker, route/runtime/selection mismatches) rooted in overlapping owners of truth. The plan is to incrementally adopt React for the session experience layer, then expand to replace the entire app — while keeping the existing app running at every step. Each phase must be testable in isolation against a real Docker dev stack before merging.

## Current Architecture (Ground Truth)

### Frontend
- **Framework**: SolidJS only. Zero React in `apps/app/`.
- **Monolith**: `app.tsx` (~2,500 lines) creates ~15 stores, threads ~90 props to `SessionView`.
- **Session view**: `pages/session.tsx` (~2,000 lines) — SolidJS, receives all state as props via `SessionViewProps`.
- **State**: SolidJS signals + `createStore()`. No external state libs.
- **Router**: `@solidjs/router`, imperative navigation.
- **Prepared seam**: `@openwork/ui` already exports both React and Solid components. `SessionViewProps` is a clean data-only interface.
- **Build**: Vite + `vite-plugin-solid`. No React plugin configured.
- **Platform**: Tauri 2.x for desktop/mobile. Web mode uses standard browser APIs. Platform abstraction lives in `context/platform.tsx`.

### Backend
- **Server**: `Bun.serve()`, hand-rolled router. No framework.
- **Session data**: Lives in OpenCode's SQLite DB. Client reads via OpenCode SDK or proxied through `/w/:id/opencode/*`.
- **No server-side session read endpoints**: The OpenWork server has no `GET /sessions` or `GET /session/:id`. It proxies to OpenCode.
- **Activation**: Nearly free (array reorder). The expensive part is client-side workspace bootstrapping.
- **Orchestrator**: Process supervisor that spawns server + OpenCode + router.

### Styling
- **CSS framework**: Tailwind CSS v4.1.18 via `@tailwindcss/vite`.
- **Color system**: Radix UI Colors (30+ scales, 12 steps each) + DLS semantic tokens — all CSS custom properties (~700+).
- **Dark mode**: `data-theme` attribute on `<html>` + CSS variable swap. NOT Tailwind `dark:` prefix.
- **Component styling**: Inline Tailwind `class=` strings with template literal conditionals. No `cn()`, `clsx`, or `tailwind-merge`.
- **Custom CSS classes**: `ow-*` prefixed classes in global `index.css` (buttons, cards, pills, inputs).
- **CSS-in-JS**: None.
- **Animation**: CSS-only (Tailwind transitions + custom `@keyframes`). No framer-motion or JS animation libs.
- **Fonts**: System font stack (IBM Plex Sans preferred, no bundled fonts).
- **Design language**: `DESIGN-LANGUAGE.md` (871 lines) — quiet, premium, flat-first. Shadow is last resort.
- **Key files**: `tailwind.config.ts`, `src/app/index.css`, `src/styles/colors.css`, `DESIGN-LANGUAGE.md`.

### Existing domain map (CUPID)
The app follows CUPID domain organization:
- `shell` — routing, layout, boot, global chrome
- `session` — task/session experience, composer, messages
- `workspace` — workspace lifecycle, switching, connect
- `connections` — providers, MCP
- `automations` — scheduled jobs
- `cloud` — hosted workers, den
- `app-settings` — preferences, themes
- `kernel` — tiny shared primitives

---

## Three-Stage Transition: Solid → Hybrid → React

### Stage 1: React Island (Phases 0-3)

React lives inside the Solid app as a guest. Solid owns the shell, routing, and platform layer. React renders into a div that Solid manages.

```
Tauri/Web shell
  └── Solid app (owns everything)
        ├── Solid sidebar
        ├── Solid settings
        └── ReactIsland (a div)
              └── React session view (our new code)
```

State bridge: minimal. React gets workspace URL + token + session ID from Solid via island props. React fetches its own data. Two independent state worlds.

### Stage 2: React Expands, Island Inverts (Phases 5-8)

React takes over more surfaces. Each Solid surface migrates to its React counterpart, one domain at a time. At a tipping point (after workspace sidebar moves to React), the island inverts:

```
Tauri/Web shell
  └── React app (owns the shell now)
        ├── React sidebar
        ├── React session view
        ├── React settings (partial)
        └── SolidIsland (a div)  ← for remaining Solid surfaces
              └── remaining Solid components
```

### Stage 3: React Owns Everything (Phase 9+)

```
Tauri shell (just the native window + IPC)
  └── React app
        ├── react/shell/
        ├── react/session/
        ├── react/workspace/
        ├── react/connections/
        ├── react/app-settings/
        ├── react/cloud/
        └── react/kernel/
```

At this point `vite-plugin-solid` and `solid-js` are removed. The app is a standard React SPA that happens to run inside Tauri for desktop. The web build is the same React app without the Tauri wrapper.

---

## State Ownership Rule

**At any point in time, each piece of state has exactly one framework owning it.**

When you migrate a surface from Solid to React, you delete the Solid version of that state. You never have both frameworks managing the same concern.

| Concern | Stage 1 (React island) | Stage 2 (React expanding) | Stage 3 (React owns all) |
|---------|----------------------|--------------------------|-------------------------|
| Session messages | React (react-query) | React | React |
| Session transition | React (transition-controller) | React | React |
| Workspace list | Solid | React (after migration) | React |
| Workspace switching | Solid → passes result to React via island props | React | React |
| Routing | Solid router | Hybrid: Solid routes to React islands | React router |
| Platform (Tauri IPC) | Solid platform provider | Framework-agnostic adapter module | React calls adapter directly |
| Settings/config | Solid | Migrated domain by domain | React |

---

## Bridge Contract (Shrinks Over Time)

The island props are the formal contract between Solid and React. It starts small and shrinks to zero:

```ts
// Stage 1 — React island gets minimal props from Solid
interface IslandProps {
  workspaceUrl: string
  workspaceToken: string
  workspaceId: string
  sessionId: string | null
  onNavigate: (path: string) => void  // React tells Solid to route
}

// Stage 2 — React takes over sidebar, fewer props needed
interface IslandProps {
  workspaces: WorkspaceConnection[]    // React now owns selection
  onNavigate: (path: string) => void
}

// Stage 3 — no island, no props. React owns everything.
// island.tsx deleted, solid-js removed.
```

Each time a surface migrates, the island props shrink. When they hit zero, the island is removed.

---

## File Structure (CUPID Domains, Component-Enclosed State)

Mirrors the existing CUPID domain map. Each domain colocates state, data, and UI. Components own the state they render — "general" session state sits at the session boundary, local UI state lives inside the component that needs it.

```
apps/app/src/react/
├── README.md                              # Why this exists, how to enable, migration status
│
├── island.tsx                             # Solid→React bridge (mounts boot.tsx into a DOM node)
├── boot.tsx                               # React root, providers, top-level wiring
├── feature-flag.ts                        # Read/write opt-in flag
│
├── kernel/                                # Smallest shared layer (CUPID kernel rules apply)
│   ├── opencode-client.ts                 # Plain fetch() for OpenCode proxy — no Solid dependency
│   ├── types.ts                           # Session, Message, Workspace shapes
│   ├── query-provider.tsx                 # react-query provider + defaults
│   └── dev-panel.tsx                      # Dev-only: renderSource, transition, timings
│
├── shell/                                 # App-wide composition only (thin)
│   ├── layout.tsx                         # Sidebar + main area composition
│   ├── router.tsx                         # Route → domain view dispatch
│   └── index.ts
│
├── session/                               # Domain: active task/session experience
│   │
│   │  -- General session state (shared by session components) --
│   ├── session-store.ts                   # renderedSessionId, intendedSessionId, renderSource
│   ├── transition-controller.ts           # idle → switching → cache → live → idle
│   ├── sessions-query.ts                  # react-query: list sessions for a workspace
│   ├── session-snapshot-query.ts          # react-query: full session + messages
│   │
│   │  -- Session view (composition root for the main area) --
│   ├── session-view.tsx                   # Composes message-list + composer + status
│   │                                      #   owns: scroll position, view-level layout
│   │
│   │  -- Message list (owns its own scroll/virtualization) --
│   ├── message-list/
│   │   ├── message-list.tsx               # Virtualized container
│   │   │                                  #   owns: virtualization state, scroll anchor
│   │   ├── message-item.tsx               # Single message bubble
│   │   │                                  #   owns: collapsed/expanded, copy state
│   │   ├── part-view.tsx                  # Tool call, text, file, reasoning
│   │   │                                  #   owns: expand/collapse per part
│   │   └── index.ts
│   │
│   │  -- Composer (owns its own input state) --
│   ├── composer/
│   │   ├── composer.tsx                   # Prompt textarea + attachments + run/abort
│   │   │                                  #   owns: draft text, file list, submitting
│   │   ├── send-prompt.ts                 # Mutation: send, SSE subscribe, abort
│   │   ├── attachment-picker.tsx
│   │   │                                  #   owns: file picker open/selected state
│   │   └── index.ts
│   │
│   │  -- Session sidebar (owns its own list state) --
│   ├── session-sidebar/
│   │   ├── session-sidebar.tsx            # Session list for one workspace
│   │   │                                  #   owns: search filter, rename-in-progress
│   │   ├── session-item.tsx               # Single row
│   │   │                                  #   owns: hover, context menu open
│   │   └── index.ts
│   │
│   │  -- Transition UX --
│   ├── transition-overlay.tsx             # "Switching..." / skeleton during transitions
│   │                                      #   owns: nothing — reads from transition-controller
│   │
│   └── index.ts                           # Public surface (only what shell needs)
│
├── workspace/                             # Domain: workspace lifecycle
│   ├── workspace-store.ts                 # Which workspaces exist, connection info
│   ├── workspace-list.tsx                 # Sidebar workspace groups
│   │                                      #   owns: collapsed state, selection highlight
│   ├── workspace-switcher.tsx             # Switching logic + transition state
│   │                                      #   owns: switching/idle/failed for workspace changes
│   ├── workspaces-query.ts                # react-query: list + status
│   ├── create-workspace-modal.tsx         # Add workspace flow
│   └── index.ts
│
├── connections/                           # Domain: providers, MCP
│   └── index.ts                           # Placeholder — empty until needed
│
├── cloud/                                 # Domain: hosted workers, den
│   └── index.ts                           # Placeholder — empty until needed
│
├── app-settings/                          # Domain: preferences, themes
│   └── index.ts                           # Placeholder — empty until needed
│
└── automations/                           # Domain: scheduled jobs
    └── index.ts                           # Placeholder — empty until needed
```

### Component-enclosed state hierarchy

Visual hierarchy = state hierarchy. A human reading the tree knows who owns what:

```
shell/layout.tsx
  ├── workspace/workspace-list.tsx          → owns: selection, collapse
  │     └── workspace-switcher.tsx          → owns: workspace transition state
  │
  └── session/session-view.tsx              → reads: session-store (general)
        ├── session/message-list/           → owns: scroll, virtualization
        │     └── message-item.tsx          → owns: expand/collapse per message
        │           └── part-view.tsx       → owns: expand/collapse per part
        ├── session/composer/               → owns: draft, files, submitting
        ├── session/session-sidebar/        → owns: search, rename-in-progress
        └── session/transition-overlay.tsx  → reads: transition-controller (no local state)
```

General session state (`session-store.ts`, `transition-controller.ts`, queries) lives at the `session/` root — shared by components below it. Component-local state (draft text, scroll position, expand/collapse) lives inside the component that renders it. No ambiguity.

---

## Styling Strategy

### What carries over for free

The entire styling foundation is framework-agnostic. React components inherit everything without configuration:

| Asset | Framework-dependent? | Notes |
|-------|---------------------|-------|
| Tailwind classes | No | Just CSS strings. Same classes, same output. |
| CSS custom properties (700+ Radix + DLS tokens) | No | Pure CSS, loaded in `index.css`. |
| Dark mode (`data-theme` + variable swap) | No | Works on any DOM element. |
| `ow-*` CSS classes (buttons, cards, pills) | No | Global CSS, available everywhere. |
| `@keyframes` animations | No | Pure CSS. |
| Font stack | No | System fonts, nothing to load. |
| `DESIGN-LANGUAGE.md` reference | No | Design rules are visual, not framework. |

**React components use `className=` instead of `class=`. That is the only syntax change.**

### What to add for React

One utility in `react/kernel/`:

```ts
// react/kernel/cn.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

The Solid side manages without this (template literals). The React side benefits from `cn()` for conditional classes — it's the standard React/Tailwind convention and prevents class conflicts during composition.

**New dependencies (Phase 0):** `clsx`, `tailwind-merge`.

### Styling rules for React components

1. **Use the same Tailwind classes.** Reference `DESIGN-LANGUAGE.md` for visual decisions.
2. **Use DLS tokens** (`dls-surface`, `dls-border`, `dls-accent`, etc.) via Tailwind config, not raw hex values.
3. **Use Radix color scales** (`bg-gray-3`, `text-blue-11`) for non-semantic colors.
4. **Use `ow-*` classes** where they exist (e.g., `ow-button-primary`, `ow-soft-card`).
5. **Use `cn()`** for conditional classes instead of template literals.
6. **No CSS-in-JS.** No styled-components, no emotion. Tailwind only.
7. **No `dark:` prefix.** Dark mode is handled by CSS variable swap on `[data-theme="dark"]`.
8. **Animation is CSS-only.** Use Tailwind `transition-*` and the existing custom `@keyframes`. No framer-motion.
9. **Match the Solid component's visual output exactly.** When migrating a surface, screenshot both versions and diff. Same spacing, same colors, same radius, same shadows.

### Visual parity verification

Each migrated surface gets a visual comparison test:
1. Screenshot the Solid version (Chrome DevTools).
2. Screenshot the React version (same viewport, same data).
3. Overlay or side-by-side compare. No visible difference = pass.

This is added to the test actions for each phase.

---

## Isolation & Testing Strategy

### Per-phase Docker isolation
Each phase gets tested against two independent Docker dev stacks:

```
Stack A (control): runs the existing SolidJS app
  → packaging/docker/dev-up.sh → server :PORT_A, web :PORT_A_WEB

Stack B (experiment): independent server
  → packaging/docker/dev-up.sh → server :PORT_B, web :PORT_B_WEB
```

Both stacks share the same repo (bind-mounted), but run independent servers with independent tokens and hostnames (verified via `hostname` command through the UI).

### Test actions
Every phase adds entries to `test-actions.md` with:
- Steps to exercise the new React surface
- Expected results
- Comparison against the Solid version on the control stack
- Chrome DevTools verification (using `functions.chrome-devtools_*`)

### Feature flag gate
```
localStorage.setItem('openwork:react-session', 'true')
// or
http://localhost:<WEB_PORT>/session?react=1
```

The app shell checks this flag and renders either:
- `<SessionView />` (Solid, existing)
- `<ReactIsland />` → React session view (new)

---

## Phase Roadmap

### Phase 0: Build Infrastructure

**Goal**: React components can render inside the SolidJS app.

**Deliverables**:
1. Add `@vitejs/plugin-react` to Vite config (alongside `vite-plugin-solid`).
2. File convention: `*.tsx` in `src/react/` = React. Everything else = Solid.
3. `island.tsx` — Solid component that mounts a React root into a DOM node.
4. `boot.tsx` — React root with `QueryClientProvider`.
5. Add `react`, `react-dom`, `@tanstack/react-query` to `apps/app/package.json`.
6. `feature-flag.ts` — reads localStorage / query param.
7. Verify: a trivial React component renders inside the Solid shell.

**Test**:
- Boot Docker stack.
- Navigate to session view.
- Enable feature flag.
- Confirm React island mounts (check React DevTools or a visible test banner).

**Does NOT change any user-visible behavior.**

### Phase 1: React Session View (Read-Only)

**Goal**: A React component can display a session's messages (read-only, no composer).

**Deliverables**:
1. `react/kernel/opencode-client.ts` — plain `fetch()` client for OpenCode proxy.
2. `react/kernel/types.ts` — Session, Message, Part shapes.
3. `react/session/session-store.ts` — `renderedSessionId`, `intendedSessionId`, `renderSource`.
4. `react/session/sessions-query.ts` — react-query: list sessions.
5. `react/session/session-snapshot-query.ts` — react-query: session + messages.
6. `react/session/session-view.tsx` — composition root.
7. `react/session/message-list/` — virtualized message rendering.
8. Feature-flagged: `?react=1` shows React view, default shows Solid.

**State ownership**: React owns all session read state. It fetches directly from the OpenCode proxy. No Solid signal subscriptions. The island props provide only: `workspaceUrl`, `workspaceToken`, `workspaceId`, `sessionId`.

**Test actions**:
- Create session in Solid view, send a prompt, get a response.
- Switch to React view (`?react=1`) — same session's messages appear.
- Switch sessions — React view transitions without white screen.
- Compare: Solid view on Stack A, React view on Stack B, same prompt, same output.

**Success criteria**:
- No blank pane during session switch.
- Messages render from cache instantly, upgrade to live data.
- `renderSource` visible in dev panel.

### Phase 2: React Composer (Send/Receive)

**Goal**: The React session view can send prompts and display streaming responses.

**Deliverables**:
1. `react/session/composer/composer.tsx` — prompt input, file attachment, run/abort.
2. `react/session/composer/send-prompt.ts` — mutation: send, SSE stream, abort.
3. `react/session/composer/attachment-picker.tsx`.
4. SSE subscription for streaming message parts.
5. `streamdown` for markdown rendering of streaming text.

**State ownership**: Composer owns draft text, file list, submitting state. Send mutation is local to composer. Streaming messages flow into react-query cache via SSE → cache invalidation.

**Test actions**:
- Type a prompt in React composer, click Run.
- Response streams in real-time.
- Abort mid-stream — session stops cleanly.
- Switch workspace mid-stream — no crash.

**Success criteria**:
- Full send/receive/abort cycle works in React view.
- Streaming feels identical to Solid view.

### Phase 3: Transition Controller + Debug Panel

**Goal**: The React path handles workspace and session switching with explicit transition states.

**Deliverables**:
1. `react/session/transition-controller.ts` — state machine:
   ```
   idle → switching → (cache-render) → (live-upgrade) → idle
   idle → switching → failed → recovering → idle
   ```
2. `react/session/transition-overlay.tsx` — skeleton/indicator during transitions.
3. `react/kernel/dev-panel.tsx` — shows `routeState`, `transitionState`, `renderSource`, `runtimeState`.

**Test actions**:
- Connect two Docker dev stacks as workspaces.
- Switch between workspaces rapidly.
- React view never shows white screen.
- Debug panel visible and accurate.

**Success criteria**:
- Zero white screens during any switch sequence.
- Transition states are inspectable via Chrome DevTools.

### Phase 4: Backend Read APIs (parallel track)

**Goal**: Session reads don't require client-side OpenCode proxy orchestration.

**Deliverables** (in `apps/server/src/server.ts`):
1. `GET /workspace/:id/sessions` — list sessions for a workspace.
2. `GET /workspace/:id/sessions/:sessionId` — session detail with messages.
3. `GET /workspace/:id/sessions/:sessionId/snapshot` — full session snapshot.
4. Typed response schemas (zod).

**Test actions**:
- `curl http://localhost:<PORT>/workspace/<id>/sessions` returns session list.
- `curl http://localhost:<PORT>/workspace/<id>/sessions/<sid>/snapshot` returns full snapshot.
- Works for any workspace, not just the "active" one.
- React query layer switches to these endpoints.

**Success criteria**:
- Session reads work without activation.
- Response times < 100ms for cached reads.

### Phase 5: React Session as Default

**Goal**: Flip the feature flag. React session view is the default.

**Deliverables**:
1. Feature flag default flips to `true`.
2. `?solid=1` to opt back into Solid session view.
3. Remove any Solid↔React shims that are no longer needed for session.

**Success criteria**:
- All test actions pass with React as default.
- No regression in any existing flow.

### Phase 6: Migrate Workspace Sidebar

**Goal**: React owns the workspace list and session sidebar.

**Deliverables**:
1. `react/workspace/workspace-list.tsx` — workspace groups in sidebar.
2. `react/session/session-sidebar/` — session list per workspace.
3. `react/workspace/workspace-switcher.tsx` — switching logic.
4. Island props shrink: React now receives `workspaces[]` instead of single workspace info.

**State ownership**: React owns workspace selection, sidebar collapse, session list filtering. Solid still owns settings and platform.

### Phase 7: Migrate Settings & Connections

**Goal**: React owns settings pages and provider/MCP flows.

**Deliverables**:
1. Fill `react/app-settings/` — theme, preferences, config.
2. Fill `react/connections/` — provider auth, MCP.
3. Fill `react/cloud/` — hosted workers, den.

### Phase 8: Island Inversion

**Goal**: React becomes the shell. Solid becomes the guest (if anything remains).

**Deliverables**:
1. `react/shell/layout.tsx` becomes the top-level composition.
2. `react/shell/router.tsx` owns all routing.
3. If any Solid surfaces remain, they render inside a `SolidIsland` React component.
4. Island props are now zero or near-zero.

### Phase 9: Remove Solid

**Goal**: The app is pure React.

**Deliverables**:
1. Remove `vite-plugin-solid` from Vite config.
2. Remove `solid-js`, `@solidjs/router`, `solid-primitives` from `package.json`.
3. Delete `apps/app/src/app/` (the old Solid tree).
4. `apps/app/src/react/` becomes `apps/app/src/app/` (or stays where it is).
5. Remove `island.tsx`, `feature-flag.ts`.

---

## Migration Surface Order

```
Phase 0-3  → Session view (messages, composer, transitions)
Phase 5    → Flip session default to React
Phase 6    → Workspace sidebar + session sidebar
             ← tipping point: React owns enough to invert the island →
Phase 7    → Settings, connections, cloud
Phase 8    → Shell/layout/routing — island inversion
Phase 9    → Remove Solid entirely
```

## Timeline Guidance

| Phase | Scope | Estimated Effort |
|-------|-------|-----------------|
| 0 | Build infra | ~1 day |
| 1 | Read-only session view | ~1 week |
| 2 | Composer + streaming | ~1 week |
| 3 | Transition controller + debug | ~1 week |
| 4 | Backend read APIs (parallel) | ~1 week |
| 5 | Flip session default | ~1 day |
| 6 | Workspace sidebar | ~1 week |
| 7 | Settings, connections, cloud | ~2-3 weeks |
| 8 | Island inversion | ~1 week |
| 9 | Remove Solid | ~1 day |

Phases 0-3 are fast and highly visible. Phase 4 can run in parallel. Phases 6+ can be paced based on stability.

---

## Files Changed Per Phase

| Phase | Files |
|-------|-------|
| 0 | `apps/app/vite.config.ts`, `apps/app/package.json`, new `src/react/island.tsx`, `src/react/boot.tsx`, `src/react/feature-flag.ts` |
| 1 | New `src/react/kernel/` (3 files), new `src/react/session/` (6-8 files), feature flag check in `app.tsx` |
| 2 | New `src/react/session/composer/` (3 files) |
| 3 | New `src/react/session/transition-controller.ts`, `transition-overlay.tsx`, `src/react/kernel/dev-panel.tsx` |
| 4 | `apps/server/src/server.ts` (add 3-4 endpoints), new `apps/server/src/session-read-model.ts` |
| 5 | `app.tsx` flag flip, cleanup |
| 6 | New `src/react/workspace/` (4-5 files), `src/react/session/session-sidebar/` (2 files) |
| 7 | Fill `src/react/connections/`, `src/react/app-settings/`, `src/react/cloud/` |
| 8 | `src/react/shell/` becomes the root, island inversion |
| 9 | Delete `src/app/`, remove Solid deps |

---

## Verification Approach

Every phase:
1. Boot two Docker dev stacks (`dev-up.sh` x2).
2. Connect Stack B as a workspace from Stack A's UI.
3. Run the phase's test actions via Chrome DevTools (`functions.chrome-devtools_*`).
4. Screenshot evidence saved to repo.
5. Update `test-actions.md` with the new test actions.
6. PR includes screenshots and test action references.

---

## Dependency Direction

Same CUPID rules apply to the React tree:

```
shell → domain public API (index.ts) → domain internals
```

- Domains may depend on `kernel/` primitives.
- Domains never reach into another domain's internals.
- Cross-domain imports go through `index.ts`.
- No bidirectional imports.
- No "super util" files.

---

## Anti-Patterns

- Adding feature logic to `shell/layout.tsx` (shell orchestrates, doesn't absorb).
- Sharing state between Solid and React for the same concern (one owner always).
- Creating `utils/` or `helpers/` buckets instead of colocating with the owning domain.
- Migrating more than one domain per phase.
- Rewriting Solid component behavior during migration (preserve behavior, change placement).

---

## Decision Heuristic

- **Immediate product feel**: start with frontend Phase 0-1 (session view).
- **Highest compounding win**: invest in backend Phase 4 (read APIs) in parallel.
- **When to invert the island**: after workspace sidebar (Phase 6) moves to React — that's when React owns enough of the visual hierarchy to be the shell.
- **When to remove Solid**: only after all domains are migrated and stable. Not before.
