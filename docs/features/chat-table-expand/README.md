# Expand a table in chat (`chatTableExpand`)

- **Feature key:** `chatTableExpand`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

Answers often put a comparison, a plan or a list of pull requests in a table.
In the chat column a table with several long columns wraps every cell onto
many lines and is hard to read.

With the feature on:

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
- The chat view passes the flag down through `MarkdownTableExpand`
  (`apps/app/src/components/markdown/markdown.tsx`). Where the flag is off,
  or outside the chat view, the button is hidden and ignored.
- Opening the window renders that Markdown again with the same chat Markdown
  component, so the table looks and behaves as it does in the answer.

## Turning it off

Nothing is stored. With the flag off the button disappears on the next
render and an open window stays open until it is closed. Tables look as they
did before.

## What to watch

Nothing new is logged. The first use per person is reported with the usual
feature-used signal (`markFeatureUsed("chatTableExpand")`).
