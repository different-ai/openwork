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
- `remoteSessionTargets` is off by default for Cloud and self-hosted installs.
  Den's ordinary feature resolver controls admission; no second rollout system.
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

Cloud remains the default create target and retains its existing access and
worker lifecycle. `target: "desktop"` and legacy wire names stay compatible.
The native session ID is a local receipt, not a globally trusted routing key.

Use a stable `idempotencyKey` for desktop/registered create retries. Den scopes
it to the authenticated organization and user and refuses different arguments
under the same key. Cloud creation does not currently support this argument;
callers must not infer a guarantee from an ignored key.

Slack uses the same capabilities and trusted run-token provenance to post a
result back to its originating thread. A model cannot choose an arbitrary
notification destination. Workbot and other MCP-backed chats use the same
owner-scoped targets and receipts, without a separate registration mechanism.

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

Turning off `remoteSessionTargets` prevents new registered offloads/turns. It
must not hide existing receipts or prevent stopping an admitted session.
Runner unload/account switch stops its control loop and releases ownership;
normal native permission handling is never bypassed.

## MCP events: optional observation, separate rollout

A separate stacked `remoteSessionEvents` feature adds caller-facing receipt
resource invalidations, not runner dispatch. Current MCP `subscriptions/listen`
uses a POST-response SSE stream with explicit URI filters; it is not a durable
queue and has no `Last-Event-ID` replay. After acknowledgement or reconnect,
read the current durable receipt. Polling remains a fallback.

Notifications contain only an authorized resource URI. Ownership and live
credential/membership checks are required for both subscription and read.
Process-local notifications alone cannot establish multi-replica delivery;
active watchers must observe the shared durable receipt. The OpenCode plugin's
public MCP API does not expose arbitrary URI subscriptions, so this layer does
not turn native runners into an event-driven dispatch system.
