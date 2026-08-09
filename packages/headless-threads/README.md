# @openwork/headless-threads

Drive a native OpenWork thread from code, without rendering the app.

A "thread" here is an ordinary OpenWork session. Same workspace, same managed
OpenCode engine, same session id, same persisted messages, tool activity, and
final state the desktop UI shows. A thread this package creates can be opened
in the app afterwards, because there is no separate headless thread type.

This is a client, not a runtime. It adds no chat engine, no session store, no
model gateway, and no new server route — it is a typed shape over session
surfaces the OpenWork server already serves.

## Why

Anything that drives OpenWork without a UI — a load check, an automation
harness, an agent-quality benchmark — currently re-implements the same
sequence by hand against raw HTTP: create a session, submit `prompt_async`,
poll `/session/status`, poll messages, work out when the turn actually
finished, then dig text back out of message parts.
[`evals/flows/windows-workspace-session-performance.flow.mjs`](../../evals/flows/windows-workspace-session-performance.flow.mjs)
is one such copy. This package is that sequence, typed and tested once.

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
