# A side chat's pages show beside it (`sideChatPanel`)

- **Feature key:** `sideChatPanel`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

The browser and files panel follows the chat you are working in. When the
chat in the split pane opens a page or a file, the panel shows it beside that
chat. Click back into the main chat and the panel shows the main chat's pages
again.

With the feature off, the panel only ever shows the main chat's pages. A page
opened from the split pane loads out of sight until that chat is moved into
its own chat. A file opened from the split pane shows in the main chat's
panel, so the click never opens an empty panel.

## Rules

- The split pane's chat takes the panel only while it is the chat you are
  working in and it has a page or file to show. Until then the main chat's
  panel stays as it is.
- Closing the panel while it shows the split pane's pages closes the panel.
- A draft chat and a chat from another workspace never take the panel.

## Where it lives

- `apps/app/src/react-app/domains/session/chat/workbench-panel-session.ts`
  picks the conversation the panel shows.
- `apps/app/src/react-app/domains/session/chat/session-page.tsx` reads the
  flag and uses that conversation for the panel, its tabs, and the
  conversation the desktop treats as on screen.
- Test: `apps/app/tests/workbench-panel-session.test.ts`.
