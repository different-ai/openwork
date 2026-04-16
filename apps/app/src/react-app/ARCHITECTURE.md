# React App Architecture (`src/react-app/`)

This document captures the domain-based layout for the React runtime being migrated into
`apps/app`. The Solid runtime still ships by default; the React tree is being built up domain by
domain so it can take over in a single hard cut.

## Top-level layout

```text
src/react-app/
├── shell/                     App bootstrap, providers composition, startup effects
├── kernel/                    App-wide state + provider contracts (replaces app/context/*)
├── infra/                     React-only runtime infra
├── design-system/             Reusable presentational primitives + small modal primitives
└── domains/                   Feature-scoped code, one folder per product domain
    ├── session/
    │   ├── chat/              Route chrome (status bar, question/permission surfaces)
    │   ├── surface/           Transcript, composer, markdown, tool-call, debug panel
    │   ├── sync/              Session state plumbing (store, runtime, chat adapter)
    │   └── modals/            Model picker, question, rename-session
    ├── workspace/             Create + share + rename workspace flows
    ├── settings/
    │   ├── state/             Settings-scoped hooks/providers
    │   ├── pages/             Plugins, extensions, config, ... (tab bodies)
    │   └── modals/            Reset modal, ...
    ├── connections/
    │   └── modals/            Add-MCP, Chrome-setup, ...
    ├── bundles/               Import / start / skill-destination flows + agnostic re-exports
    └── shell-feedback/        Status toasts, reload banner, top-right notifications
```

## Why domains

The Solid tree grew pseudo-flat (`app/components/*`, `app/context/*`, `app/pages/*`).
The React tree uses explicit domain ownership so every feature has one obvious home.

- `session/` owns everything the session route renders, including the state layer under `sync/`.
- `workspace/` owns every workspace-modal flow, so create/share/rename live together.
- `settings/` owns settings state, the full settings shell once it lands, and each tab body as a
  stateless page under `pages/`.
- `connections/` owns MCP and provider auth UI.
- `bundles/` owns import/start/destination modals plus re-exports of the framework-agnostic
  helpers.
- `shell-feedback/` owns toasts and notifications that the shell shows on top of everything.

Cross-domain imports go through module boundaries, not a shared blob.

## Data flow

```text
┌────────────────────────────────────────────────────────────┐
│                     src/index.react.tsx                    │  React entry
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│  react-app/shell/providers.tsx (AppProviders composition)  │
│   ServerProvider                                           │
│   └─ GlobalSDKProvider                                     │
│      └─ GlobalSyncProvider                                 │
│         └─ LocalProvider                                   │
│            └─ (QueryClientProvider + PlatformProvider      │
│               wrap AppProviders in index.react.tsx)        │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│               react-app/shell/app-root.tsx                 │  Route root (placeholder today)
└────────────────────────────────────────────────────────────┘
                              │
           ┌──────────────────┼──────────────────┐
           ▼                  ▼                  ▼
   domains/session     domains/workspace   domains/settings
           │                  │                  │
           ▼                  ▼                  ▼
  surface/, sync/,    create-/share-/     pages/ (plugins,
   chat/, modals/     rename-*.tsx        config, ...),
                                           modals/, state/
```

## State ownership

- `react-app/kernel/store.ts`: Zustand store, the React replacement for the Solid context bag.
  Domain selectors in `kernel/selectors.ts`.
- `react-app/kernel/{server,global-sdk,global-sync,local}-provider.tsx`: the Solid provider stack
  re-expressed in React context. Same composition order as `app/entry.tsx`.
- `react-app/kernel/platform.tsx`: `PlatformProvider` + `createDefaultPlatform()` helper
  (Tauri-vs-web).
- `react-app/kernel/system-state.ts`: `useSystemState()` for reload + reset modal state.
- `react-app/kernel/model-config.ts`: framework-agnostic model parse/serialize helpers plus
  `useDefaultModel()` (the heavier workspace overrides and auto-compact logic still live in
  Solid and will be ported with the settings shell).
- `react-app/infra/query-client.ts`: TanStack Query singleton.
- Feature-specific state that is tightly coupled to one domain lives inside that domain
  (`domains/session/sync/`, `domains/settings/state/`).

## Framework-agnostic boundary

Anything that is already Solid-free stays under `src/app/` and is re-exported from the React
tree when a domain-scoped import path is clearer. Examples:

- `app/lib/*` (opencode, tauri, den, openwork-server, ...) — consumed directly by React.
- `app/types.ts`, `app/constants.ts`, `app/theme.ts`, `app/utils/*` — shared across both runtimes.
- `app/session/composer-tools.ts` — shared session helpers.
- `app/bundles/{types,schema,url-policy,sources,apply,publish,skill-org-publish,index}` — bundle
  logic consumed by both runtimes; React side re-exports from `domains/bundles/*`.

## Porting pattern

1. **Move, don't rewrite, for framework-free files.** Re-export from the React domain folder so
   Solid can keep importing through the old path during the transition.
2. **Invert contexts to props** when porting pages that depended on Solid context. The React
   version takes the data/actions it needs as props; the parent wires it up. This lets domain
   pages land before their provider layer is fully ported.
3. **Each port is its own commit.** The Solid runtime stays green the entire time; the React
   entry (`src/index.react.tsx`) builds and typechecks after every commit.

## Active shims

During the transition, files under `src/react/**` are thin re-exports pointing at the new
`react-app/**` locations. They exist so the Solid runtime (which imports from the old paths via
`ReactIsland`) keeps compiling. All `src/react/**` files are deleted in the final Phase 8 cutover
along with the Solid tree under `src/app/**`.
