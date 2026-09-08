# @openwork/browser-tabs

The shared host and policy layer for OpenWork's built-in browser. The desktop app has one
native browser surface shared by every conversation, but each tab belongs to
the conversation that opened it. The default export stays platform-neutral,
safe to import from React, and decides:

- **Ownership** — which conversation a tab belongs to, and which tab is active
  for each conversation (`createBrowserTabRegistry`).
- **Surfacing** — whether a tab may take the screen right now (`foreground`)
  or must stay silent because its conversation is not the one on screen
  (`background`).
- **Background rendering** — the recipe that keeps a hidden tab behaving like
  a real page for the agent driving it: a full emulated viewport, focus
  emulation, and a never-shown parking window so Chromium keeps painting
  (`backgroundTabEmulationCommands`). Tiny bounds are not a visibility boundary.
- **What a conversation sees** — the renderer-side filters that give each
  side panel only its own tabs (`browserTabsForSession`,
  `activeBrowserTabIdForSession`).

Consumers: `apps/desktop/electron/browser-panel.mjs` (main process) and the
session side panel in `apps/app`. The shared IPC shapes (`BrowserPanelTab`,
`BrowserStatePayload`, `OpenBrowserUrlResult`) live in `index.d.ts`.

Run `bun test` here for the policy tests; `apps/desktop/electron/browser-panel.test.mjs`
covers the Electron wiring with a stubbed `WebContentsView`, and
`evals/specs/browser-tabs-owned-by-thread.e2e.test.ts` proves the user journey
on the real app.

## Electron host

Import `createBrowserPanel` from `@openwork/browser-tabs/electron` in the Electron
main process only. Instantiate **one host per shell**, not one per owner. That
host owns one registry and lazily creates one never-shown parking BrowserWindow
for all background owners. It never creates a replacement main window.

Each host admits at most 12 tabs, including pending opens; overflow rejects
without evicting existing pages. Failed opens release their allocation unless
an aborted open is explicitly preserved by the shell for takeover. External
target closure uses the same owner/native cleanup as explicit close. The parking
window is destroyed when empty and recreated on demand. Desktop's
`openwork:browser:closeSessionTabs` IPC closes only an exact non-empty owner;
missing or malformed owners never close shared or foreground tabs implicitly.

Required factory options:

- `getWindow(): BrowserWindow | null`: the shell's main container. Its
  `contentView` hosts foreground pages; its webContents supplies zoom and events.
- `remoteDebugPort: number`: the shell's enabled Electron loopback CDP port.
- `partition: string`: a persistent partition, e.g. `persist:coworker-browser`.
- `preloadPath: string`: an absolute path to the shipped browser preload asset.
- `openExternal(url): Promise<unknown>`: the shell's explicit external opener.
- `runDetachedTask(label, task): void`: run the task and report rejected promises.
  Desktop injects its existing process-resilience helper.

Optional adapters:

- `checkPolicy({ url, external?, method?, hasUpload? })`: async evaluator;
  resolve to permit, reject to deny. The partition's request hook still covers navigation,
  redirects, frames, uploads and CDP requests, not just window events.
- `handleDeepLink(url): boolean`: synchronously recognize and consume the shell's
  scheme. `true` retains the existing delayed blank-page/hide handoff. Desktop's
  wrapper recognizes `openwork://` and `openwork-dev://`; the shared host does not.
- `popupDisposition({ url, ownerId, tabId }): "embedded" | "external" | "deny"`
  (may return a promise): defaults to external, including Desktop's existing
  same-owner embedded fallback on external policy denial. `embedded` uses the
  same marker/open path, checks embedded policy, and preserves the captured
  opener owner. Denied embedded policy does not fall back externally.
- `onEvent(channel, payload)`: receive existing `openwork:browser:*` events
  instead of sending them to the main renderer. Payloads retain
  `ownerSessionId`, `visibleSessionId`, `activeTabIdByOwner`, and panel tab shapes.
- `BrowserWindow`: optional Electron constructor override for the parking host.
- `menuOverlay`: omitted by default. To use Desktop's native overlay, supply
  `{ preloadPath, loadRenderer(view), listInstalledBrowsers(), openBuiltinLabel }`.
  Desktop supplies its current renderer, installed-browser catalog and label.
  Coworker may omit it and use its own UI; no overlay preload is then required.

### Direct API (no IPC registration)

- `await createBrowser({ ownerId, url, inBackground? })`: opens via the existing
  marker CDP discovery path and returns
  `{ tabId, targetId, browserUrl, url, ownerId, title, favicon, status,
  canGoBack, canGoForward, visible }`. IDs remain stable when the view moves.
- `listBrowsers(ownerId)`: synchronous descriptors for exactly this owner's tabs,
  not shared or other owners' tabs. Legacy Desktop UI tabs may have
  `targetId: null`; direct opens and embedded-adapter popups resolve a target ID.
- `closeBrowser({ ownerId, tabId?, targetId? })`: close one scoped target; returns
  the closed tab ID. At least one ID is required; both, when supplied, must match.
- `selectBrowser({ ownerId, tabId?, targetId? })`: select an owned tab, recover its
  viewport, and return its descriptor. Does not switch the visible owner.
- `setVisibleSession(ownerId | null)`: select the visible owner, park the previous
  owner's views and restore the new owner's active view. Returns that owner ID.
- `show(bounds, { sessionId?, ensureTab?, preloadDefault? }?)`, `hide()`,
  `setBounds(bounds)`: existing panel lifecycle; bounds are renderer CSS pixels
  `{ x, y, width, height }`. `setBounds` alone does not show a hidden panel.
- `navigate(url)`, `back()`, `forward()`, `reload()`: existing controls on the
  current on-screen tab. `navigate` creates a tab for the visible owner if needed;
  it schedules the load rather than awaiting navigation completion.
- `state()`: existing Desktop diagnostic state (all owners, native attachment,
  parking-window visibility). `setProxy(input)`, `getProxy()`, `destroy()` retain
  the existing proxy/session and teardown behavior.
- `registerIpc(ipcMain)`, `isMainWindowAllowedNavigation(url)` and
  `routeBlockedMainWindowNavigation(url)` remain for Desktop compatibility.

The scoped methods require a non-empty string owner; unknown or mismatched
targets throw. Owners are UX isolation, **not an authorization boundary**. Raw
CDP exposes the process; the shell must guard IPC/tool calls, target access and
diagnostic state separately. Creating a tab never changes the visible owner.
`visible` means eligible to surface for that owner, not proof the panel is shown.
`inBackground: true` suppresses surfacing and panel-opened events even for the
visible owner until explicit tab selection or showing/selecting that owner.

### Package and preload wiring

The host ships as plain ESM; no package compilation step is required. Keep
`electron` external when bundling a main process. `@openwork/browser-tabs/preload`
exports the unchanged sandbox-compatible CJS asset; **resolve/copy it, do not
import or bundle it into the main process**.

For an unbundled Electron app (Desktop), resolve at runtime with
`fileURLToPath(import.meta.resolve("@openwork/browser-tabs/preload"))` and ship the
package files. Desktop's runtime staging includes the package explicitly.

For a bundled app (Coworker), add the workspace dependency, bundle the `/electron`
entry into the main bundle, and resolve `/preload` at **build time**. Copy that
asset next to `electron-dist/main.mjs` as `browser-content-preload.cjs`, include
it in the installer, and inject
`fileURLToPath(new URL("./browser-content-preload.cjs", import.meta.url))` from
the shell's main entry. No runtime repository lookup or extra package installation
is needed in that bundled layout. The shared browser preload only sends the
existing menu-dismiss event; omitting the overlay requires no replacement preload.
