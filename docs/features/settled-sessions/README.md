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

## How it works

Settled is derived from each session's activity time, not stored as a flag
(`apps/app/src/react-app/domains/session/sidebar/session-settle.ts`, tested in
`apps/app/tests/session-settle.test.ts`). Manual settles live on the device in
the session-management store, like pins. `session-route.tsx` resolves the
feature once; when it is off, no workspace can settle.

## Turning it off

The kill switch puts every settled session back in its group list right away.
Nothing is deleted: the device keeps its settle records, and turning the feature
back on restores them.

## Screenshots

Not captured yet; add them from the real app before turning this on beyond our
own organization.
