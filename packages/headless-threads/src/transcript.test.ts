import { describe, expect, test } from "bun:test";

import { hasAssistantReplySince, toTranscript } from "./transcript.js";
import type { HeadlessThreadMessage, HeadlessThreadSnapshot } from "./types.js";

function message(input: Partial<HeadlessThreadMessage> & { id: string; role: string }): HeadlessThreadMessage {
  return { parentId: null, createdAt: null, error: null, usage: null, parts: [], ...input };
}

function snapshot(messages: HeadlessThreadMessage[]): HeadlessThreadSnapshot {
  return {
    threadId: "ses_1",
    title: "Refund policy",
    directory: "/workspace",
    status: { type: "idle" },
    messages,
    todos: [],
  };
}

describe("toTranscript", () => {
  test("joins text parts, keeps reasoning separate, and lists tool calls", () => {
    const transcript = toTranscript(
      snapshot([
        message({ id: "msg_1", role: "user", parts: [{ id: "prt_1", type: "text", text: "  Why? " }] }),
        message({
          id: "msg_2",
          role: "assistant",
          createdAt: 200,
          parts: [
            { id: "prt_2", type: "reasoning", text: "check the policy" },
            { id: "prt_3", type: "tool", tool: "read", callId: "call_1", toolStatus: "completed" },
            { id: "prt_4", type: "text", text: "Because " },
            { id: "prt_5", type: "text", text: "the window closed." },
          ],
        }),
      ]),
    );

    expect(transcript.messages).toEqual([
      { id: "msg_1", role: "user", createdAt: null, text: "Why?", reasoning: "", toolCalls: [] },
      {
        id: "msg_2",
        role: "assistant",
        createdAt: 200,
        text: "Because the window closed.",
        reasoning: "check the policy",
        toolCalls: [{ partId: "prt_3", name: "read", callId: "call_1", status: "completed" }],
      },
    ]);
    expect(transcript.finalAssistantText).toBe("Because the window closed.");
  });

  test("drops synthetic and ignored parts the app also hides", () => {
    const transcript = toTranscript(
      snapshot([
        message({
          id: "msg_1",
          role: "assistant",
          parts: [
            { id: "prt_1", type: "text", text: "<system reminder>", synthetic: true },
            { id: "prt_2", type: "text", text: "stale", ignored: true },
            { id: "prt_3", type: "text", text: "kept" },
          ],
        }),
      ]),
    );

    expect(transcript.messages[0]?.text).toBe("kept");
  });

  test("reports an empty final answer rather than falling back to an earlier turn", () => {
    const transcript = toTranscript(
      snapshot([
        message({ id: "msg_1", role: "assistant", parts: [{ id: "prt_1", type: "text", text: "first" }] }),
        message({ id: "msg_2", role: "user", parts: [{ id: "prt_2", type: "text", text: "and now?" }] }),
      ]),
    );

    expect(transcript.finalAssistantText).toBe("first");
  });

  test("has no final answer when the thread never answered", () => {
    const transcript = toTranscript(
      snapshot([message({ id: "msg_1", role: "user", parts: [{ id: "prt_1", type: "text", text: "hi" }] })]),
    );

    expect(transcript.finalAssistantText).toBe("");
  });
});

describe("hasAssistantReplySince", () => {
  const thread = [
    message({ id: "msg_1", role: "user" }),
    message({ id: "msg_2", role: "assistant" }),
    message({ id: "msg_3", role: "user" }),
  ];

  test("ignores assistant replies that predate the turn", () => {
    expect(hasAssistantReplySince(thread, 3)).toBe(false);
  });

  test("sees an assistant reply appended after the turn", () => {
    expect(hasAssistantReplySince([...thread, message({ id: "msg_4", role: "assistant" })], 3)).toBe(true);
  });

  test("treats a fresh thread as having no reply until one arrives", () => {
    expect(hasAssistantReplySince([], 0)).toBe(false);
    expect(hasAssistantReplySince([message({ id: "msg_1", role: "assistant" })], 0)).toBe(true);
  });
});
