# @openwork/browser-tabs

The policy layer for OpenWork's built-in browser. The desktop app has one
native browser surface shared by every conversation, but each tab belongs to
the conversation that opened it. This package decides, without Electron or
React:

- **Ownership** — which conversation a tab belongs to, and which tab is active
  for each conversation (`createBrowserTabRegistry`).
- **Surfacing** — whether a tab may take the screen right now (`foreground`)
  or must stay silent because its conversation is not the one on screen
  (`background`).
- **Background rendering** — the recipe that keeps a hidden tab behaving like
  a real page for the agent driving it: a full emulated viewport, focus
  emulation, and a one-pixel on-window presence so Chromium keeps painting
  (`backgroundTabEmulationCommands`, `BACKGROUND_TAB_PRESENCE_BOUNDS`).
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
