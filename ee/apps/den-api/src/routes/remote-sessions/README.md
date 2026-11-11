# Remote session routes

The signed-in member's own remote sessions, for OpenWork's apps:

- `POST /v1/remote-sessions/status`: compact, batched, versioned status of up to ten sessions, with an optional bounded wait.
- `POST /v1/remote-sessions/read`, `/send`, `/stop`: transcript pages, follow-ups and stop.
- `POST /v1/remote-sessions/answer`: the member's answer to a question or permission a session waits on, or `kind: "dismiss"` to close a question without answering it.

Each route runs the `remote-session:*` capability agents call through MCP
(`src/mcp/remote-session-capabilities.ts`), so apps and agents share the same
receipts and rules. These routes are generally available without rollout
flags, and are not exposed to MCP as separate tools (`x-mcp: false`).

## Sessions on my computers (feature `remoteSessionAccess`)

Off, everything above works as before: a caller reaches only sessions that were
started remotely. On, a member can also reach sessions that were started on
their own computers:

- `GET /v1/sessions`: the member's computers and sessions, newest first. A
  session is `reachable` (through a delivered command), `connecting` (a start
  or an attach is queued) or `attachable` (the computer reported it).
- `POST /v1/remote-sessions/attach`: queues an attach command for one reported
  session, or returns the command that already reaches it. Agents call the same
  code as `remote-session:attach`, only in a chat with the person.
- `GET` and `PATCH /v1/org/remote-session-settings` (`src/routes/org/remote-session-settings.ts`):
  the organization's ceiling, `created` (default) or `all`. Any member reads it; changing it
  needs Edit organization settings (`organization.update`), like the other organization settings.
- `PUT /v1/session-runners/sessions` (`src/routes/session-runners`): a computer
  reports the access its owner chose and, while that is `all`, its sessions.

The rules, all read through `src/remote-sessions/access.ts`:

- What applies on a computer is the narrower of the organization's ceiling and
  its owner's choice. The ceiling is `created` while the feature is off.
- The computer enforces it, and so does Den. Den refuses an attach, and
  refuses read, send, stop and answer for a session that was reached through
  an attach, with `session_access_denied` unless both currently allow every
  session. Sessions started remotely are never affected. Status keeps
  answering with the last known state.
- Everything is scoped to the caller's own computers and commands. Another
  member's computer answers `unknown_computer`, like one that does not exist.
- Only runners registered with `remote_session_access_v1` are sent attach
  commands (`remote_session_attach` work items) or dismissals; older apps get
  `desktop_update_required` and `answer_unsupported`.
- While the ceiling is `created`, Den keeps no reported sessions: a report is
  stored as `created` with an empty list, and lowering the ceiling drops the
  lists already stored.
- An attach is let go of ("detached") when it stops being the way to reach its
  session: its computer reports `created`, the organization lowers the ceiling
  to `created`, or the computer answers a request through it with
  `unknown_receipt` (it no longer holds the attach). The command is settled as
  `failed` with error code `detached` (`src/remote-sessions/commands.ts`) and
  keeps none of the session's content. Requests for that session then answer
  `session_access_denied` while access is withdrawn and `session_unavailable`
  ("This session is no longer connected. Connect to it again.") otherwise;
  status answers `error` with code `detached`; the session is `attachable`
  again where its computer still reports it and both still allow it; and the
  next attach is a new command. A command that started a session remotely is
  never detached.
