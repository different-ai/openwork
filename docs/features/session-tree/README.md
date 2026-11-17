# Sessions started from a session (`sessionTree`)

- **Feature key:** `sessionTree`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

A session can start other sessions. With the feature on, those sessions stay
attached to the one they came from instead of becoming unrelated rows.

| | Who starts it | What it knows | Reports back | Where it is listed |
|---|---|---|---|---|
| **Side chat** | The person: **Open side chat**, or select text in a reply and choose **Start a side chat** | Nothing yet, plus a pointer to the main session, which it can read | No | Under the session |
| **Session the agent starts** | The session's agent, with `session.create` | Only the task it was given | Yes, each time it finishes a turn | Under the session |
| **Branch** | The person: **Branch in new chat** | A copy of the conversation up to a message | No | A row of its own, as before |

- **Sidebar.** A side chat or a session the agent started is listed under the
  session it came from, one step in, joined by a thin rail. This holds in the
  Workspaces view, the Feed and Pinned. A session started from a nested
  session sits one step further in; the tree is two levels deep.
- **A way back.** An open nested session shows **Back to _parent title_** in
  the header, the same control sub-agent chats have.
- **Start a side chat from a reply.** Selecting text inside one reply shows a
  small **Start a side chat** bar above the selection. It opens a side chat
  beside the session with the text quoted in the message box; nothing is sent
  until the person sends it. Text already typed in an open side chat draft is
  kept, with the quote added under it.
- **Reports.** When a session the agent started finishes a turn, the session
  that started it gets a note. The chat shows it as one row, for example
  "Session finished · Fix the login redirect", which opens that session. The
  agent reads the session's last reply (up to 4,000 characters) and can
  answer with `session.send`.

## How it works

- **The link** is `openworkSessionLink: { kind: "side" | "sub", parentID }` in
  the OpenCode session's metadata, written when the session is created. The
  engine keeps it with the session, so every window and device agrees. Only
  the v2 engine keeps session metadata; on v1 nothing is linked.
- The engine copies a session's metadata to its sub-agent sessions and forks.
  Those copies are not links: the app honors the key only on a session the
  engine lists as top level.
- **Limits on linking.** Same workspace only. Nothing links below the second
  level; a session started there is an ordinary session.
- **Rows.** A pinned session stays in Pinned rather than under its parent. If
  the parent is archived or deleted, the session gets a row of its own again.
  Deleting or archiving a session never deletes or archives the sessions
  listed under it.
- **Sessions the agent starts.** Before creating sessions, the server asks the
  app's `session.tree` query whether the calling session can be a parent
  (`canStartLinked`). The app registers that query only while the feature is
  on, so off means no links. A linked result carries `linked: true` and one
  line telling the agent that reports will come and not to poll.
  `session.tree { sessionId }` also lists the sessions started from a
  session, with kind, depth and status.
- **Reports** follow the engine's own format for a finished background
  sub-agent: a synthetic message with `source: "openwork-session"`, the
  session's id and how the run ended (`completed`, `error`, `cancelled`).
  - The note's id comes from the engine's record of when the run ended, so
    two windows that notice the same finish add one note.
  - A report starts the parent's next turn only when the parent's agent asked
    for that turn (the prompt carries `openworkSentBy`), this window saw it
    run, and no other session that parent started is still running or
    waiting. Otherwise the note waits for the parent's next turn. A turn the
    person typed in a nested session never starts the parent.
  - A parent is started by reports at most 12 times an hour. A finish older
    than 24 hours is not reported after the fact.
  - Reports are sent by an open app window, for the workspace it has
    selected. A session that finishes while no window is on that workspace is
    reported, without starting the parent, the next time one is.

Code: `packages/types/src/session-link.ts` (the link),
`apps/app/src/react-app/domains/session/sidebar/session-tree.ts` (the tree),
`.../session/links/` (reports and the selection bar),
`.../session/control/session-tree-query.ts` (the query), and
`createOpenWorkSessions` in
`apps/server/src/opencode-plugins/openwork-extensions-preview.ts`.

## Turning it off

With the feature off, or after the kill switch, the sidebar is flat again:
every session has its own row, and an attached side chat is hidden while
attached, as before. Nothing is deleted. Links stay in session metadata and
the rows nest again if the feature comes back. No new links are written, the
selection bar and `session.tree` go away, and no reports are sent. Notes
already in a chat stay readable as rows.

One thing is written whether the feature is on or off: a message an agent
sends with `session.create` or `session.send` on the v2 engine records the
sending session as `openworkSentBy` in that message's metadata. Nothing shows
it.

## How to try it

1. Turn `sessionTree` on for an organization in `/admin` › Features.
2. In a session, select part of a reply and choose **Start a side chat**.
   Send the message: the side chat appears under the session in the sidebar.
3. Ask the session to "start two sessions, one to list the open questions and
   one to draft a summary, then tell me what they found". Both appear under
   the session, and each adds a "Session finished" row when it is done.

## Not shown or not covered yet

- No screenshot: the feature has not been run in the desktop app yet.
- Branches are not listed under the session they were branched from.
- Cloud workers and other hosts with no app window link nothing and send no
  reports.
