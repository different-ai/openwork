# App Architecture (`src/react-app/` + `src/app/`)

`apps/app` is a React 19 + Vite app. It is the UI for every OpenWork
deployment: the Electron desktop shell loads it, plain web serves it, and it
talks to openwork-server / opencode / Den over HTTP. (The Solid runtime it
replaced is fully removed; `src/index.react.tsx` is the only entry.)

## Layers

```text
src/
├── app/                       Framework-agnostic layer (no React imports — enforced invariant)
│   ├── lib/                   Clients + bridges: opencode, openwork-server, den, desktop (IPC),
│   │   │                      analytics, app-inspector
│   │   ├── runtime-env.ts     Leaf: isElectronRuntime/isDesktopRuntime
│   │   ├── desktop-types.ts   Leaf: desktop IPC wire types (WorkspaceInfo = shared WorkspaceWire)
│   │   └── den-types.ts       Leaf: Den wire types (den.ts re-exports)
│   ├── extensions.ts          Leaf: extension manifest contract (owns ReloadReason)
│   ├── types.ts               Shared app types (type-only imports of leaves)
│   ├── constants.ts, utils/   Shared constants/helpers
│   └── cloud/, session/, …    Framework-free feature helpers
├── i18n/                      Locales + t(); owns LANGUAGE_PREF_KEY; imports nothing from app/
└── react-app/
    ├── shell/                 Bootstrap, providers composition, routes (session-route,
    │                          settings-route), command palette, menus, boot/loading states
    ├── kernel/                Provider stack (server → global-sdk → global-sync →
    │                          local), platform, notifications, system state
    ├── infra/                 React-only runtime infra (query-client, provider-list-query)
    ├── design-system/         Reusable presentational primitives
    └── domains/               Feature-scoped code, one folder per product domain
        ├── session/           chat/ surface/ sync/ composer, sidebar/, panel/, terminal/,
        │                      voice/, artifacts/, modals/, …
        ├── workspace/         Create/rename/share workspace flows
        ├── settings/          state/ + pages/ + modals/ (settings shell)
        ├── connections/       MCP + provider auth UI
        ├── cloud/             Den sign-in and cloud surfaces
        └── onboarding/        Welcome + first-run flows
```

## Dependency rules (enforced, all verified by `madge --circular`: zero cycles)

1. `src/app/` and `src/i18n/` never import from `src/react-app/` or
   `src/components/`. If something in the agnostic layer needs UI behavior,
   invert it (callback registration) or move the primitive down.
2. Leaf modules (`runtime-env`, `desktop-types`, `den-types`, `extensions`)
   import nothing (or types-only from other leaves). Low-level clients
   (`opencode`, `openwork-server`, `den`) import leaves — never the `utils/`
   barrel (it drags in i18n).
3. `kernel/` and `infra/` sit below `domains/`: they must not import domain
   code. Shared query/state infrastructure lives in `infra/`.
4. `shell/` sits on top and may import everything.
5. Wire contracts shared with other processes live in `packages/types`
   (e.g. `WorkspaceWire`); producer types assert assignability against them.

Toasts are rendered with `sonner` (`@/components/ui/sonner`), mounted once via
`<Toaster />` in `shell/providers.tsx`, driven imperatively with `toast()`.

## Data flow

```text
src/index.react.tsx                       React entry
  └─ QueryClientProvider + PlatformProvider
     └─ react-app/shell/providers.tsx     (AppProviders composition)
        ServerProvider
        └─ GlobalSDKProvider
           └─ GlobalSyncProvider
              └─ LocalProvider
                 └─ react-app/shell/app-root.tsx → routes
                    ├─ shell/session-route.tsx   → domains/session
                    ├─ shell/settings-route.tsx  → domains/settings, connections
                    └─ domains/{workspace,cloud,onboarding} flows
```

## State ownership

- `react-app/kernel/server-provider-state.ts` and
  `react-app/kernel/system-state.ts`: shell-level server, reload, and reset state.
- `react-app/kernel/notification-store.ts`: persistent notification-center
  Zustand store.
- `react-app/infra/query-client.ts`: TanStack Query singleton.
  `react-app/infra/provider-list-query.ts`: shared provider-list cache used by
  kernel, shell, and connections.
- Feature state tightly coupled to one domain lives inside that domain
  (`domains/session/sync/`, `domains/settings/state/`).

## Active workspace and session

Workspace and session identity are route state, not app-global mutable state.

Canonical workspace-scoped routes:

- `/workspace/:workspaceId/session`
- `/workspace/:workspaceId/session/:sessionId`
- `/workspace/:workspaceId/settings/:tab`
- `/workspace/:workspaceId/extensions/:section`

Use `react-app/shell/workspace-routes.ts` to build these paths. Do not
hand-build `/session/...` or `/settings/...` URLs for workspace-scoped flows.

Rules for agents and future code:

- In session or workspace-scoped settings routes, read the active workspace
  from the URL `workspaceId` param first.
- Read the active session from the URL `sessionId` param. A selected session
  should never imply a different workspace than the URL workspace.
- The legacy `openwork.react.activeWorkspace` and
  `openwork.react.sessionByWorkspace` values are only restore/fallback memory.
  They are not authoritative while a workspace-scoped URL is active.
- `/session`, `/session/:sessionId`, and `/settings/*` are compatibility entry
  points. They should redirect to workspace-scoped URLs when the workspace can
  be resolved.
- Missing URL resources should not silently fall back to the first workspace.
  Show a not-found state and let the user pick from the sidebar.
- Workspace-scoped actions (rename workspace, create session, open
  MCP/settings tabs, quick actions, commands, delete session) should use the
  URL-derived workspace/session context or receive explicit ids from the
  caller.

Practical examples:

- From session B in workspace B, opening settings navigates to
  `/workspace/B/settings/general`.
- Opening a session from the command palette navigates to
  `/workspace/<owner-workspace-id>/session/<session-id>`, owner found from the
  session list.
- Creating a new task in a workspace navigates to
  `/workspace/<workspace-id>/session/<new-session-id>`.

## Agent-readable workbench state

The URL remains authoritative for the active workspace and primary session.
`domains/session/chat/workbench-store.ts` owns the additional workbench state
that a URL cannot represent: retained conversation tabs, the secondary split
session, and which pane is focused. It is process memory so this state survives
temporary navigation to Settings, but it does not replace route identity.

`shell/openwork-context-projector.ts` combines route state, the workbench store,
UI chrome state, and panel-tab state into the shared
`OpenworkContextSnapshot` contract. `OpenworkContextPublisher` publishes that
snapshot through `window.__openworkControl`; the desktop loopback bridge and
`openwork-ui-mcp` expose the same contract without requiring every element to
be mounted or visible.

Control registrations have semantic metadata:

- `kind: "query"` is a concurrent, side-effect-free read and must not focus the
  desktop window.
- `kind: "command"` can change UI, durable data, or an external system.
  Commands are serialized and may use `expectedRevision` to reject stale work.
- `effects`, `confirmation`, `availability`, and `executor` let agents choose
  behavior from data instead of relying on a large steering prompt.

Do not register backend reads as pretend navigation actions. Add an explicit
query, keep UI commands outcome-oriented, and scope session operations by ID so
split-screen sessions cannot be confused.

## Sidebar lanes

The sidebar has two vertical rails, defined once in
`domains/session/sidebar/sidebar-lanes.tsx`:

- **glyph lane, 20px** — activity dot-matrix, chevrons, row icons, and the
  top-level `WORKSPACES` label.
- **label lane, 44px** — every row title: workspace names, session titles,
  group labels (`TO DO`, `PINNED`, `ARCHIVED`), empty/loading placeholders, and
  the account name in the footer.

Rules when adding a sidebar row:

1. Compose the row with `SIDEBAR_ROW_LANE` / `sidebarRowPaddingInlineStart(depth)`
   (12px base + 16px per depth level) instead of ad-hoc `ps-*`.
2. Render `SidebarGlyphSlot` as the first child even when there is no glyph, so
   the title never shifts when an indicator appears.
3. Style section labels with `SIDEBAR_SECTION_LABEL`; put them on the glyph lane
   only when they are top-level.

`evals/flows/sidebar-lanes.flow.mjs` asserts every rendered row lands on one of
the two rails, so a new row with its own padding fails the flow.

## Testing

- Unit: `bun test tests/` (CI-gated). Pure logic and parsers belong here.
- Smoke/e2e: `pnpm test:e2e` and `scripts/*.mjs` (health, sessions, events).
- UI E2E tests: `pnpm evals:e2e` from the repo root drives the real app.
