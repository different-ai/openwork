# Remote Chat over MCP — sessions on another surface via the OpenWork MCP Gateway

Status: proposal
Owner: TBD
Related: `docs/marketplace-capabilities-architecture.md`, `ee/apps/den-api/src/mcp/README.md`

Covers two execution targets behind the same gateway capabilities:
`target: "cloud"` (session on the member's OpenWork Web cloud worker) and
`target: "desktop"` (session on one of the member's signed-in desktop apps,
dispatched over the existing Desktop Automation runner channel).

## Problem

OpenWork Desktop and OpenWork Web are both live chat surfaces, but they cannot
talk to each other. A member working in a desktop chat has no way to start or
continue a conversation that runs on their OpenWork Web cloud worker — for
example to hand long-running work to the cloud, to make a session visible to
teammates in the browser, or to keep work running after the laptop closes.

At the same time, the MCP gateway (`/mcp/agent`) is the sanctioned way to
extend what agents can do org-wide, and desktop already attaches it to every
workspace engine. Anything we build as a gateway capability works from desktop
**and** from every external MCP client (Claude Code, Codex, Cursor) for free.

## Goal

From a desktop chat (or any MCP client connected to the gateway), the agent
can:

1. Create a chat session on the member's OpenWork Web cloud worker.
2. Send prompts to it.
3. Read back status and transcript.
4. Hand the member a link/card to open that session live in OpenWork Web.

Non-goals (v1):

- Streaming token-by-token output back over MCP (poll/read instead).
- Cross-member or cross-org sessions. Everything is scoped to the signed-in
  member's own worker.
- A new chat UI. OpenWork Web renders the session with its existing UI because
  the session is a native openwork-server session — no sync layer needed.

## What exists today (reused, not rebuilt)

| Piece | Where | Role in this design |
| --- | --- | --- |
| MCP gateway | `ee/apps/den-api/src/mcp/agent.ts` | Hosts `search_capabilities` / `execute_capability`; new work plugs in behind them |
| Capability registry | `ee/apps/den-api/src/mcp/capability-registry.ts` | Fan-out to capability sources — **the extension point** |
| Worker resolution | den-api `/v1/cloud/gateway/resolve` (used by `ee/apps/den-gateway/src/app.ts`) | Maps a member to their cloud openwork-server instance + auth |
| openwork-server session API | `apps/server` (`POST /workspace/:id/opencode/session`, native prompt/transcript/status routes) | The actual chat runtime on the worker |
| Programmatic session client | `packages/headless-threads` | Typed client for driving native sessions from code |
| Desktop → gateway attach | `apps/app/src/react-app/domains/connections/cloud-mcp-reconciler.ts` + `apps/server/src/routes/cloud-mcp.ts` (token mint: `POST /v1/mcp/token`) | Desktop engines already have `/mcp/agent`; zero desktop changes required for v1 |
| MCP App cards | `ee/apps/den-api/src/mcp/connection-action-app.ts` pattern + `packages/mcp-apps` | Render an "Open in OpenWork Web" card |

## Architecture

```
Desktop chat (engine)                den-api (/mcp/agent)              Cloud worker (openwork-server)
─────────────────────                ────────────────────              ──────────────────────────────
agent calls                          capability-registry
search_capabilities ───────────────▶  └─ remote-session source
execute_capability                       │ resolve member worker
 "remoteSession.create" ───────────▶     │  (cloud/gateway/resolve) ──▶ POST /workspace/:id/opencode/session
 "remoteSession.send" ─────────────▶     │                        ───▶ POST /workspace/:id/opencode/session/:id/prompt_async
 "remoteSession.read" ─────────────▶     │                        ───▶ GET  native session/message/todo/status routes
                                         └ returns result + MCP App
                                           card linking to OpenWork Web
                                                                        OpenWork Web (apps/app via
                                                                        den-gateway) shows the session
                                                                        live — same server, no sync
```

Key property: the "web MCP" is not a second MCP server. The gateway is the
single MCP surface; OpenWork Web sees the session because the session lives on
the same openwork-server the web UI already reads through den-gateway.

### 1. New capability source: `remote-session-capabilities.ts`

New file in `ee/apps/den-api/src/mcp/`, registered in
`capability-registry.ts` alongside `builtin-skills.ts` /
`native-capabilities.ts`. It contributes capabilities to
`search_capabilities` and handles their execution — **not** new top-level MCP
tools, keeping the gateway's small-constant-tool-list contract intact.

Capabilities (names indicative):

| Capability | Args | Behavior |
| --- | --- | --- |
| `remoteSession.create` | `{ target: "cloud" \| "desktop", title?, workspaceId?, instructions?, runnerId? }` | Cloud: resolve member worker, create session. Desktop: enqueue a claimable task for the member's runner (§6). Returns `{ sessionId \| taskId, target, webUrl? }` |
| `remoteSession.send` | `{ sessionId, prompt }` | Cloud: `prompt_async` to the session. Desktop: append a follow-up task bound to the same local session. Returns a receipt `{ messageId, state: "accepted" }` |
| `remoteSession.read` | `{ sessionId, since? }` | Session status + transcript slice (bounded, paginated). Cloud: read from worker. Desktop: read from Den-side task events (§6) |
| `remoteSession.list` | `{ target? }` | Member's remote sessions; for desktop also lists runner presence per machine |

Execution path inside the source:

1. Member identity comes from the already-verified MCP auth context
   (`auth.ts`) — never from arguments.
2. Resolve the worker exactly as den-gateway does (`/v1/cloud/gateway/resolve`)
   via a shared internal helper; do not duplicate resolution logic.
3. Call openwork-server using the `packages/headless-threads` client (or its
   underlying HTTP shape) with the resolved worker URL + token.
4. On the first `remote-session:create`, provision the member's workspace
   through the browser's shared `ensureCloudWorker` path. Return
   `cloud_runtime_provisioning`, `retryable: true`, and `retryAfterMs: 30000`
   while it starts. No task is queued at this stage: the agent retries create
   with the same arguments after the delay. Once ready, the normal native
   session client creates the task and submits its prompt.
   `read` and `send` never create a missing workspace; they return
   `needs_cloud_setup` with guidance to start a new task using create.

### 2. Async model

`prompt_async` returns immediately; the agent polls with
`remoteSession.read`. This matches MCP's request/response grain and avoids
holding gateway connections open. If later we want push, the gateway can add
MCP resource subscriptions on a `remote-session://` resource (pattern already
exists: `automation-index.ts`, `resource.ts`) — explicitly out of scope for v1.

### 3. MCP App card

`remoteSession.create` and `remoteSession.send` results include a standard
MCP Apps `ui://` card (pattern: `connection-action-app.ts` +
`packages/mcp-apps` renderer): session title, state, last activity, and an
**Open in OpenWork Web** link (`https://web.openworklabs.com/...` deep link,
resolved from runtime config — same origin den-web's "Web tab" uses). Clients
without MCP Apps get text fallback with the same URL.

### 4. Policy and scopes

- Gate the whole source behind a scope in `ee/apps/den-api/src/mcp/scopes.ts`
  (e.g. `remote-session`), included in first-party desktop tokens
  (`/v1/mcp/token`) and public OAuth tokens by default; org policy can turn it
  off via the existing exposure allowlist mechanics (`policy.ts` conventions).
- **Cloud entitlement**: Cloud is hosted-only (`cloud-hosting.ts`, multi-org
  deployments with a Daytona provisioner) and entitled per organization by
  OpenWork Web access — a paid Web subscription or the platform-admin
  complimentary grant — rather than a separate per-organization rollout flag.
  When the deployment cannot host Cloud, the source is invisible in
  `search_capabilities` and execute reports `unknown_capability`. Execution
  re-checks Web access live (`openwork_web_access_required`) and the runtime
  re-checks hosting availability (`cloud_not_available`) as defense in depth;
  first-use provisioning requires a valid `create` request with `mcp:write`
  and active Web access. Concurrent first-use requests and browser access use
  the same member-scoped worker and creation deduplication. This deduplicates
  workspace provisioning, not subsequent successful session creation calls.
- Member-scoped only: capabilities operate on the caller's resolved worker.
  `sessionId` from another member's worker must 404, not 403-leak.
- Prompts transit the gateway but are stored only on the worker (same trust
  domain as existing web chat). No prompt content in gateway logs; log
  receipts/ids only.

The first-use contract is exercised by
`pnpm evals:pr specs/remote-session-first-use.test.ts`: an isolated Den and
database handle real MCP requests, while an HTTP witness replaces Daytona
and the worker's native session API. The journey checks access denial,
read/write boundaries, concurrent provisioning, first prompt delivery after
readiness, browser reuse, and separate workspaces for two members. It does
not launch a live Daytona VM or run a model.

### 5. Desktop side (v1: zero code)

Desktop engines already carry the `openwork-cloud` MCP entry. The agent
discovers `remoteSession.*` via `search_capabilities` naturally. Optional
polish, in order:

1. A built-in remote skill ("send this to my web chat") teaching the flow —
   `builtin-skills.ts`, no client release needed.
2. Desktop UI affordance ("Continue in Web") that pre-fills the prompt —
   later, once the capability path is proven.

### 6. Desktop execution target — reuse the Automation runner channel

Web → desktop communication already exists: Desktop-placed Automations. Den
never reaches into a desktop; the signed-in desktop app pulls work over an
authenticated channel and reports back. That channel is task-agnostic in
everything but naming, and `target: "desktop"` reuses it instead of inventing
a second dispatch path.

What ships today (all reused):

- **Runner client:** `apps/desktop/electron/automation-runner.mjs` polls
  `GET /v1/automation-runner/work` every 60 s (wake-on-resume via
  `powerMonitor`), claims runs, heartbeats every 10 s (heartbeat response
  carries `cancelRequested` + lease validity), posts ordered events, and
  completes with a durable receipt.
- **Runner identity/auth:** per-machine `runnerId` (persisted UUID) +
  HMAC runner token (12 h TTL, audience-bound to the minting Den base URL),
  minted by the renderer with member auth via `POST /v1/automation-runners/token`
  (`automation-runner-bridge.tsx`). The mint route is `"x-mcp": false` —
  MCP callers can never obtain runner credentials. This stays true here:
  the gateway capability only **enqueues tasks**; it never touches runner auth.
- **Execution shape:** the assignment is already `{instructions, model,
  timeoutMs}` and `executeDesktopAutomation` runs it as a **normal visible
  local session** (`POST /workspace/:id/opencode/session`), returning `sessionId` /
  `workspaceId` into the Den receipt. Exactly the semantics we want: remote
  work on desktop is a real thread the human can watch and take over.
- **Built-in extension points:** runner registration declares
  `protocolVersion`, `capabilities`, and `supportedExecutionTargets`
  (`packages/types/src/automations.ts`), so a new work kind is a versioned,
  negotiated addition — old runners simply never see it.

Flow:

```
Any MCP client            den-api                          Desktop app (Electron main)
──────────────            ───────                          ───────────────────────────
execute_capability
 remoteSession.create ──▶ enqueue remote-session task
   {target:"desktop"}     (claimable, deadline-bound,
                           same tables/protocol as
                           desktop automation runs)
                                                           GET /v1/automation-runner/work
                                                             ← task {kind:"remote_session", …}
                                                           claim → lease → create visible
                                                           local session → heartbeat →
                                                           POST events (assistant text,
                                                             sessionId, usage, terminal)
 remoteSession.read ────▶ read task events from Den ◀──────POST complete {receipt}
                          (Den never contacts desktop)
```

**Reuse boundary — promote the channel, don't squat on it.** The runner
*protocol* (claim/lease/heartbeat/events/complete), runner *identity/auth*,
and *presence* are task-agnostic and shared. But automation **run tables, run
history, receipts, and schedule-native lifecycle states** (missed occurrence,
claim deadline bounded by next occurrence) are automation semantics —
`remote_session` tasks must NOT be stored as automation runs or appear in
`listAutomationRuns`. The channel is generalized into a desktop task dispatch
seam on which automations are one work kind, not the landlord.

Deltas required (small, additive):

1. **Work kind on a generalized seam, not a new channel**: extract the
   claim/lease/heartbeat/events/complete protocol + runner auth/presence as a
   shared layer. Server-first migration: introduce generic runner endpoints
   (e.g. `/v1/desktop-runner/*`) and keep `/v1/automation-runner/*` as
   compatible aliases — the runner ships inside Electron, so old clients live
   for a long time. `remote_session` tasks get their own table and lifecycle
   vocabulary (`queued/claimed/running/interrupted/done` — no "missed
   occurrence"). Runner token capabilities gain a `remote_session` grant next
   to automation grants so org policy can allow one without the other. The
   work kind is negotiated through the existing `capabilities` /
   `protocolVersion` handshake.
2. **Runner handler:** in `automation-runner.mjs`, a `remote_session` task
   executes exactly like an automation run (visible session titled from the
   request), except follow-up `remoteSession.send` tasks resume the same
   local `sessionId` instead of creating a new one.
3. **Latency:** the 60 s work poll is fine for fire-and-forget handoff but
   sluggish for conversation. The low-latency seam is already built and
   tested server-side: the SSE stream `GET /v1/automation-runners/events`
   (`automation_work_available` notifications) — the runner just doesn't
   consume it yet. Consuming `eventsPath` is the single change that makes
   desktop dispatch near-real-time, and it benefits Automations too.
4. **Machine selection:** a member may have several desktops. Default to the
   most-recently-seen runner within the presence window
   (`GET /v1/automation-runners/presence`, 10 min window); allow explicit
   `runnerId` (from `remoteSession.list`) to pin a machine. No runner in the
   presence window → actionable "open OpenWork Desktop and sign in" result,
   never a silent queue-forever.
5. **Transcript reads:** Den cannot query the desktop, so `remoteSession.read`
   for desktop targets reads the ordered task events the runner posted
   (assistant text, state, `sessionId`) — same durable store automation run
   receipts use. Full-fidelity transcript stays on the desktop; events carry
   the summary + final output.

Security invariants preserved from the automation channel:

- Runner tokens: first-party mint only, audience-bound, owner-revocable,
  instantly dead if the member leaves the org. MCP can enqueue, never run.
- Same-member only: tasks are scoped `{organizationId, ownerMemberId}`; a
  gateway caller can only dispatch to their **own** desktops. Cross-member
  dispatch is a non-goal and must 404.
- Desktop execution stays **visible** (a real thread), consistent with the
  deliberate automation-runner decision — no headless remote control of a
  member's machine.
- Model access is re-checked at claim time, same as automation claims.

### 7. Extending the gateway generally (the reusable recipe)

This feature doubles as the template for future gateway extensions:

- **New discoverable behavior** → new capability source file registered in
  `capability-registry.ts`, gated by a scope, surfaced through
  `search_capabilities` / `execute_capability`.
- **New rich result UI** → `registerAgentXxxApp` helper + renderer in
  `packages/mcp-apps`.
- **New top-level MCP tool** → only when the tool must exist without
  discovery (rare; requires updating every client's mental model). Avoid.

## Offline and delivery semantics

The two targets are asymmetric: cloud runtimes can be booted on demand;
desktops cannot.

### Cloud target — auto-wake, bounded wait, retryable state

"Web not running" usually means the member's cloud worker is idle-stopped
(Den stops healthy workers after 30 min idle, `stopIdleCloudWorkers`), not
that anything is missing — the browser being closed never matters, since the
session runtime is the worker and the web UI is just a viewer.

- Existing behavior reused: resolving a stopped worker fire-and-forget wakes
  it and reports `"waking"` (`resolveCloudInstance` →
  `wakeCloudWorker`, provision deadline 15 min, silent reprovision if the
  sandbox is gone). Cloud automation runs additionally await the wake and
  poll readiness at 1 s intervals up to 120 s (`cloud-agent-executor.ts`).
- `remoteSession.create` / `send {target:"cloud"}`: trigger the wake, poll
  readiness within a short in-call budget (~20–30 s to keep the MCP call
  responsive), otherwise return a **retryable `waking` state**; the agent
  retries the same idempotent call. No durable queue — the wake is already
  in flight server-side.
- No worker provisioned at all (vs. stopped) → actionable needs-setup
  result, same as the failure-modes table.

### Desktop target — fail fast by default, opt-in store-and-forward

Den cannot power on a machine and never contacts the desktop; the runner
pulls. Therefore:

- **Default: fail fast.** No runner inside the 10-min presence window →
  `remoteSession.create {target:"desktop"}` returns the exact human action
  ("open OpenWork Desktop on <machine> and sign in"). Conversations are not
  silently queued against machines that may be off for days.
- **Sleeping ≠ offline.** A running app on a sleeping laptop wakes and polls
  immediately on `powerMonitor` resume/unlock, so delivery after lid-open is
  seconds, not the 60 s poll interval.
- **Opt-in queueing:** an explicit `deliverBy` timestamp on the task enables
  store-and-forward for handoff-style work ("run on my desktop whenever it's
  online today"). A task unclaimed past `deliverBy` transitions to `expired`
  with a clear state readable via `remoteSession.read` — analogous to missed
  desktop automation runs, but expressed in the remote-session lifecycle
  vocabulary, never silently dropped.

## Failure modes

| Failure | Behavior |
| --- | --- |
| Member has no cloud worker | `remoteSession.create` returns an actionable needs-setup result naming the exact human step (provision worker in Den dashboard) |
| Worker unreachable / asleep | Retryable error with `referenceId`; no partial session creation |
| Session deleted on web | `remoteSession.send`/`read` return `unknown_session`, prompting `remoteSession.list` |
| Token expiry mid-flow | Standard gateway 401 semantics; desktop reconciler already auto-refreshes |
| No desktop runner in presence window | `remoteSession.create {target:"desktop"}` returns actionable "open OpenWork Desktop and sign in on <machine>" — never queues forever |
| Desktop task unclaimed past deadline | Marked missed with cause, same as missed desktop automation runs; surfaced via `remoteSession.read` |
| Desktop goes offline mid-task | Lease expires (60 s heartbeat loss) → task marked interrupted with last posted events preserved |

## Rollout

1. **Phase 1** — capability source + worker routing + text results. Proof:
   testkit spec in `evals/specs/` driving desktop engine → gateway → mock
   worker (witness for openwork-server, per `write-a-spec` mocks), asserting
   session creation, prompt receipt, transcript read, and member-scoping
   (cross-member 404).
2. **Phase 2** — MCP App card + built-in skill. Proof: MCP App render spec
   (pattern: existing `mcp-app-render-test`), plus e2e where the session
   created from desktop appears in headless web UI (`worlds/dev-headless.ts`).
3. **Phase 3** — `target: "desktop"`: generalize the runner seam server-first
   (generic `/v1/desktop-runner/*` endpoints with `/v1/automation-runner/*`
   aliases, dedicated `remote_session` task table), then add the
   `remote_session` work kind + runner handler in `automation-runner.mjs`,
   negotiated via `protocolVersion`/`capabilities`. Proof: testkit spec with
   a fake runner exercising claim/heartbeat/events/complete for the new kind,
   member-scoping, no-runner-present, and an assertion that remote-session
   tasks never appear in `listAutomationRuns`.
4. **Phase 4** — runner consumes the existing SSE stream
   (`/v1/automation-runners/events`) for near-real-time dispatch (shared win
   with Automations); external clients doc page (Claude Code/Codex get both
   targets with no extra work); optional MCP resource subscriptions for live
   transcript updates.

## Alternatives considered

- **Desktop talks to the worker directly (connect-link handoff), skipping the
  gateway.** Fewer hops, but only works from OpenWork Desktop, duplicates
  worker resolution/auth in the client, and bypasses org policy. Rejected.
- **New top-level MCP tools (`create_remote_chat`, `send_to_session`).**
  Breaks the gateway's deliberate two-tool discovery contract and bloats
  every connected client. Rejected in favor of a capability source.
- **A new dedicated cloud→desktop channel (WebSocket/push) for desktop
  targets.** The automation runner channel already provides claim/lease/
  heartbeat/receipts with hardened runner auth, and its SSE wake-up stream is
  already built server-side. A parallel channel would duplicate all of it and
  double the desktop's attack surface. Rejected — extend the work-kind schema
  instead.
- **Letting MCP callers mint or hold runner tokens to talk to desktops
  "directly".** Violates the deliberate `x-mcp: false` boundary on
  `/v1/automation-runners/token`; the gateway must only enqueue tasks.
  Rejected.
- **A durable-execution engine (Temporal, Inngest) for dispatch and
  delivery.** The genuine unlock (long-lived multi-step sagas with timers and
  signals) does not exist in this design: every operation is either
  request-scoped (cloud wake-and-poll, <2 min) or edge-pull (the desktop
  runner cannot be an engine worker behind NAT — the claim/lease protocol
  stays bespoke regardless). Den's durability model is already crash-safe
  state machines in Postgres (worker status as cross-replica mutex, claimable
  rows + deadline sweeps, durable receipts), so an engine would be a
  re-platform, not an enhancement — and it adds a second source of truth
  beside the receipt tables users read, plus heavy self-host burden for OSS
  deployers (own cluster/datastore for Temporal; second runtime for
  Inngest) and Temporal's determinism/versioning tax. Rejected for this
  design. Escalation path if pressure appears: (1) Postgres-native queue
  (pg-boss / graphile-worker) — no new vendor, ships with the existing DB;
  (2) only if the Workflows product ever needs true sagas, an internal
  orchestration seam with Postgres as the default implementation and an
  engine as an optional adapter, so self-deploy stays vanilla Postgres.
- **A separate MCP server hosted by OpenWork Web.** There is no web MCP
  server today (den-web is dashboard-only); building one duplicates auth,
  policy, and exposure logic the gateway already owns. Rejected.
