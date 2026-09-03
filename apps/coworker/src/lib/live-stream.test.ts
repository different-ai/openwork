import assert from "node:assert/strict";
import { test } from "node:test";
import { applyStreamEvent, type LiveStream } from "./live-stream.ts";

const THREAD = "ses_1";

test("a part is announced, its words arrive as deltas, and its end carries the whole text", () => {
  let stream: LiveStream | null = null;
  stream = applyStreamEvent(stream, { kind: "part", threadId: THREAD, messageId: "msg_a", partId: "prt_1", type: "reasoning", text: "", ended: false }, THREAD);
  assert.deepEqual(stream, { messageId: "msg_a", partId: "prt_1", type: "reasoning", text: "", ended: false });
  stream = applyStreamEvent(stream, { kind: "delta", threadId: THREAD, messageId: "msg_a", partId: "prt_1", delta: "First the " }, THREAD);
  stream = applyStreamEvent(stream, { kind: "delta", threadId: THREAD, messageId: "msg_a", partId: "prt_1", delta: "sources" }, THREAD);
  assert.equal(stream?.text, "First the sources");
  assert.equal(stream?.ended, false);
  stream = applyStreamEvent(stream, { kind: "part", threadId: THREAD, messageId: "msg_a", partId: "prt_1", type: "reasoning", text: "First the sources, then the plan.", ended: true }, THREAD);
  assert.deepEqual(stream, { messageId: "msg_a", partId: "prt_1", type: "reasoning", text: "First the sources, then the plan.", ended: true });
});

test("words that arrive before their part is announced still count, and the announcement then names them", () => {
  let stream = applyStreamEvent(null, { kind: "delta", threadId: THREAD, messageId: "msg_a", partId: "prt_2", delta: "Hello" }, THREAD);
  assert.deepEqual(stream, { messageId: "msg_a", partId: "prt_2", type: "", text: "Hello", ended: false });
  stream = applyStreamEvent(stream, { kind: "part", threadId: THREAD, messageId: "msg_a", partId: "prt_2", type: "text", text: "", ended: false }, THREAD);
  assert.equal(stream?.type, "text");
  assert.equal(stream?.text, "Hello", "an announcement with no words yet keeps the words already streamed");
});

test("a new part supersedes the one before it; other threads, tool parts, and stale endings change nothing", () => {
  const thinking: LiveStream = { messageId: "msg_a", partId: "prt_1", type: "reasoning", text: "thinking", ended: true };
  const writing = applyStreamEvent(thinking, { kind: "part", threadId: THREAD, messageId: "msg_a", partId: "prt_2", type: "text", text: "", ended: false }, THREAD);
  assert.equal(writing?.partId, "prt_2");
  assert.equal(applyStreamEvent(writing, { kind: "delta", threadId: "ses_other", messageId: "msg_a", partId: "prt_2", delta: "x" }, THREAD), writing);
  assert.equal(applyStreamEvent(writing, { kind: "part", threadId: THREAD, messageId: "msg_a", partId: "prt_3", type: "tool", text: "", ended: false }, THREAD), writing);
  // The earlier reasoning part ending late does not take the live words away.
  assert.equal(applyStreamEvent(writing, { kind: "part", threadId: THREAD, messageId: "msg_a", partId: "prt_1", type: "reasoning", text: "thinking more", ended: true }, THREAD), writing);
  assert.equal(applyStreamEvent(writing, { kind: "delta", threadId: THREAD, messageId: "msg_a", partId: "prt_2", delta: "" }, THREAD), writing);
});
