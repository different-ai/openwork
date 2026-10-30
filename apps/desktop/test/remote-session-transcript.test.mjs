import assert from "node:assert/strict"
import test from "node:test"
import { parseReadResult } from "@openwork/remote-sessions"
import { remoteSessionTranscriptPage } from "../electron/automation-runner.mjs"

const input = { from: "end", cursor: null, limit: 20 }

function snapshot(parts, extra = {}) {
  return {
    title: "Synthetic task",
    status: { type: "idle" },
    messages: [
      { id: "msg_user", role: "user", createdAt: 1_000, parts: [{ id: "u", type: "text", text: "List files" }] },
      { id: "msg_reply", role: "assistant", createdAt: 1_100, completedAt: 9_000, parts, ...extra },
    ],
  }
}

test("a desktop read sends each step in native order with tool state and timestamps", () => {
  const page = remoteSessionTranscriptPage(snapshot([
    { id: "r", type: "reasoning", text: "Plan", startedAt: 1_100, endedAt: 13_100 },
    { id: "t1", type: "tool", tool: "bash", toolStatus: "completed", toolTitle: "List files", toolInput: { command: "ls" }, toolOutput: "a\nb", startedAt: 2_000, endedAt: 2_500 },
    { id: "x", type: "text", text: "Now reading" },
    { id: "t2", type: "tool", tool: "read", toolStatus: "error", toolInput: { filePath: "/missing" }, toolError: "ENOENT" },
    { id: "s", type: "text", text: "hidden", synthetic: true },
    { id: "y", type: "text", text: "Done." },
  ]), input, null)
  const reply = page.messages[1]
  assert.deepEqual(reply.parts.map((part) => part.type), ["reasoning", "tool", "text", "tool", "text"])
  assert.deepEqual(reply.parts[0], { type: "reasoning", text: "Plan", durationMs: 12_000 })
  assert.deepEqual(reply.parts[1], { type: "tool", id: "t1", name: "bash", status: "completed", title: "List files",
    input: "{\"command\":\"ls\"}", output: "a\nb", error: null, truncated: false, startedAt: 2_000, endedAt: 2_500 })
  assert.equal(reply.parts[3].error, "ENOENT")
  assert.equal(reply.completedAt, 9_000)
  // Older readers keep text and toolCalls.
  assert.equal(reply.text, "Now reading\n\nDone.")
  assert.equal(reply.toolCalls.length, 2)
  // The shared runner accepts the page as is.
  assert.doesNotThrow(() => parseReadResult(page))
})

test("many large text parts stay inside one message's character budget", () => {
  const parts = Array.from({ length: 50 }, (_, index) => ({ id: `t${index}`, type: "text", text: "x".repeat(19_000) }))
  const page = remoteSessionTranscriptPage(snapshot(parts), input, null)
  const total = page.messages[1].parts.reduce((sum, part) => sum + part.text.length, 0)
  assert.ok(total <= 20_000)
  assert.doesNotThrow(() => parseReadResult(page))
})
