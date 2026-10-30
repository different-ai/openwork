# Session offloading

OpenWork owns **where work is sent and how its outcome is recovered**. The
local harness owns **how a native session is created and driven**. Offloading
is not an Automation, a Cloud worker, or an alternative session engine.

## Boundaries

```text
MCP client / Slack / Workbot / another chat client
  → OpenWork remote-session capabilities
  → owner-scoped target inventory + durable command/request receipts (Den)
  ← outbound registration, discovery, claim, completion and progress
  → @openwork/remote-sessions: local journal, outboxes, reconciliation
  → local adapter: native OpenCode or OpenWork workspace session APIs
```

| Owner | Responsibility | Does not own |
| --- | --- | --- |
| Den | Authenticated member/organization scope, target selection, durable admission, sticky claims, immutable completion, readable status | Native session engine, local permissions, tool execution |
| `packages/remote-sessions` | Journal-before-effect ordering, native session receipts, stable turn IDs, retryable acknowledgements, progress reconciliation | Electron, OAuth, scheduling, workspace filesystem discovery |
| OpenCode plugin adapter | Map to the **same** plugin host's `session.create/prompt/context/interrupt`, model inventory and permissions | A second OpenCode service, an inbound tunnel, automatic approvals |
| Desktop adapter | Map to the selected local workspace/engine through the existing session client | Den scheduling or a parallel desktop session database |
| Calling surface | Task, target choice, status presentation, trusted return-to-origin delivery | Runner credentials or permission bypasses |

A future harness implements the adapter port. Another chat client consumes the
same remote primitives. Neither requires copying the queue or inventing a new
remote session lifecycle.

## Registration and access

- New registrations use `/v1/session-runners/token`, `/work`, and `/inventory`.
  They remain available independently of the Automation runtime.
- Standalone `opencode-openwork` uses the existing approved OpenWork account.
  It requires explicit `remoteSessions: true`; signing in for models or MCP
  connections alone does not authorize remote control.
- Registered offloading is available on Cloud and self-hosted installs; there
  is no rollout switch.
- Runner tokens are time-limited, audience-bound credentials. Every runner
  request rechecks the owner's active membership. Credentials are not stored
  in execution journals.
- A standalone Location registers only its approved directory. The local
  ownership guard prevents two hosts from concurrently owning that target.
- Remote-only registrations cannot advertise presence or claim scheduled
  Automation work. Released desktop routes/capabilities stay compatible.
- Runner installation IDs are scoped by organization and member for computer
  discovery. A raw install ID is never sufficient authority to complete or
  control another member's command.

## Caller primitives

1. `remote-session:targets`: discover computers, workspaces, presence and models.
2. `remote-session:create`: `target: "registered"`, a `computerId` and the task.
   A single available computer can be selected automatically; multiple computers
   require an explicit choice. No Cloud worker or Web entitlement is needed for
   the registered-target surface.
3. `remote-session:read` with `commandId`: inspect durable delivery and progress.
   Delivery is not task completion. `session.status` distinguishes running,
   waiting, idle and error. Approval remains in the native client.
4. `remote-session:read/send/stop` with the native `sessionId` and workspace:
   route control requests back to the owning runner. A pending request returns
   `requestId`; reading that ID collects its eventual receipt.
5. `remote-session:list`: inspect the caller's admitted local sessions.
6. `remote-session:status` (behind `remoteSessionSubagents`): follow up to ten
   sessions in one call, desktop and registered ones by `commandId`, Cloud ones
   by `sessionId`. Each result is a compact state (`starting`, `running`,
   `waiting` with `waitingFor`, `idle` with a short answer preview, `error`) and
   a version. A caller passes back the versions it holds, so an unchanged
   session costs its ref and version only, and `waitMs` (up to 20 s) holds the
   call until one changes. Settled sessions end the wait at once. A desktop
   command is one indexed read of the receipt its runner already reports; a
   Cloud session is a small worker read of its last messages, run state and,
   only while it runs, pending requests. Use `read` for the transcript.
   While a session runs or waits, `latestStep` is a short sentence for the
   step it ran last (`Ran List the release notes`, `Read v1.1.md`). Desktop
   runners compute it from the current turn's last tool call and send it with
   their progress report (`latestStep`, ≤240 chars, optional on the wire;
   Den stores it in `session_latest_step`); Den derives it for Cloud sessions
   from the tail it already reads (`latestStep()` in
   `packages/headless-threads`). Older runners omit it and Den answers null.
   A new step changes the version, so followers see it on their next wait.
7. `remote-session:answer` (behind `remoteSessionAnswers`): answer the question
   or permission a session waits on, with the `requestId` from `pending`.
   Questions take the chosen option labels per question (free text only where
   the question allows it); permissions take `once` or `reject`, never
   `always`. Only the member's own chat lists it (never an Automation, Workflow
   run or App), and its instructions require asking the person first, every
   time, as a chat answering another local session's question does.

Cloud remains the default create target and retains its existing access and
worker lifecycle. `target: "desktop"` and legacy wire names stay compatible.
The native session ID is a local receipt, not a globally trusted routing key.

Use a stable `idempotencyKey` for desktop/registered create retries. Den scopes
it to the authenticated organization and user and refuses different arguments
under the same key. Cloud creation does not currently support this argument;
callers must not infer a guarantee from an ignored key.

The desktop chat shows a session its agent started as a sub-agent row: where
it runs, whether it is working, waiting on the person or finished, and its
answer. Its routes under `/v1/remote-sessions/` run these same capabilities
with the member's own session. One loop in the app follows every shown
session with one waiting `status` call at a time, not while the window is
hidden or offline, and stops once they settle. Stop on the row goes through
`stop`. Without `remoteSessionAnswers`, answering a pending permission or
question stays on the computer that runs the session.

Three features roll this out in steps, all on Cloud and self-hosted and off by
default:

- `remoteSessionSubagents`: the row, its progress, Stop, the sidebar's
  needs-you marker, and the Den routes and `status` capability behind them.
- `remoteSessionThreadView` (needs the first): clicking the row opens the
  session's conversation beside the chat. The transcript is read only while
  it is open, when the status changes; follow-ups go through `send`. Off, the
  row shows progress only and a conversation tab left open from before says
  the view is turned off. Den routes stay behind `remoteSessionSubagents`:
  Stop also reads a slow desktop's pending receipt through `read`.
- `remoteSessionHelperView` (needs both): the row reads as a sentence
  (`Working on <computer> · <task>`, then `<elapsed>, last ran: <latestStep>`)
  and opens the session in the main pane under the session route
  `remote:<threadKey>`, like a local helper. The app never treats that id as
  a local session: the route state reads it as "no local session" plus a
  remote task, so no engine call uses it. Enter sends a follow-up through
  `send`, Stop goes through `stop`, and Esc returns to the parent chat
  through the same `child-navigation.ts` return as local helpers. The task
  and its parent are kept per window in sessionStorage so a reload on the
  route still renders it. With `composerSubagentTracker`, the composer's
  Agents list shows the turn's remote tasks beside local helpers (computer,
  task, status word, Open, Stop) on either engine, from the same shared
  follower. The sidebar also lists followed tasks under their chat with a
  status word. Off, everything is as with the first two.

### Transcript steps

A `read` page's messages keep `text` and `toolCalls` for older readers and,
from current runners, add an ordered `parts` array plus `completedAt`:

- `{ type: "text", text }`
- `{ type: "reasoning", text, durationMs? }`
- `{ type: "tool", id, name, status, title?, input, output, error, truncated, startedAt?, endedAt? }`

Caps match the rest of the page: at most 200 parts per message, 2000
characters per tool field (`truncated` marks a cut), text and reasoning
sharing one 20,000-character budget per message (reasoning parts at most
4,000), and the whole result under 256 KB. Desktop runners
(`automation-runner.mjs`), the OpenCode plugin (`native-opencode.ts`) and the
Cloud `read` (`remote-session-transcript.ts`, from `@openwork/headless-threads`
part order and tool state) all send this shape; Den stores and returns it
unchanged. A runner that omits `parts` still parses, and readers rebuild steps
from `toolCalls` then `text`.

With `remoteSessionThreadView` on, the panel maps parts to the chat's message
parts (`remoteTranscriptToUIMessages`) and renders them with the main chat's
`MessageList`, read only: each tool step gets the local labels, the finished
turn folds to "Worked for…", and a failed step stays open with its details.
The agent's own status checks stay hidden, as in the chat.

Slack uses the same capabilities and trusted run-token provenance to post a
result back to its originating thread. A model cannot choose an arbitrary
notification destination. Workbot and other MCP-backed chats use the same
owner-scoped targets and receipts, without a separate registration mechanism.

- `remoteSessionAnswers` (needs the first): the person answers the question or
  permission a task waits on from its row (single-choice questions) or the card
  above the conversation's follow-up box, through
  `POST /v1/remote-sessions/answer` (owner-only).

### Pending requests and answers

A runner that registers `remote_session_answer_v1` reports what a waiting
session waits on as `pending` in its progress and transcript reads:
`{ kind: "question", requestId, questions: [{ header, question, options: [{ label, description }], multiple, custom }] }`
or `{ kind: "permission", requestId, title, detail, command? }`. It is plain
text from the other computer; clients never render it as links or run it. Den
stores it with the command's progress, and `status` returns a short summary
(question and option labels, or the permission's title) whose `requestId`
changes the version. Cloud sessions read the same shape from the worker's
pending lists while they run.

An `answer` request reaches only such runners; older ones are refused with
`answer_unsupported` before anything is queued. The runner journals it like a
follow-up, idempotent by the pending `requestId`: the marker is durable before
the native reply, and a replay that finds the request gone reports it answered
rather than replying again (a native request is answered at most once). The
adapter checks the answer against the live request and refuses a stale
`requestId` (`stale_request`) or a misfit answer (`invalid_answer`). Desktop
replies through the same native paths as a local chat: v1 question and
permission replies, v2 form replies by field key and option value, v2 permission
replies. The OpenCode plugin host has no question reply in 2.0.26, so
`opencode-openwork` answers permissions only. An answer request that expires
after its reply was dispatched settles as `ambiguous_answer`.

## Recovery and honest guarantees

- Claims are **sticky to the original runner**, not reassigned to another
  computer after a disconnect. Reassignment could duplicate a native session.
- Recovery-capable runners rediscover their own claimed work. Released runners
  continue receiving the older pending-only protocol.
- Persist the prepared command **before** native creation. Persist the native
  session receipt **before** initial prompt admission. Persist completion and
  control results **before** acknowledging them remotely.
- Stable command/request-derived `msg_` IDs make native V2 prompt admission
  replayable when the adapter opts into that guarantee. Mixed V1/V2 desktop
  adapters conservatively treat uncertain sends as `ambiguous_send` rather
  than retrying a potentially admitted V1 prompt. Keep the original request immutable: native deduplication does
  not compare prompt text for the same ID.
- Native OpenCode V2 creation supports a deterministic `ses_` ID. The adapter
  verifies the returned ID, directory and ownership metadata before accepting
  it. A creation retry therefore returns the same native session.
- A harness without idempotent native creation must stop with inspectable
  `ambiguous_creation` after an uncertain create. Do not pretend every harness
  can safely replay effects; inspect locally rather than blindly creating again.
- Expiry controls claim/admission, not whether the sticky owner can report an
  effect that already happened. Late receipts recover successful work without
  rerunning it. Terminal completion is immutable; an identical retry is safe.
- Token renewal changes transport credentials, not the execution journal or
  session identity. Reconciliation restores observation after restart.
- Persisted outboxes survive dropped responses. A transport failure is not
  evidence that the native operation failed.

These boundaries provide idempotent admission and recoverable receipts; they
**do not promise exactly-once model execution or tool side effects**. Legacy V1
native prompt and create APIs have weaker guarantees than V2.

## Inspection and shutdown

Den command/request reads remain available while a computer is offline. Local
journal inspection records prepared/created/completed work and outstanding
acknowledgements; desktop journals use atomic, owner-only files. Native sessions
remain visible in their originating harness.

OpenCode's plugin `context` API reads only history since the latest compaction.
Its transcript responses identify `historyScope: "context"`; missing historical
context is not a session error. Native status events are live hints, not a
replayable source of truth. Recovered observation uses native session/context
and permission state rather than an in-memory event alone.

Runner unload/account switch stops its control loop and releases ownership;
normal native permission handling is never bypassed.

## Following progress: polling, not events

MCP callers follow a remote session by polling its durable receipt
(`remote-session:status` with `waitMs`, or `remote-session:read`). There are no
receipt resource subscriptions or change notifications; reads always return the
current durable state, which also covers reconnects and other replicas.
