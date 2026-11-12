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
  or an attach is queued) or `attachable` (the computer reported it). Also
  served with `remoteTasksOptIn` alone, without attachable sessions.
- `POST /v1/remote-sessions/attach`: queues an attach command for one reported
  session, or returns the command that already reaches it. Agents call the same
  code as `remote-session:attach`, only in a chat with the person.
- `GET` and `PATCH /v1/org/remote-session-settings` (`src/routes/org/remote-session-settings.ts`):
  the organization's ceiling, `off`, `created` (default) or `all`. Any member reads it; changing it
  needs Edit organization settings (`organization.update`), like the other organization settings.
  See "Tasks from other devices, per computer" below for `off` and for when the routes exist.
- `PUT /v1/session-runners/sessions` (`src/routes/session-runners`): a computer
  reports the access its owner chose and, while that is `all`, its sessions.

The rules, all read through `src/remote-sessions/access.ts`:

- What applies on a computer is the narrower of the organization's ceiling and
  its owner's choice. A stored ceiling of `all` reads as `created` while the feature is off.
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

## Tasks from other devices, per computer (`off`, feature `remoteTasksOptIn`)

Access has three modes, narrowest first: `off` (nothing reaches the computer:
no task is started there and no session read, continued, stopped, answered or
attached), `created` and `all`. The same rule in `src/remote-sessions/access.ts`
decides it everywhere:

- The owner chooses per computer in the desktop app, which reports what applies
  through `PUT /v1/session-runners/sessions`. Only an app with
  `remote_session_choice_v1` can say they chose (`chosen: true`), turn the
  computer off, or leave it unchosen. Den keeps such an app's access only once
  it is chosen; until then the default applies: `created`, or `off` with the
  organization's opt-in (`remoteTasksOptIn`).
- An app without that capability reports `created` or `all` by itself, which
  is not its owner choosing. Without the opt-in it is honoured as it always
  was. With the opt-in the computer is `off` whatever it reports, until the
  app is updated, and Den keeps `created` at most and none of its session titles.
- The organization's ceiling may be `off`: nobody's computer takes anything.
  A stored `off` applies whatever the features say.
- Runners with `remote_session_access_v1` or `remote_session_choice_v1` are
  told `sessionAccess: { ceiling, optIn }` in the work response, and their
  reports are taken, while `remoteSessionAccess`, `remoteTasksOptIn` or
  `remoteDevices` is on for the member or the ceiling is `off`. Den never
  stores more than the ceiling allows, and a report stored as anything but
  `all` keeps no sessions and detaches the runner's attaches. Attach commands
  still go only to runners with `remote_session_access_v1`.
- Device records (`GET /v1/remote-devices`, `/v1/org/computers` and the routes
  that return one device, `src/remote-devices.ts`) carry `remoteAccess` for a
  signed-in desktop that takes tasks: `effective`, `chosen` and `reason`
  (`organization`, `update_required`, `not_chosen` or null), worked out by the
  same rule under the owner's own policy. The team list reads the policies of
  a page's owners in one batch.
- `GET` and `PATCH /v1/org/remote-session-settings` exist while `remoteDevices`,
  `remoteSessionAccess` or `remoteTasksOptIn` is on. The response adds
  `allowsAll` and `optIn`; `PATCH` with `all` answers `409 feature_disabled`
  (`feature: "remoteSessionAccess"`) without that feature.
- A computer that is `off` answers `409 remote_access_off` (not retryable,
  nothing queued) to `create` naming it, to `read`, `send`, `stop` and `answer`
  for any session on it, to a read by the `commandId` of such a session, and to
  `attach`. The message says who can allow it: the organization, the owner in
  Settings > Devices on that computer, or the owner after updating OpenWork there.
- `create` without a `computerId` never picks a computer that is off; when all
  of the member's are, it answers `remote_access_off`. A desktop task that any
  of the member's computers could take is addressed to one that takes tasks
  while another of them is off.
- `remote-session:targets` keeps listing every computer with its effective
  `access`. `GET /v1/sessions` (also served under the opt-in alone) says
  `chosen`, `access` and `effectiveAccess` per computer and `optIn` for the
  list. It and `remote-session:list` leave out the sessions on a computer that
  is off; status keeps answering with the last known state.
- A task that was already queued when its computer turned off is failed by the
  computer with error code `remote_access_off`, which reads and status show as is.

## Disconnected computers

A signed-in desktop can be disconnected from its organization
(`src/computer-disconnect.ts`): by its owner with
`POST /v1/remote-devices/:deviceId/disconnect`, or by someone who holds
Disconnect team computers (`computers.disconnect`, recent sign-in) with
`POST /v1/org/computers/:deviceId/disconnect` (`src/routes/org`). From then on:

- Den refuses that install. `POST /v1/session-runners/token` and
  `/v1/automation-runners/token`, every runner route and
  `PUT /v1/remote-devices/this-computer` answer `403 computer_disconnected`.
  A runner route never answers it with the `401` that makes a desktop mint
  another credential. An open notification stream ends at its next check.
- Its runner registration is deleted, so `remote-session:targets`,
  `GET /v1/sessions` and the Automation targets no longer list it.
- The attaches it delivered are detached. Commands it had claimed or that were
  addressed to it, and the requests waiting for it, are settled as `failed`
  with error code `computer_disconnected`. An Automation run it holds has its
  lease ended, so the scheduler retries or fails it like any lost lease.
  Sessions that were started remotely on it keep their delivered command.
- `read`, `send`, `stop` and `answer` for a session on it, `attach`, and
  `create` naming it as `computerId`, answer a non-retryable
  `409 computer_disconnected` ("That computer was disconnected from your
  organization. Sign in on it again to reach it.").
- Where Den knows the sign-in session the desktop used, and it is not the one
  making the request, that session is ended (`session.revoked`, reason
  `computer_disconnected`), so OpenWork there is signed out.

Signing in on the computer again connects it again: the first credential
request or report that comes with a session created after the disconnect
deletes the disconnection. Nothing else does.
