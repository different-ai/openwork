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

## Engine and model

By default (`engine: "auto"`) the client asks the server once which OpenCode
engine its chats use (`GET /experimental/engine-v2-preview/status`), so a
thread lands where the app reads it. A server without that route is v1; any
other failed lookup throws a retryable `HeadlessThreadError` instead of
guessing. Pass `engine: "v1"` or `"v2"` to skip the lookup.

When a call names no model and there is no `defaultModel`, the client reads the
workspace default (`GET /workspace/:id/default-model`). v1 without any model
lets the engine choose; v2 throws `model_required` before creating anything.
v2 assigns its own message ids, so a `messageId` cannot make a v2 turn
idempotent: waits use the pre-turn message count instead.

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
| `getThreadWaitingFor` | Whether a thread waits on a permission or a question, from the engine's own request lists. |
| `getThreadPending` | The request a thread waits on, a permission before a question, in words the person decides on. |
| `getThreadPendingItems` | Every open request, up to five, in the same order: the first is what `getThreadPending` returns. |
| `answerThread` | Answers any open request by its `requestId`: a question's answers, a permission `once` or `reject` (never "always"), or `dismiss`, which closes a question without answering it. |
| `exportTranscript` | Flattens a snapshot into per-message text, reasoning, and tool calls. |

`answerThread` checks the live request before it sends anything. A `requestId`
that is no longer open, or names a request of the other kind, fails with code
`stale_request`; answers that do not fit, and dismissing a permission, fail
with `invalid_answer`. A dismissal uses the engine's own reject route (v1
`POST /question/:id/reject`, v2 `DELETE /session/:id/form/:id`) and also
clears a step that takes no answer from here, such as one that opens a link.
A request from a helper the thread started is the thread's, and its reply
goes to the helper that asked.

`waitForThread` reports an outcome rather than throwing, so a caller running
many threads can record a timeout as a result instead of losing the run.
Transport and payload failures throw `HeadlessThreadError`, which carries
`code`, `status`, `method`, `path`, and the server's body.

Deterministic by construction: inject `fetch`, `now`, and `sleep` to run the
whole contract against fixtures with no wall-clock dependency.

## Test

```bash
pnpm --filter @openwork/headless-threads build
pnpm --filter @openwork/headless-threads test
```

The tests run the built package against a fixture engine. The desktop's
remote-session adapter drives the same client in
`apps/desktop/test/session-runner.test.mjs`:

```bash
pnpm --filter @openwork/desktop test:session-runner
```
