import assert from "node:assert/strict";
import { test } from "node:test";
import { ANSWER_STREAMING_MIN_CHARS, answerStreaming, applyStreamEvent, type LiveStream } from "./live-stream.ts";

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

test("the answer's words show without a tap only while the engine streams the text part itself with a few words in it", () => {
  const base: LiveStream = { messageId: "msg_a", partId: "prt_1", type: "text", text: "Short version: an API wins", ended: false };
  assert.equal(answerStreaming(base), true);
  // Thinking and unnamed parts stay behind a tap; a closed part belongs to the transcript now.
  assert.equal(answerStreaming({ ...base, type: "reasoning" }), false);
  assert.equal(answerStreaming({ ...base, type: "" }), false);
  assert.equal(answerStreaming({ ...base, ended: true }), false);
  // A lone word or whitespace is not worth a line.
  assert.equal(answerStreaming({ ...base, text: "Short" }), false);
  assert.equal(answerStreaming({ ...base, text: "   \n  " }), false);
  assert.equal(answerStreaming({ ...base, text: "x".repeat(ANSWER_STREAMING_MIN_CHARS) }), true);
  assert.equal(answerStreaming(null), false);
  assert.equal(answerStreaming(undefined), false);
});
