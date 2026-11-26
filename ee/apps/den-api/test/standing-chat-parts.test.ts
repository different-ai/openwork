import assert from "node:assert/strict"
import { test } from "node:test"
import { standingChatParts } from "../src/personal-agents/standing-chat-parts.js"

test("standing chat projects only the caller's assistant steps and redacts connector details", () => {
  const history = standingChatParts(new Set(["first", "second"]), [
    { role: "user", messageId: "first", text: "Check the agenda." },
    { role: "assistant", messageId: "other", text: "Not in this conversation", toolCalls: [] },
    { role: "assistant", messageId: "first", text: "I’ll check.", createdAt: 100, toolCalls: [{ id: "call", name: "calendar", input: { token: "private" } }] },
    { role: "tool", messageId: "second", callId: "call", name: "calendar", isError: true },
    { role: "tool", messageId: "first", callId: "call", name: "calendar", isError: false, output: "private result", createdAt: 200 },
    { role: "assistant", messageId: "first", text: "**Agenda ready**", toolCalls: [] },
  ])
  assert.deepEqual([...history], [["first", [
    { type: "text", text: "I’ll check." },
    { type: "tool", id: "call", name: "calendar", status: "completed", input: null, output: null, error: null, truncated: false, startedAt: 100, endedAt: 200 },
    { type: "text", text: "**Agenda ready**" },
  ]]])
})
