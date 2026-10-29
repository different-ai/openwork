# Settle finished sessions (`settledSessions`)

- **Feature key:** `settledSessions`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

In OpenCode v2 workspaces, a finished session can be settled. It leaves its
group list in the sidebar and collapses into a **Settled** row at the end of its
workspace, still one click away. Any new activity (a reply, a finished run, an
Automation, an approval request) brings it back.

- Settle or Un-settle from the row's hover actions and menu, the thread header,
  the command palette, or Cmd/Ctrl+Shift+E. Each shows Undo.
- Idle sessions settle on their own after 3 days unless pinned, unread, working
  or waiting. Settings › Preferences › "Settle idle sessions after" changes it
  (Never, 1, 3 or 7 days).
- OpenCode v1 workspaces keep today's sidebar.
- A **Workspaces · Feed** switch replaces the Workspaces label. Feed lists every
  workspace's sessions in one stream: **Needs you** first, then Today,
  Yesterday and Earlier by last activity. Each row has a second line with its
  workspace and group, and what it is doing or how long ago it was active.
  Settled sessions from every workspace sit in a collapsed **Settled** shelf.
  Pinned folders, Settled and Archived stay fixed below the scrolling Feed,
  apart from live work; one opens at a time, showing about three rows that
  scroll. The choice of view is remembered on the device.
- In Feed, the header's **+** starts a new session, and the group-and-sort
  menu next to it groups by day, by activity (**Active**: working or with an
  unread result; **Inactive**: the rest) or not at all, and sorts by last
  activity or creation time. Needs you stays on top either way; the choice is
  remembered on the device. Workspaces view keeps its Add workspace **+**.
- Any workspace group can be pinned to the bottom of the Feed (the pin in the
  group's hover actions in Workspaces view). Sessions filed in a pinned group
  stay there, even with new activity; the folder shows a dot when something
  inside is unread or needs you. When a session's workspace has pinned groups,
  its ✓ button offers Settle or Move to each of them.

## How it works

Settled is derived from each session's activity time, not stored as a flag
(`apps/app/src/react-app/domains/session/sidebar/session-settle.ts`, tested in
`apps/app/tests/session-settle.test.ts`). Manual settles live on the device in
the session-management store, like pins. OpenCode v2 does not move a
session's time when a message is sent, so the sidebar also counts work starting
on this device as activity (`noteActivity`). `session-route.tsx` resolves the
feature once; when it is off, no workspace can settle.

## Turning it off

The kill switch puts every settled session back in its group list right away.
Nothing is deleted: the device keeps its settle records, and turning the feature
back on restores them.

## Screenshots

Not captured yet; add them from the real app before turning this on beyond our
own organization.
