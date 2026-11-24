# Select several sessions in the sidebar (`sessionMultiSelect`)

- **Feature key:** `sessionMultiSelect`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

Sidebar rows can be selected together, the way files are in Finder or
Explorer, so one action applies to all of them.

| Gesture | Result |
|---|---|
| Cmd-click (macOS) or Ctrl-click (Windows, Linux) | Adds the row to the selection, or takes it out. The open session joins the selection when one starts. |
| Shift-click | Selects every row from the last clicked row (or the open session) to this one, as listed on screen. |
| Plain click | Opens the session and clears the selection. |
| Escape, or the X in the selection bar | Clears the selection. |

While two or more rows are selected:

- They are highlighted and a bar at the bottom of the session list says how
  many are selected, with **Archive N sessions** (or **Unarchive** when all of
  them are archived) and a button to clear the selection.
- Right-clicking a selected row, or its More menu, acts on the whole
  selection: **Pin / Unpin N sessions**, **Move to group** (only when every
  selected row is in one workspace), **Archive / Unarchive N sessions** and
  **Clear selection**. Rows that are not part of the selection keep their own
  menu.
- Archive runs each session through the same checks as archiving one: a
  session that is still working asks before it is stopped, and declining
  skips only that session. One toast reports how many were archived and
  **Undo** restores all of them.

Rename, delete and side chat stay single-session actions.

## How it works

- `session-selection-store.ts` holds the selection (workspace id + session id
  per row) in memory; it is not saved. Range order is read from the rendered
  sidebar rows, the same way the number shortcuts find rows. In the Feed only
  rendered rows can be part of a range.
- `useSessionArchive().archiveSessionsInWorkspaces` archives or restores rows
  one after another and collects them for one undo toast.

## Turning it off

With the feature off, Cmd/Ctrl/Shift-clicks open the session as before, any
selection is cleared and the bar and bulk menu disappear. Nothing is stored,
so nothing needs cleaning up.

## What to watch

- Archive errors are shown per session, as for a single archive.
- Usage is recorded with `markFeatureUsed("sessionMultiSelect")` on the first
  selecting click.
