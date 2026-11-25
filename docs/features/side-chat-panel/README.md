# A side chat's pages show beside it

- **Status:** generally available; `sideChatPanel` was retired in November 2026.
- **Deployments:** cloud and self-hosted
- **Author:** @reachjalil

## What people get

The browser and files panel follows the chat you are working in. When the
chat in the split pane opens a page or a file, the panel shows it beside that
chat. Click back into the main chat and the panel shows the main chat's pages
again.

## Rules

- The split pane's chat takes the panel only while it is the chat you are
  working in and it has a page or file to show. Until then the main chat's
  panel stays as it is.
- Closing the panel while it shows the split pane's pages closes the panel.
- A draft chat and a chat from another workspace never take the panel.

## Where it lives

- `apps/app/src/react-app/domains/session/chat/workbench-panel-session.ts`
  picks the conversation the panel shows.
- `apps/app/src/react-app/domains/session/chat/session-page.tsx` uses that
  conversation for the panel, its tabs, and the
  conversation the desktop treats as on screen.
- Test: `apps/app/tests/workbench-panel-session.test.ts`.

## Older desktop builds

Desktop builds that still read `sideChatPanel` get a fixed `true` from the
features response, so their panel follows the side chat too. Stored overrides
and operator locks for the key are ignored.
