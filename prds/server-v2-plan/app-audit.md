# App Audit

## Scope

This audit covers `apps/app/**` only.

## Alignment Note

This audit documents the current client-side footprint, not the final target-state ownership boundary.

To fully match `prds/server-v2-plan/ideal-flow.md`, cloud settings, workspace/server relationship state, config mutation, and session/runtime behavior should become server-owned, while app-local storage shrinks to transient UI state and minimal reconnect data.

The goal is to document:

- every meaningful feature that does not explicitly contact the OpenWork server
- every feature that does substantial local/client-side work before it eventually sends data to the server

This document now assumes the target architecture is a single main server API surface, not a permanent split between app, orchestrator control plane, and server control plane.

The focus is on the client-owned lifecycle: local state, browser APIs, local persistence, parsing, transformations, clipboard, dialogs, routing, rendering, Tauri-bridged local actions, and mixed local-then-server flows.

## Disposition Labels

- `Stay`: should remain in the app because it is transient UI state, presentation logic, or other true client behavior.
- `Move`: should move behind the server because it is real workspace behavior.
- `Split`: some UI orchestration or local preprocessing should stay, but the underlying capability should move behind the server.

## High-Level Lifecycle

1. The frontend boots and restores local shell state.
2. Theme, zoom, window preferences, and workspace/session preferences are restored locally.
3. Deep links and startup state are parsed locally before deciding whether to connect anywhere.
4. Workspace creation, connection, sharing, session composition, and settings flows do a lot of local shaping before contacting server surfaces.
5. Large parts of the UI remain purely local: layout, drafts, rendering, search, diagnostics, and clipboard/open-file helpers.

## Shell And Persistent UI State

Disposition guidance:

- all items in this section -> `Stay`

Reasoning: theme, zoom, layout, local preferences, and shell restoration are legitimate client-owned concerns.

### `theme`

- What it does: manages light/dark/system theme and applies it to the document.
- Called from and when: initialized during app boot and updated when the user changes theme settings.
- Ends up calling: `localStorage`, `matchMedia`, `document.documentElement.dataset.theme`, and CSS `color-scheme`; no server contact.

### `LocalProvider` and `persisted`

- What they do: persist app-level UI preferences and shell state such as tabs, thinking visibility, model defaults, and other local settings.
- Called from and when: mounted at app startup and used throughout the app lifecycle.
- Ends up calling: browser storage or platform storage abstractions; no server contact by themselves.

### `useSessionDisplayPreferences`

- What it does: stores per-user display preferences such as whether “thinking” is shown.
- Called from and when: used while rendering session pages and on settings resets.
- Ends up calling: local preference persistence and render state updates; no server contact.

### app startup/session preference restoration in `app.tsx`

- What it does: restores startup state such as last-selected session, selected base URL, engine source/runtime preferences, and update-related UI settings.
- Called from and when: runs during app boot.
- Ends up calling: `localStorage`, navigation setup, startup session restoration, and connection preference state; no direct server contact, though restored values may later influence server calls.

### font zoom and window chrome helpers

- What they do: handle zoom shortcuts, persist zoom state, apply CSS fallback zoom, and toggle Tauri window decorations.
- Called from and when: initialized during app boot and triggered on keyboard shortcuts or preference changes.
- Ends up calling: `localStorage`, CSS updates, Tauri webview zoom APIs, and Tauri window APIs; no server contact.

### workspace shell layout persistence

- What it does: stores sidebar widths, expansion state, and other shell layout preferences.
- Called from and when: used while the session shell is open and while the user resizes or toggles layout areas.
- Ends up calling: local storage and render/layout updates only; no server contact.

## Deep Links And Cloud Session State

Disposition guidance:

- deep-link bridge -> `Stay`
- deep-link parsing and controller logic -> `Split`
- OpenWork Cloud settings persistence -> `Split`
- manual cloud sign-in flow -> `Split`
- OpenWork Cloud template cache -> `Stay`

Reasoning: parsing, routing, and lightweight cached cloud session state stay in the UI, but durable cloud settings and auth/session state should move behind the server.

### deep-link bridge

- What it does: queues native/browser deep links before the app is fully ready and replays them into the running UI.
- Called from and when: used at app boot and when desktop/native deep-link events arrive.
- Ends up calling: `window.__OPENWORK__` state and custom browser events; no server contact by itself.

### deep-link parsing and controller logic

- What it does: parses OpenWork remote-connect links, Den auth links, debug links, and cleans URL state after consuming them.
- Called from and when: runs on app boot and when deep-link events arrive.
- Ends up calling: local routing, modal state, query-param cleanup, and cloud/session settings updates; some branches eventually contact OpenWork or Den after local parsing is complete.

### OpenWork Cloud settings persistence

- What it does: stores cloud base URL, auth token, and active org for Den/OpenWork cloud features.
- Called from and when: used by cloud settings, workspace creation, and sharing flows.
- Ends up calling: `localStorage` and local cloud-session state; in the ideal model durable cloud auth/settings move to the server DB and this becomes transient reconnect/UI state.

### manual cloud sign-in flow

- What it does: accepts a pasted deep link or handoff code, parses it locally, validates it, and exchanges it for a cloud token.
- Called from and when: called from the Cloud settings panel when the user signs in manually.
- Ends up calling: local parsing and status state first, then cloud auth endpoints.

### OpenWork Cloud template cache

- What it does: memoizes cloud template lists by cloud identity and org.
- Called from and when: used when template-driven workspace creation or cloud settings panels open.
- Ends up calling: in-memory cache and signals first; initial loads eventually fetch from cloud/server surfaces.

## Workspace Creation And Connection

Disposition guidance:

- `CreateWorkspaceModal` -> `Stay`
- `createWorkspaceFlow` -> `Split`
- sandbox creation flow -> `Split`
- `createRemoteWorkspaceFlow` -> `Split`
- onboarding/bootstrap branching -> `Stay`

Reasoning: modal state and startup branching stay in the UI, but actual workspace creation/connection/runtime behavior should move behind the server.

### `CreateWorkspaceModal`

- What it does: owns the local UI state for local workspace creation, remote worker connection, cloud template browsing, worker filtering, and folder selection.
- Called from and when: opened from onboarding and create/connect workspace flows.
- Ends up calling: local modal state, folder pickers, cloud template cache, browser/Tauri link opening, and then optionally remote or cloud connection flows.

### `createWorkspaceFlow`

- What it does: orchestrates local workspace creation, derives default names, queues a starter session, updates selection state, and routes into first-session setup.
- Called from and when: called from onboarding, the create-workspace modal, and template/bundle import flows.
- Ends up calling: local busy state, selected workspace state, navigation, Tauri local workspace creation, and starter session setup; some branches eventually use local server surfaces.

### sandbox creation flow

- What it does: manages local progress state, Docker preflight state, debug logs, and Tauri event subscriptions for sandbox startup.
- Called from and when: called from sandbox/new worker creation UI.
- Ends up calling: local progress UI, Tauri event listeners, and debug state first, then remote/server registration once the sandbox is ready.

### `createRemoteWorkspaceFlow`

- What it does: normalizes the remote host URL/token, resolves remote workspace identity, updates local server settings, and persists a remote workspace record.
- Called from and when: called from deep links, onboarding connect flows, worker open actions, and remote workspace modals.
- Ends up calling: local validation, local settings persistence, routing, selected-workspace state, and then remote server requests; in the ideal model the durable remote workspace record belongs in the local server DB, not the app.

### onboarding/bootstrap branching

- What it does: decides whether startup should create a welcome workspace, reconnect a local runtime, reconnect a remote worker, or stay on welcome/onboarding UI.
- Called from and when: runs during app startup.
- Ends up calling: local startup-phase state, navigation, and workspace-selection logic first; some branches eventually connect to server/runtime surfaces.

## Bundle Import, Share, And Publish

Disposition guidance:

- bundle URL parsing and fetch fallback -> `Stay`
- bundle schema parsing -> `Stay`
- bundle workflow store -> `Split`
- workspace share/export state -> `Split`
- bundle publishing helpers -> `Split`

Reasoning: parsing and UI state stay client-side, but import/export/share of real workspace capabilities should ultimately be server-owned.

### bundle URL parsing and fetch fallback

- What it does: parses bundle deep links, cleans bundle-specific query params, rewrites bundle URLs, and chooses fetch strategies.
- Called from and when: runs on app boot, bundle deep-link open, and debug-open flows.
- Ends up calling: local URL cleanup and fetch strategy selection first, then bundle fetches.

### bundle schema parsing

- What it does: validates imported bundle shape and normalizes names, presets, and files into app-friendly structures.
- Called from and when: used whenever a bundle is opened, previewed, or imported.
- Ends up calling: local parsing/validation only; no server contact by itself.

### bundle workflow store

- What it does: owns modal state and the import decision tree, including trust warnings, worker-target resolution, and import routing.
- Called from and when: entered from bundle deep links, team templates, and debug-open flows.
- Ends up calling: local modal state, navigation, worker selection, and import state first, then workspace import or worker-creation flows.

### workspace share/export state

- What it does: derives shareable metadata for local and remote workspaces, resolves missing workspace IDs, and tracks share modal state.
- Called from and when: used by the session share flow.
- Ends up calling: local modal state, clipboard, browser/Tauri opener, and share metadata derivation first; publish/export actions later contact OpenWork or Den.

### bundle publishing helpers

- What they do: shape bundle payloads locally and reconcile org identity before publish.
- Called from and when: called from sharing and skills-publish flows.
- Ends up calling: local payload construction first, then OpenWork/Den publish APIs.

## Session Composer And Session View

Disposition guidance:

- session draft persistence -> `Stay`
- attachment preprocessing in the composer -> `Stay`
- prompt and command file-part shaping -> `Split`
- optimistic session creation and navigation -> `Split`
- undo, redo, and compact helpers -> `Split`
- local message search and command palette -> `Stay`
- message-windowing and render throttling -> `Stay`
- local file and folder affordances -> `Stay`

Reasoning: drafts, rendering, local search, and client-side attachment prep stay in the UI; real session operations and workspace-aware file semantics should move behind the server.

### session draft persistence

- What it does: stores and restores per-workspace/per-session draft text and mode.
- Called from and when: active while the user edits prompts and switches sessions.
- Ends up calling: `localStorage`, custom flush events, and local composer state only; no server contact until send.

### attachment preprocessing in the composer

- What it does: filters incoming files, compresses images, estimates payload size, creates preview URLs, and handles drag/paste attachment intake.
- Called from and when: called while the user edits a prompt or drops/pastes attachments.
- Ends up calling: `FileReader`, `OffscreenCanvas` or canvas APIs, object URLs, clipboard/paste handling, and local warning state; attachments may later be sent to the server when the user submits.

### prompt and command file-part shaping in the session actions store

- What it does: resolves file mentions, converts attachments into data URLs, builds prompt or command payload parts, and clears drafts at the right time.
- Called from and when: called when the user sends a prompt, retries, or creates a new session from local input.
- Ends up calling: local prompt/draft state, file/data transformation, and then final prompt/session server calls.

### optimistic session creation and navigation

- What it does: creates a new session flow in the UI, preserves the initial prompt locally, selects the session, refreshes sidebar state, and navigates to it.
- Called from and when: called when the user sends without an active session or explicitly creates one.
- Ends up calling: local navigation and session-list state first, then session creation on the server.

### undo, redo, and compact helpers

- What they do: perform local prompt/session-state coordination around history operations.
- Called from and when: called from session history controls.
- Ends up calling: local prompt/session state first, then server-backed revert or compact operations.

### local message search and session command palette

- What it does: builds client-side searchable message text, debounces queries, tracks hits, and scrolls to matches; also manages local session command-palette behavior.
- Called from and when: active while a session is open and the user searches or switches via palette.
- Ends up calling: local render/search state, scroll positioning, and navigation only; no server contact.

### message-windowing and render throttling

- What it does: windows long histories, batches streaming render commits, and tracks render/perf details locally.
- Called from and when: active during session rendering and message streaming.
- Ends up calling: render state and performance bookkeeping only; no server contact.

### local file and folder affordances in the session UI

- What they do: reveal workspace directories, open local files, and reveal artifact paths.
- Called from and when: called from message parts and session sidebars.
- Ends up calling: Tauri opener APIs and local toast state; no server contact.

## Skills, Plugins, MCP, And Local Config Editing

Disposition guidance:

- cloud import metadata normalization -> `Split`
- skills and cloud-sync local prep -> `Split`
- plugin config editing -> `Move`
- MCP connection and config flow -> `Split`
- cloud provider list memoization -> `Stay`

Reasoning: UI-owned shaping and memoization stay local, but config mutation, skills/plugins/MCP capability changes, and other workspace mutations should move behind the server.

### cloud import metadata normalization

- What it does: parses and rewrites `cloudImports` metadata in workspace config.
- Called from and when: used when syncing skills, providers, and hubs with cloud-backed metadata.
- Ends up calling: local config-shaping logic first; final writes should route through the server, with any Tauri-backed config path treated as temporary fallback-only debt.

### skills and cloud-sync local prep

- What it does: slugifies names, extracts markdown bodies, builds frontmatter, tracks imported cloud-skill maps, and stores hub preferences locally.
- Called from and when: used in skills import/edit/remove flows.
- Ends up calling: local markdown/config shaping, local state, `localStorage`, and in some cases direct local skill-file mutation; those direct local mutation paths are temporary fallback-only debt, and successful flows should ultimately go through the server or cloud APIs.

### plugin config editing

- What it does: parses and rewrites plugin arrays inside `opencode.json` using local JSONC edits.
- Called from and when: called from plugin/settings UI.
- Ends up calling: local config parsing and file-update shaping first; writes should move behind server-backed config APIs, and local writes should be treated as temporary fallback-only debt.

### MCP connection and config flow

- What it does: builds MCP config objects locally, infers names, injects special Chrome DevTools env values, and edits/removes config.
- Called from and when: called from MCP connect, remove, and auth/logout UI.
- Ends up calling: local config editing, local MCP modal state, and then server-backed MCP writes/logout or external auth flows; direct local config edits here should be treated as temporary fallback-only debt.

### cloud provider list memoization

- What it does: caches and merges provider lists using local cloud session/org state.
- Called from and when: used while provider settings or provider-auth UI is open.
- Ends up calling: in-memory cache and local state first; refreshes eventually contact Den or the main server, and any direct OpenCode access should be treated as migration debt.

## Diagnostics, Reset, And Desktop Utilities

Disposition guidance:

- OpenWork server settings persistence -> `Split`
- reset and reload state management -> `Stay`
- settings diagnostics and export helpers -> `Split`
- incidental clipboard/open-link helpers -> `Stay`

Reasoning: client preferences, reload state, clipboard, and pure diagnostics remain UI concerns, while durable connection/auth/product state should move behind the server.

### OpenWork server settings persistence

- What it does: normalizes and persists host URL, token, remote-access preference, and derived base URL/client settings.
- Called from and when: used on app boot and when connection settings change.
- Ends up calling: `localStorage` and local connection state; in the ideal model this shrinks to minimal reconnect/bootstrap hints while durable connection registry and cloud auth/session metadata move behind the server.

### reset and reload state management

- What it does: tracks reload-required reasons, supports local resets, and relaunch/reload behavior.
- Called from and when: used by settings and reload-warning UI.
- Ends up calling: local storage cleanup, local state resets, and app relaunch/reload APIs; no direct server contact.

### settings diagnostics and export helpers

- What they do: build local debug/export payloads, copy them to clipboard, download them as files, or reveal paths in Finder.
- Called from and when: called from settings diagnostics UI.
- Ends up calling: clipboard APIs, Blob download APIs, Tauri opener APIs, and local reset helpers; most paths do not contact the server.

### incidental clipboard/open-link helpers

- What they do: copy links, share codes, messages, and open auth/share URLs.
- Called from and when: called from share, auth, and message actions across the UI.
- Ends up calling: clipboard and opener/browser APIs; they often follow a server action, but the helper itself is local.

## Coverage Limits

- This audit stays focused on `apps/app`.
- It intentionally excludes simple server fetch wrappers unless the client does meaningful local work first.
- It describes mixed flows where local parsing/state/setup happens before a server request, because those are important ownership boundaries.
