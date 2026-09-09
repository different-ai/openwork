import assert from "node:assert/strict";
import { test } from "node:test";
import { assignmentPrompt, parseAssignmentBrief } from "./conversation.ts";
import { appendVoiceDraft, groupVoiceReply, privateVoiceReply, rebindVoiceExpectation, recordingType, voiceError, voicePackets, VOICE_MAX_PACKETS, VOICE_PACKET_CHARS, VOICE_REPLY_CHARS } from "./voice.ts";
import type { CoworkerGroupTurn, GroupTimelineEvent } from "./bridge.ts";

test("assignmentPrompt carries bounded visible discussion into an explicit outcome", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `visible message ${index} ${"x".repeat(1_500)}`,
    reasoning: "hidden reasoning must not be copied",
    toolCalls: [{
      partId: "prt_secret",
      tool: "read",
      status: "completed",
      input: { filePath: "/Users/me/secret-input.md" },
      output: "TOOL OUTPUT PAYLOAD",
      error: null,
      metadata: { openworkMcpApp: { content: [{ type: "text", text: "MCP APP PAYLOAD" }] } },
    }],
  }));
  const prompt = assignmentPrompt("Ship the revised launch brief.", messages);
  assert.match(prompt, /## Outcome\n\nShip the revised launch brief\./);
  assert.doesNotMatch(prompt, /visible message [01] /, "only the eight most recent messages are carried");
  assert.match(prompt, /You: visible message 2 /);
  assert.match(prompt, /Coworker: visible message 9 /);
  assert.doesNotMatch(prompt, /hidden reasoning/);
  for (const payload of ["prt_secret", "secret-input", "TOOL OUTPUT PAYLOAD", "MCP APP PAYLOAD", "openworkMcpApp"]) {
    assert.doesNotMatch(prompt, new RegExp(payload), `tool payload ${payload} must not become assignment context`);
  }
  assert.ok(prompt.length < 7_000, `assignment prompt stayed bounded, got ${prompt.length} characters`);
});

test("parseAssignmentBrief reads back the outcome and carried discussion, and nothing else", () => {
  const messages = [
    { role: "user", text: "Can you draft the launch note?\n\nKeep it short." },
    { role: "assistant", text: "Yes — I would lead with the date.\nThen the two changes." },
    { role: "system", text: "hidden system text" },
    { role: "assistant", text: "" },
  ];
  const prompt = assignmentPrompt("Write the launch note by Friday", messages);
  assert.doesNotMatch(prompt, /hidden system text/);
  const brief = parseAssignmentBrief(prompt);
  assert.ok(brief);
  assert.equal(brief.outcome, "Write the launch note by Friday");
  assert.deepEqual(brief.context, [
    { speaker: "you", text: "Can you draft the launch note?\n\nKeep it short." },
    { speaker: "coworker", text: "Yes — I would lead with the date.\nThen the two changes." },
  ]);
  const bare = parseAssignmentBrief(assignmentPrompt("Just do it", []));
  assert.deepEqual(bare, { outcome: "Just do it", context: [] });
  assert.equal(parseAssignmentBrief("Reply with exactly CHAT ONE READY."), null);
  assert.equal(parseAssignmentBrief("This is an explicit assignment created from our ongoing discussion.\n\nno headings"), null);
});

test("voice packets are bounded visible prose with honest truncation", () => {
  assert.deepEqual(voicePackets("## Hello\nRead [the note](https://example.com).\n```js\nsecretToolPayload()\n```\nNext sentence!"), { packets: ["Hello Read the note.", "Next sentence!"], truncated: false });
  for (const text of ["word ".repeat(2000), "x".repeat(VOICE_REPLY_CHARS + 1), "A. ".repeat(1000), "\u{1f30d}".repeat(2000)]) {
    const result = voicePackets(text);
    assert.equal(result.truncated, true);
    assert.ok(result.packets.length <= VOICE_MAX_PACKETS);
    assert.ok(result.packets.every((packet) => packet.length > 0 && packet.length <= VOICE_PACKET_CHARS));
    assert.ok(result.packets.reduce((size, packet) => size + packet.length, 0) <= VOICE_REPLY_CHARS);
    assert.ok(result.packets.every((packet) => !/[\uD800-\uDBFF]$/.test(packet)));
  }
  assert.deepEqual(voicePackets(""), { packets: [], truncated: false });
});

test("voice only offers a completed, tool-free final reply with a real parent", () => {
  const user = { id: "user-1", role: "user", parentId: null, text: "Question", completedAt: null, error: null, toolCalls: [] };
  const answer = { ...user, id: "reply-1", role: "assistant", parentId: user.id, text: "Visible answer.", completedAt: 10, reasoning: "never read this" };
  assert.deepEqual(privateVoiceReply([user, answer], true), { id: answer.id, turnId: user.id, text: answer.text });
  assert.equal(privateVoiceReply([user, answer], false), null, "working/unknown/failed turns cannot speak");
  for (const invalid of [{ ...answer, completedAt: null }, { ...answer, error: { name: "Aborted" } }, { ...answer, text: "" }, { ...answer, toolCalls: [{}] }, { ...answer, parentId: "other" }]) {
    assert.equal(privateVoiceReply([user, invalid], true), null);
  }
  assert.equal(privateVoiceReply([user, answer, { ...answer, id: "later", text: "", toolCalls: [{}] }], true), null, "do not backtrack to an intermediate answer");
});

test("group voice waits for the persisted successful replies of the exact user turn", () => {
  const turn: CoworkerGroupTurn = { id: "turn-1", clientMessageId: "sent-1", prompt: "Question", createdAt: 1, updatedAt: 2, status: "succeeded", mode: "sequential", routedBy: "mentions", speakers: [{ slug: "writer", order: 0, status: "succeeded", part: "reply", brief: "", threadId: "thread-1", error: "", startedAt: 1, endedAt: 2 }] };
  const user: GroupTimelineEvent = { id: "event-1", at: 1, kind: "user", turnId: turn.id, clientMessageId: turn.clientMessageId, text: "Question" };
  const answer: GroupTimelineEvent = { id: "event-2", at: 2, kind: "coworker", turnId: turn.id, slug: "writer", threadId: "thread-1", part: "reply", text: "Visible reply." };
  assert.deepEqual(groupVoiceReply(turn, [user, answer], () => "Writer"), { id: `${turn.id}:${answer.id}`, turnId: turn.clientMessageId, text: "Writer: Visible reply." });
  assert.equal(groupVoiceReply(turn, [user, answer], () => "Writer", [answer.id]), null, "Continue must not read an earlier successful reply again");
  assert.equal(groupVoiceReply(turn, [user, answer, { ...answer, id: "continued" }], () => "Writer", [answer.id])?.id, `${turn.id}:continued`);
  assert.equal(groupVoiceReply(turn, [user], () => "Writer"), null, "status before timeline is not a finished reply");
  assert.equal(groupVoiceReply(turn, [answer], () => "Writer"), null, "briefings without the user's matching event cannot speak");
  for (const status of ["running", "failed", "stopped"] as const) assert.equal(groupVoiceReply({ ...turn, status }, [user, answer], () => "Writer"), null);
  for (const other of [{ ...answer, turnId: "old" }, { ...answer, kind: "action" as const }, { ...answer, kind: "status" as const }]) assert.equal(groupVoiceReply(turn, [user, other], () => "Writer"), null);
});

test("dictation preserves the current draft and negotiates actual recorder formats", () => {
  assert.equal(appendVoiceDraft("Typed while recording", "  Spoken words.  "), "Typed while recording\nSpoken words.");
  assert.equal(appendVoiceDraft("Draft\n", "More"), "Draft\nMore");
  assert.equal(appendVoiceDraft("Keep this", "  "), "Keep this");
  assert.deepEqual(recordingType(() => true), { mimeType: "audio/webm;codecs=opus", format: "webm" });
  assert.deepEqual(recordingType((type) => type === "audio/mp4"), { mimeType: "audio/mp4", format: "m4a" });
  assert.equal(recordingType(() => false), null);
  assert.match(voiceError(new Error("voice_quota_exhausted")), /allowance is used up.*keep typing/);
  assert.equal(voiceError(new Error("voice_request_cancelled")), "Voice cancelled. Your draft is kept.");
});

test("voice admission follows only the exact requested turn and still-current generation", () => {
  const requested = { turnId: "old-user-message", generation: 7, admitted: false };
  const accepted = rebindVoiceExpectation(requested, requested, "continuation-message", 7);
  assert.deepEqual(accepted, { turnId: "continuation-message", generation: 7, admitted: true });
  assert.equal(rebindVoiceExpectation(requested, requested, "continuation-message", 8), null, "stop, account change or navigation invalidates a late admission");
  assert.equal(rebindVoiceExpectation(null, requested, "continuation-message", 7), null, "never opt in a disabled or consumed request");
  assert.equal(rebindVoiceExpectation({ ...requested, turnId: "another-message" }, requested, "continuation-message", 7), null);
  assert.equal(rebindVoiceExpectation(requested, { ...requested, generation: 6 }, "continuation-message", 7), null);
  assert.equal(rebindVoiceExpectation(accepted, requested, "unrelated-message", 7), null, "the old ID cannot rebind again after admission renamed it");
  assert.equal(rebindVoiceExpectation(requested, requested, "", 7), null);
});
