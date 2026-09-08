import assert from "node:assert/strict";
import { test } from "node:test";
import { ANSWER_STREAMING_MIN_CHARS, answerStreaming, applyStreamEvent, type LiveStream } from "./live-stream.ts";
import { changeGroupSends, groupConversationRows, groupMessageKey, groupReplyParts, groupSends, mergeGroupReplyParts, reconcileGroupActivity, runGroupAction, submitGroupSend, type GroupActionAttempt, type GroupSend } from "./group-continuity.ts";
import type { GroupTimelineEvent } from "./bridge.ts";
import { executionProgress, type ExecutionActivity } from "./progress-activity.ts";
import { describeGroupPresentation } from "./group-presentation.ts";
import { PROGRESS_LIMITS } from "./progress-config.ts";

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

test("group parts keep final text and timed-out actions reject superseded callbacks", async (context) => {
  const parts = mergeGroupReplyParts([{ messageId: "msg_1", id: "prt_2", text: "second paragraph" }], [
    { messageId: "msg_2", id: "prt_3", text: "next message" },
    { messageId: "msg_1", id: "prt_2", text: "second" },
    { messageId: "msg_1", id: "prt_1", text: "first paragraph" },
  ]);
  assert.deepEqual(parts.map((part) => part.text), ["first paragraph", "second paragraph", "next message"]);
  const ended = mergeGroupReplyParts(parts, [{ messageId: "msg_1", id: "prt_2", text: "final", ended: true }]);
  assert.equal(mergeGroupReplyParts(ended, [{ messageId: "msg_1", id: "prt_2", text: "final late delta" }])[1]?.text, "final");

  context.mock.timers.enable({ apis: ["setTimeout"] });
  const attempts = new Map<string, GroupActionAttempt>();
  const completed: string[] = [];
  let finishOriginal = (_value: string) => {};
  let finishRetry = (_value: string) => {};
  const original = runGroupAction(attempts, "stop", () => new Promise<string>((resolve) => { finishOriginal = resolve; }), () => {}, (value) => completed.push(value));
  await new Promise(setImmediate);
  context.mock.timers.tick(PROGRESS_LIMITS.activityReadTimeoutMs * 2);
  await original;
  assert.equal(attempts.get("stop")?.state, "retryable", "a lost IPC promise must not hold the action lock");
  const retry = runGroupAction(attempts, "stop", () => new Promise<string>((resolve) => { finishRetry = resolve; }), () => {}, (value) => completed.push(value));
  await new Promise(setImmediate);
  finishOriginal("stale stop");
  await new Promise(setImmediate);
  assert.equal(attempts.get("stop")?.state, "running", "the old completion cannot unlock the new attempt");
  assert.equal(completed.length, 0, "late callbacks cannot apply stale UI effects");
  finishRetry("current stop");
  await retry;
  assert.equal(attempts.get("stop")?.state, "succeeded");
  assert.deepEqual(completed, ["current stop"]);

  const removal = runGroupAction(attempts, "remove:queued", () => new Promise<string>((resolve) => { finishOriginal = resolve; }), () => {}, (value) => completed.push(value));
  await new Promise(setImmediate);
  context.mock.timers.tick(PROGRESS_LIMITS.activityReadTimeoutMs * 2);
  await removal;
  assert.equal(attempts.get("remove:queued")?.state, "retryable");
  finishOriginal("confirmed removal");
  await new Promise(setImmediate);
  assert.equal(attempts.get("remove:queued")?.state, "succeeded", "a late acknowledgement reconciles an unsuperseded action without remounting");
  assert.equal(completed.at(-1), "confirmed removal");
});

test("group snapshots retain unavailable words, isolate native requests, and hand off each publication once", () => {
  const first: ExecutionActivity = { executionId: "exec_1", messageId: "msg_1", threadId: "ses_1", slug: "scout", state: "running", startedAt: 1, completedAt: null, continuation: false, pendingCoworkers: 0, pendingWorkers: 0, available: true, nativeStatus: "busy", replies: [{ id: "reply_1", parentId: "msg_1", parts: [{ id: "prt_1", text: "kept reply" }] }], tools: [], completedSteps: 0, failedSteps: 0 };
  const second: ExecutionActivity = { ...first, executionId: "exec_2", messageId: "msg_2", slug: "editor", threadId: "ses_2", startedAt: 2, replies: [] };
  const cached = reconcileGroupActivity({ timeline: [], executions: [first, second] }, { timeline: [], executions: [{ ...second, state: "succeeded" }, { ...first, available: false, replies: [] }] });
  assert.deepEqual(cached.executions.map((item) => item.executionId), ["exec_1", "exec_2"]);
  assert.deepEqual(reconcileGroupActivity(cached, cached, ["editor", "scout"]).executions.map((item) => item.executionId), ["exec_2", "exec_1"], "the turn's speaker order wins over admission and completion order");
  assert.equal(cached.executions[0]?.replies[0]?.parts[0]?.text, "kept reply");
  assert.equal(executionProgress(cached.executions[0]!, true).status, "unknown");
  assert.equal(executionProgress({ ...first, state: "waiting-person" }, true).status, "waiting");
  assert.equal(executionProgress({ ...first, nativeStatus: "idle" }, true).status, "waiting");
  assert.equal(executionProgress({ ...second, state: "succeeded" }, true).status, "completed");
  assert.deepEqual(describeGroupPresentation({ ...cached, events: [], interactions: [], active: true, turn: null, nameFor: (slug) => slug, unavailable: true }).activeSlugs, []);
  const other = reconcileGroupActivity(cached, { timeline: [], executions: [{ ...first, messageId: "other-request", replies: [] }] });
  assert.deepEqual(groupReplyParts(other.executions[0]!), []);
  const published = reconcileGroupActivity(cached, { timeline: [{ id: "evt_1", kind: "coworker", executionId: first.executionId, text: "final reply", at: 3 }], executions: [first, second] });
  assert.deepEqual(published.executions.map((item) => item.executionId), ["exec_2"]);
  assert.equal(groupMessageKey({ id: "optimistic", kind: "user", clientMessageId: "same-id", at: 1, text: "prompt" }), groupMessageKey({ id: "recorded", kind: "user", clientMessageId: "same-id", at: 2, text: "prompt" }));

  const failed: GroupSend = { clientMessageId: "A", text: "failed prompt", at: 1, state: "failed", beforeClientMessageId: "B" };
  const later: GroupSend = { clientMessageId: "B", text: "later prompt", at: 2, state: "pending" };
  const keys = (rows: ReturnType<typeof groupConversationRows>) => rows.map((row) => "event" in row ? groupMessageKey(row.event) : `execution:${row.execution.executionId}`);
  assert.deepEqual(keys(groupConversationRows([], [], [failed, later])), ["user:A", "user:B"]);
  const recorded: GroupTimelineEvent[] = [{ id: "recorded-B", kind: "user", clientMessageId: "B", text: later.text, at: 3 }];
  assert.deepEqual(keys(groupConversationRows(recorded, [second, first], [failed])), ["user:A", "user:B", "execution:exec_2", "execution:exec_1"], "a failed optimistic message stays before B while B's replies stream in speaker order");
  const finished: GroupTimelineEvent[] = [...recorded,
    { id: "reply-B-editor", kind: "coworker", text: "editor reply", slug: "editor", executionId: second.executionId, at: 5 },
    { id: "reply-B-scout", kind: "coworker", text: "scout reply", slug: "scout", executionId: first.executionId, at: 4 },
  ];
  assert.deepEqual(keys(groupConversationRows(finished, [], [failed])), ["user:A", "user:B", "execution:exec_2", "execution:exec_1"], "publication must not move A below B or sort backend replies by timestamps");
  assert.deepEqual(keys(groupConversationRows(finished, [], [{ ...failed, state: "cancelled" }])), ["user:A", "user:B", "execution:exec_2", "execution:exec_1"]);
});

test("lost group acknowledgements keep ordered receipts; explicit retries reuse IDs and cannot affect another group", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const first: GroupSend = { clientMessageId: "first", text: "first prompt", at: 1, state: "pending" };
  const second: GroupSend = { ...first, clientMessageId: "second", text: "second prompt", at: 2 };
  const calls: string[] = [];
  let rejectLate = (_cause: Error) => {};
  submitGroupSend("ordered-group", first, () => { calls.push(first.clientMessageId); return new Promise((_resolve, reject) => { rejectLate = reject; }); });
  submitGroupSend("ordered-group", second, async () => { calls.push(second.clientMessageId); return { accepted: true }; });
  submitGroupSend("other-group", first, async () => { calls.push("other-group"); return { accepted: true }; });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["first", "other-group"]);
  context.mock.timers.tick(PROGRESS_LIMITS.activityReadTimeoutMs * 2);
  await new Promise(setImmediate);
  assert.equal(groupSends("ordered-group")[0]?.state, "uncertain");
  assert.equal(groupSends("ordered-group")[0]?.beforeClientMessageId, second.clientMessageId, "the receipt retains its later-message anchor before that message is recorded");
  assert.equal(groupSends("ordered-group")[1]?.state, "pending");
  assert.equal(groupSends("other-group")[0]?.state, "accepted");
  const removed: GroupSend = { ...second, clientMessageId: "removed" };
  submitGroupSend("ordered-group", removed, async () => { calls.push("must-not-send"); return { accepted: true }; });
  changeGroupSends("ordered-group", (items) => items.map((item) => item.clientMessageId === removed.clientMessageId ? { ...item, state: "cancelled" } : item));
  let acceptRetry = (_result: { accepted: boolean }) => {};
  submitGroupSend("ordered-group", groupSends("ordered-group")[0]!, () => { calls.push(first.clientMessageId); return new Promise((resolve) => { acceptRetry = resolve; }); });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["first", "other-group", "first"]);
  rejectLate(new Error("late stale failure"));
  await new Promise(setImmediate);
  assert.equal(groupSends("ordered-group")[0]?.state, "sending", "the original rejection cannot downgrade the unconfirmed retry");
  assert.equal(calls.includes("second"), false, "later sends must still wait for retry admission");
  acceptRetry({ accepted: true });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["first", "other-group", "first", "second"]);
  assert.deepEqual(groupSends("ordered-group").map((item) => [item.clientMessageId, item.state]), [["first", "accepted"], ["second", "accepted"], ["removed", "cancelled"]]);
  const continuation: GroupSend = { ...first, clientMessageId: "same-continuation", turnId: "turn_1", only: "scout", turnUpdatedAt: 1 };
  let acceptOriginal = (_value: { accepted: boolean }) => {};
  let rejectRetry = (_cause: Error) => {};
  const continuationIds: string[] = [];
  submitGroupSend("continue-group", continuation, () => { continuationIds.push(continuation.clientMessageId); return new Promise((resolve) => { acceptOriginal = resolve; }); });
  submitGroupSend("continue-group", second, async () => { calls.push("after-continue"); return { accepted: true }; });
  await new Promise(setImmediate);
  context.mock.timers.tick(PROGRESS_LIMITS.activityReadTimeoutMs * 2);
  await new Promise(setImmediate);
  submitGroupSend("continue-group", groupSends("continue-group")[0]!, () => { continuationIds.push(continuation.clientMessageId); return new Promise((_resolve, reject) => { rejectRetry = reject; }); });
  await new Promise(setImmediate);
  assert.deepEqual(continuationIds, ["same-continuation", "same-continuation"], "an uncertain Continue has an explicit same-ID retry, not a new follow-up");
  assert.equal(calls.includes("after-continue"), false);
  acceptOriginal({ accepted: true });
  await new Promise(setImmediate);
  assert.equal(calls.at(-1), "after-continue", "acceptance from any attempt releases admission");
  rejectRetry(new Error("superseded by original acceptance"));
  await new Promise(setImmediate);
  assert.equal(groupSends("continue-group")[0]?.state, "accepted");

  changeGroupSends("restored-group", () => [{ ...continuation, state: "uncertain" }]);
  submitGroupSend("restored-group", second, async () => { calls.push("restored-second"); return { accepted: true }; });
  await new Promise(setImmediate);
  assert.equal(calls.includes("restored-second"), false, "a new draft cannot overtake a restored unconfirmed send");
  submitGroupSend("restored-group", groupSends("restored-group")[0]!, async () => { continuationIds.push(continuation.clientMessageId); return { accepted: true }; });
  await new Promise(setImmediate);
  assert.equal(calls.at(-1), "restored-second", "retrying the restored Continue releases later sends without changing its ID");
  assert.equal(continuationIds.at(-1), "same-continuation");
  assert.equal(groupSends("restored-group")[0]?.turnId, continuation.turnId);
  assert.equal(groupSends("restored-group")[0]?.only, "scout");
  changeGroupSends("ordered-group", () => []);
  changeGroupSends("other-group", () => []);
  changeGroupSends("restored-group", () => []);
  changeGroupSends("continue-group", () => []);
});
