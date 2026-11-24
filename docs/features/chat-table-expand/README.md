# Expand a table in chat

- **Status:** generally available; `chatTableExpand` was retired in November 2026.
- **Deployments:** cloud and self-hosted
- **Author:** @reachjalil

## What people get

Answers often put a comparison, a plan or a list of pull requests in a table.
In the chat column a table with several long columns wraps every cell onto
many lines and is hard to read.

In the chat view:

- Hovering a table in a chat answer shows an **Expand table** button at its
  top right (on touch screens the button is always shown).
- The button opens the table in a wide window, up to 1400 px or nearly the
  whole screen, so each row fits on a line or two. On a narrow window it
  opens as a sheet from the bottom, like other dialogs.
- Links, file paths and code in the table work the same way as in the chat.
- **Esc**, the close button or a click outside closes the window.

Tables in file and artifact previews are unchanged.

## How it works

- The chat Markdown renderer wraps each table in `[data-openwork-table]` and
  adds a button that keeps the table's own Markdown
  (`apps/app/src/components/markdown/markdown-primitive.ts`).
- The chat view wraps its messages in `MarkdownTableExpand`
  (`apps/app/src/components/markdown/markdown.tsx`). Outside the chat view
  the button is hidden and ignored.
- Opening the window renders that Markdown again with the same chat Markdown
  component, so the table looks and behaves as it does in the answer.

## Older desktop builds

Desktop builds that still read `chatTableExpand` get a fixed `true` from the
features response, so they keep the expand button too. Stored overrides and
operator locks for the key are ignored.

## What to watch

Nothing is stored and nothing new is logged.
