# @openwork/headless-threads

Drive a native OpenWork thread from code, without rendering the app.

A "thread" here is an ordinary OpenWork session. Same workspace, same managed
OpenCode engine, same session id, same persisted messages, tool activity, and
final state the desktop UI shows. A thread this package creates can be opened
in the app afterwards, because there is no separate headless thread type.

This is a client, not a runtime. It adds no chat engine, no session store, no
model gateway, and no new server route — it is a typed workflow over the
official OpenCode SDK through OpenWork's workspace-scoped proxy.

## Why

Anything that drives OpenWork without a UI — a load check, an automation
harness, an agent-quality benchmark — currently re-implements the same
sequence by hand against raw HTTP: create a session, submit `prompt_async`,
poll `/session/status`, poll messages, work out when the turn actually
finished, then dig text back out of message parts.
Legacy harnesses contained one such copy. This package is that sequence, typed
and tested once.

Note what the hand-rolled version has to get right, and what this package now
owns: a thread is still `idle` in the gap between accepting a prompt and
starting work, so waiting for "not busy" alone reports a turn finished before
it began. Settling requires a non-running status **and** an assistant message
that was not there when the turn was submitted.

## Use

```ts
import { createHeadlessThreadClient } from "@openwork/headless-threads";

const threads = createHeadlessThreadClient({
  baseUrl: "http://127.0.0.1:8787",
  workspaceId: "ws_1",
  token: process.env.OPENWORK_TOKEN,
  defaultModel: { providerId: "anthropic", modelId: "claude-sonnet-5" },
});

const thread = await threads.createThread({
  title: "Refund policy",
  prompt: "A customer wants a refund after 40 days. What are their options?",
});

await threads.waitForThread(thread.id, { timeoutMs: 120_000 });

const followUp = await threads.sendTurn(thread.id, {
  prompt: "They also lost the receipt.",
});
const waited = await threads.waitForThread(thread.id, {
  timeoutMs: 120_000,
  since: followUp,
});

if (waited.outcome === "settled") {
  const transcript = await threads.exportTranscript(thread.id);
  console.log(transcript.finalAssistantText);
}
```

`thread.id` is the native session id. Opening OpenWork on the same workspace
shows this conversation in the sidebar.

## Contract

`AgentSessionClient` is the intentionally small replaceable runtime port:
create a thread, send a turn, read a snapshot, and abort. `HeadlessThreadClient`
extends it with polling and transcript helpers. OpenCode is currently the only
implementation; UI inventory and cross-workspace plugin routing stay on the
native protocol instead of expanding this port speculatively.

| Function | Does |
| --- | --- |
| `createThread` | Creates a thread, optionally with its first turn and a model. |
| `sendTurn` | Submits a turn and returns an acceptance that records the pre-turn message count. |
| `waitForThread` | Polls to a bounded deadline. Returns `settled`, `timeout`, or `aborted` — never throws on a slow thread. |
| `getThreadSnapshot` | Status, messages, and todos as OpenWork stores them. |
| `abortThread` | Requests a stop. Acceptance is not proof the run ended; wait afterwards to observe idle. |
| `exportTranscript` | Flattens a snapshot into per-message text, reasoning, and tool calls. |

`waitForThread` reports an outcome rather than throwing, so a caller running
many threads can record a timeout as a result instead of losing the run.
Transport and payload failures throw `HeadlessThreadError`, which carries
`code`, `status`, `method`, `path`, and the server's body.

Deterministic by construction: inject `fetch`, `now`, and `sleep` to run the
whole contract against fixtures with no wall-clock dependency.

## Native v2

`@openwork/headless-threads/v2` exports `createNativeV2Client` and
`createHeadlessThreadClientV2`. This Node/browser-compatible implementation
targets OpenCode `0.0.0-beta-19271` through the authenticated
`/workspace/:id/opencode2/api` proxy. It never calls v1.

Import native inputs, snapshots and clients from `/v2` under their familiar
names (`CreateThreadInput`, `HeadlessThreadTurnInput`, `HeadlessThreadSnapshot`,
`HeadlessThreadClient`, `HeadlessThreadWaitResult`). Their native-only refinements
live in `src/v2-types.ts` and reuse the shared contracts. The default package
entry remains v1: its snapshot `todos` is always an array. Native snapshots
honestly return `todos: null` when no authoritative todo API exists. The shared
`toTranscript` projection accepts only the fields it reads; no fake todos are
needed to export a native transcript.

The initial surface is intentionally narrow:

- Create a session with an explicit stable ID, agent and model, then confirm
  ownership through the workspace-scoped session read.
- Admit user text with optional native selected-skill attachments, or separate
  synthetic input, with a stable native ID and retain the native inbox receipt.
  Synthetic input uses `resume:false` and cannot carry skills.
- Reconcile by exact ID across inbox and cursor-paginated native history.
  Unknown admission never permits an automatic resend. One client submits at
  most one POST per input ID; after restart, the durable owner must reconcile
  its persisted intent instead of calling first admission again.
- Interrupt with `continue=false`, wait, and observe active execution. An idle
  no-op is distinct from an interrupted run. Pending inbox items are returned,
  not cancelled. Observed idle is not success or native-control revocation.

Messages retain their native kinds and evidence. The domain client attributes
replies only after validating host metadata, native history ordering, model/agent
binding and terminal boundaries. Hosts must serialize session writers across
processes. Context remains a separately admitted synthetic message; file and
agent attachments and per-turn tool masks are refused.

### Selected skills

```ts
import { createNativeV2Client, createHeadlessThreadClientV2 } from "@openwork/headless-threads/v2";

const native = createNativeV2Client(options);
const threads = createHeadlessThreadClientV2(options);
const catalog = await native.listSkills();
// The caller supplies exact IDs selected from this workspace's current catalog.
await threads.sendTurn(threadId, {
  messageId: savedMessageId,
  prompt: "Prepare the summary.",
  skills: [{ id: selectedSkillId }],
});
```

- `HeadlessThreadTurnInput.skills?: Array<{ id: string }>` also applies to
  `retryTurn`; `CreateThreadInput.skills` attaches to its optional initial
  `prompt`. Nonempty skills without an initial prompt are rejected.
- `listSkills(signal?: AbortSignal): Promise<NativeV2Skill[]>` validates live
  `GET /api/skill`: `id`, `name`, `location`, `content`, and optional
  `description`, `slash`, `autoinvoke`. Duplicate catalog IDs are invalid.
  An optional strictly validated `source: { type: "openwork-cloud", uri: string, scope: string }`
  preserves the host's exact source URI (`skill://` prefix, at most 1024
  characters, matching the server contract). Cloud sources require an opaque
  `scope` of exactly 64 lowercase hex characters. Resolve a Connect skill by exact
  `source.type` and `source.uri === connectSkill.url`, requiring one match;
  never match titles or derive a native ID, content, or path from that URI.
  The caller persists that scope with its selected Cloud intent and supplies
  `x-openwork-native-skills-scope` on the Cloud prompt through its scoped fetch
  transport. Generic headless never reconstructs or rebinds a scope from a newer
  catalog; a stale pinned scope remains stale for the server to refuse. Local
  skill prompts need no Cloud header.
  The Cloud materializer must refresh the native registry before catalog reads;
  this client neither materializes Cloud skills nor guesses IDs from names.
- Inputs allow at most 32 entries, each strictly `{ id }` with a nonempty,
  unpadded, control-character-free ID of at most 2048 characters. Duplicate IDs
  collapse in first-selection order. Mentions and caller-supplied names/bodies
  are not supported. The native POST contains exactly `skills: [{ id }]`;
  skill instructions are never appended to user text or synthetic context.
- Before fresh admission, every ID must be in the live catalog. Native
  `POST /api/session/:id/permission` evaluates `action: "skill"` with the
  selected IDs as resources and the actual current session agent. Only
  `effect: "allow"` permits a prompt. `skill_unavailable`, `skill_denied`, and
  `skill_permission_required` block submission; pending native requests remain
  available via `listPermissions`. No permission reply or policy grant is
  issued. `save` lists exact resources that a person may explicitly approve.
  The domain preflight prevents blocked skills from parking paired context;
  the transport checks again at admission so direct callers cannot bypass it.
- Intent metadata binds the ordered selected IDs. Reusing a message ID with
  changed skills or mismatched receipt attachments is refused. Input schemas
  accept IDs only; receipt/history schemas preserve native resolved
  `{ id, name, text?, mention? }` separately. Recovery compares the frozen
  receipt IDs without re-resolving today's catalog or content and never
  resends an uncertain prompt.
- `snapshot.native.inputSkills: Record<string, Array<{ id: string }>>` exposes
  frozen selected IDs keyed by the exact native user message ID. It includes
  verified host-bound history and unambiguous pending inbox prompts, checking
  actual attachment shape against host metadata and the native input boundary.
  Text-only host inputs have `[]`; absent entries mean **unproven**, not empty.
  Synthetic inputs and ambiguous/untrusted bindings produce no selection proof.
- `nativeV2InputSkillsMatch(snapshot, messageId, skills?)` is the exported
  read-only recovery check. Call it before an `alreadyPresent` shortcut for
  completed or pending work. It validates/deduplicates the persisted ID-only
  selection and returns `false` for missing evidence, ambiguous bindings, or
  differing ordered IDs. It reads no catalog and proves neither completion
  nor permission to resend; retain the existing native outcome checks.

```bash
pnpm --filter @openwork/headless-threads test:v2
OPENWORK_TEST_NATIVE_V2_BIN=/absolute/path/to/verified/beta19271/opencode2 pnpm --filter @openwork/headless-threads test:v2:smoke
```

`test:v2` uses isolated HTTP fixtures. `test:v2:smoke` requires an explicitly
selected verified binary and runs a real isolated native engine against a
loopback-only provider. It proves first-model-request skill content without a
skill-tool call, native deny/ask behavior, attribution, and read-only recovery.
It makes no paid model or Cloud calls. Packaged-app proof remains separate.

## Test

```bash
pnpm --filter @openwork/headless-threads test
```

The end-to-end proof lives with the server it drives, in
`apps/server/src/headless-threads.e2e.test.ts`, and runs against a real
OpenWork server:

```bash
pnpm --filter openwork-server test src/headless-threads.e2e.test.ts
```
