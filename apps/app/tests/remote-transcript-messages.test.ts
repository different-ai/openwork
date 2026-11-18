import { expect, test } from "bun:test"
import type { DynamicToolUIPart, UIMessage } from "ai"

import { parseRemoteRead, type RemoteTranscriptMessage } from "../src/lib/remote-session-thread"
import { remoteTranscriptToUIMessages } from "../src/lib/remote-transcript-messages"

function page(payload: unknown): RemoteTranscriptMessage[] {
  const outcome = parseRemoteRead(payload)
  if (outcome.kind !== "page") throw new Error(`expected a page, got ${outcome.kind}`)
  return outcome.page.messages
}

function tools(message: UIMessage | undefined): DynamicToolUIPart[] {
  return (message?.parts ?? []).flatMap((part) => part.type === "dynamic-tool" ? [part] : [])
}

const current = {
  title: "Synthetic task",
  messages: [
    { id: "msg_user", role: "user", createdAt: 1_000, text: "List the files", toolCalls: [] },
    {
      id: "msg_reply", role: "assistant", createdAt: 1_100, completedAt: 44_000, text: "Two files.", toolCalls: [{}, {}],
      parts: [
        { type: "reasoning", text: "Plan the listing", durationMs: 12_000 },
        { type: "tool", id: "prt_ls", name: "bash", status: "completed", title: "List files", input: "{\"command\":\"ls\",\"description\":\"List files\"}", output: "a\nb", error: null, truncated: false, startedAt: 2_000, endedAt: 2_400 },
        { type: "text", text: "Checking one more." },
        { type: "tool", id: "prt_read", name: "read", status: "error", input: "{\"filePath\":\"/missing\"}", output: null, error: "ENOENT: no such file", truncated: false },
        { type: "text", text: "Two files." },
      ],
    },
  ],
}

test("ordered parts parse into a typed transcript", () => {
  const [user, reply] = page(current)
  expect(user?.parts).toEqual([{ type: "text", text: "List the files" }])
  expect(reply?.parts.map((part) => part.type)).toEqual(["reasoning", "tool", "text", "tool", "text"])
  expect(reply?.steps).toBe(2)
  expect(reply?.completedAt).toBe(44_000)
  expect(reply?.parts[1]).toMatchObject({ type: "tool", name: "bash", status: "completed", title: "List files", startedAt: 2_000 })
})

test("an older computer's payload falls back to its tool calls, then its text", () => {
  const [, reply] = page({
    messages: [
      { id: "u", role: "user", text: "Go" },
      { id: "a", role: "assistant", text: "Done.", toolCalls: [{ id: "t1", name: "bash", status: "completed" }, { id: "t2", name: "read", status: "error", error: "nope" }] },
    ],
  })
  expect(reply?.parts.map((part) => part.type)).toEqual(["tool", "tool", "text"])
  expect(reply?.steps).toBe(2)
  const [, mapped] = remoteTranscriptToUIMessages(page({ messages: [{ id: "u", role: "user", text: "Go" }, { id: "a", role: "assistant", text: "Done.", toolCalls: [{ id: "t1", name: "bash", status: "completed" }] }] }), { running: false })
  expect(tools(mapped)[0]).toMatchObject({ toolName: "bash", state: "output-available", input: {} })
})

test("remoteTranscriptToUIMessages keeps the order and maps each step like a local tool call", () => {
  const [user, reply] = remoteTranscriptToUIMessages(page(current), { running: false })
  expect(user).toMatchObject({ id: "msg_user", role: "user", parts: [{ type: "text", text: "List the files" }], metadata: { opencode: { created: 1_000 } } })
  expect(reply?.metadata).toEqual({ opencode: { created: 1_100, completed: 44_000 } })
  expect(reply?.parts.map((part) => part.type)).toEqual(["reasoning", "dynamic-tool", "text", "dynamic-tool", "text"])
  const [ls, read] = tools(reply)
  expect(ls).toMatchObject({
    toolName: "bash", toolCallId: "prt_ls", state: "output-available",
    input: { command: "ls", description: "List files" }, output: "a\nb",
    callProviderMetadata: { openwork: { toolStartedAt: 2_000 } },
  })
  expect(read).toMatchObject({ toolName: "read", state: "output-error", input: { filePath: "/missing" }, errorText: "ENOENT: no such file" })
  expect(reply?.parts[0]).toMatchObject({ type: "reasoning", text: "Plan the listing", providerMetadata: { openwork: { durationMs: 12_000 } } })
})

test("an open step shows as running only in the latest turn of a running task", () => {
  const running = {
    messages: [
      { id: "u", role: "user", text: "Go" },
      { id: "a", role: "assistant", text: "", parts: [{ type: "tool", id: "t1", name: "bash", status: "running", input: "{\"command\":\"sleep 9\"}", output: null, error: null, truncated: false }] },
    ],
  }
  expect(tools(remoteTranscriptToUIMessages(page(running), { running: true })[1])[0]?.state).toBe("input-available")
  expect(tools(remoteTranscriptToUIMessages(page(running), { running: false })[1])[0]?.state).toBe("output-available")
})

test("input cut short at the wire cap still renders the step by name", () => {
  const cut = { messages: [{ id: "a", role: "assistant", text: "", parts: [{ type: "tool", id: "t", name: "write", status: "completed", input: "{\"filePath\":\"/a\",\"content\":\"xx", output: "", error: null, truncated: true }] }] }
  expect(tools(remoteTranscriptToUIMessages(page(cut), { running: false })[0])[0]).toMatchObject({ toolName: "write", input: {} })
})

test("a failed turn adds the same error message the chat shows for a local failure", () => {
  const failed = { messages: [{ id: "a", role: "assistant", createdAt: 5, text: "", toolCalls: [], parts: [], error: { code: "x", message: "The model is unavailable" } }] }
  const mapped = remoteTranscriptToUIMessages(page(failed), { running: false })
  expect(mapped).toHaveLength(1)
  expect(mapped[0]?.parts[0]).toMatchObject({ type: "text", text: "The model is unavailable" })
})
