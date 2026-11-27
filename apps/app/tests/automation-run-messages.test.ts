import { expect, test } from "bun:test"
import type { AutomationRunEvent } from "@openwork/types/automations"

import { automationRunMessages, showsAutomationExecutionTranscript } from "../src/react-app/kernel/automation-run-messages"

function event(sequence: number, type: AutomationRunEvent["type"], payload: AutomationRunEvent["payload"], attempt = 1): AutomationRunEvent {
  return { id: `event-${attempt}-${sequence}`, runId: "run-1", attempt, sequence, type, payload, createdAt: attempt * 100 + sequence }
}

const finishedRun: Parameters<typeof automationRunMessages>[0]["run"] = {
  id: "run-1", status: "succeeded", attemptCount: 1, resultSummary: "**Report ready**", finishedAt: 110, updatedAt: 110,
}

test("receipt messages keep instructions, recorded work, and one Markdown answer in turn order", () => {
  const messages = automationRunMessages({ run: finishedRun, revision: { instructions: "Summarize today's issues" }, events: [
    event(4, "capability_execution", { messageId: "m2", partId: "p1", tool: "read_issues", connectionName: "Linear", status: "completed", input: { query: "not replayed" }, output: "not replayed" }),
    event(1, "user", { messageId: "m1", text: "Private agent brief and memory. Summarize today's issues" }),
    event(2, "assistant", { messageId: "m2", text: "**Report ready**" }),
    event(3, "capability_search", { name: "search_capabilities" }),
    event(5, "usage", { inputTokens: 50 }),
    event(6, "terminal", { status: "succeeded" }),
  ] })
  expect(messages).toEqual([
    { id: "event-1-1", role: "user", metadata: { opencode: { created: 101 } }, parts: [{ type: "text", text: "Summarize today's issues" }] },
    { id: "1:m2", role: "assistant", metadata: { opencode: { created: 102 } }, parts: [
      { type: "dynamic-tool", toolName: "Linear.read_issues", toolCallId: "1:p1", state: "output-available", input: {}, output: "" },
      { type: "text", text: "**Report ready**" },
    ] },
  ])
})

test("retried receipts keep colliding engine IDs separate and only the latest running tool live", () => {
  const messages = automationRunMessages({ run: { ...finishedRun, status: "running", attemptCount: 2 }, events: [
    event(1, "assistant", { messageId: "m1", text: "" }),
    event(2, "capability_execution", { messageId: "m1", callId: "p1", name: "read_issues", status: "pending" }),
    event(1, "assistant", { messageId: "m1", text: "" }, 2),
    event(2, "capability_execution", { messageId: "m1", callId: "p1", name: "read_issues", status: "pending" }, 2),
  ] })
  expect(messages.map(({ id }) => id)).toEqual(["1:m1", "2:m1"])
  expect(messages[0]?.parts[0]).toMatchObject({ toolCallId: "1:p1", state: "output-error", errorText: "This step did not finish." })
  expect(messages[1]?.parts[0]).toMatchObject({ toolCallId: "2:p1", state: "input-available" })
})

test("a summary fills an empty receipt without replaying structured results or injecting trusted markup", () => {
  expect(automationRunMessages({ run: { ...finishedRun, resultSummary: '{"count":2}' }, events: [] })).toEqual([])
  expect(automationRunMessages({ run: { ...finishedRun, status: "queued" }, events: [] })).toEqual([])
  expect(automationRunMessages({ run: { ...finishedRun, resultSummary: '<pre data-openwork-shiki="true">hi</pre>' }, events: [] })[0]?.parts)
    .toEqual([{ type: "text", text: "<pre data-openwork-shiki=&quot;true&quot;>hi</pre>" }])
})

test("legacy receipts stay unchanged with flag off and saved workflows stay on their existing surface", () => {
  expect(showsAutomationExecutionTranscript(false, { actionKind: "agent", hasExecutionThread: true, agentId: "agent-1" })).toBe(false)
  expect(showsAutomationExecutionTranscript(true, { actionKind: "saved_script", hasExecutionThread: true })).toBe(false)
  expect(showsAutomationExecutionTranscript(true, { hasExecutionThread: false })).toBe(false)
  expect(showsAutomationExecutionTranscript(true, { actionKind: "agent", hasExecutionThread: false })).toBe(true)
  expect(showsAutomationExecutionTranscript(true, { hasExecutionThread: true })).toBe(true)
  expect(showsAutomationExecutionTranscript(true, { hasExecutionThread: false, agentId: "agent-1" })).toBe(true)
})
