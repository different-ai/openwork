import { expect, test } from "bun:test"
import type { DynamicToolUIPart } from "ai"
import { automationProposalCalls, automationProposalsInParts, isAutomationProposalToolPart, parseAutomationProposal } from "../src/components/tools/openwork-automation-proposal"

const envelope = JSON.stringify({
  ok: true,
  id: "automation.propose",
  result: { kind: "automation-proposal", created: false, proposal: { name: "Morning summary", instructions: "Summarize my inbox.", schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 } } },
})

const script = (details: unknown[], calls: unknown[]): DynamicToolUIPart => ({
  type: "dynamic-tool", toolName: "execute", toolCallId: "script", state: "output-available", input: {}, output: envelope,
  callProviderMetadata: { openwork: { codeMode: { calls, details } } },
} as DynamicToolUIPart)

test("a proposal made from a script is found with its content-list result", () => {
  const input = { id: "automation.propose", args: {} }
  const part = script(
    [{ invocationId: "script:0", ordinal: 0, tool: "openwork_execute", input, status: "completed", startedAt: 1, output: [{ type: "text", text: envelope }] }],
    [{ tool: "openwork_execute", status: "completed", input }],
  )
  const found = automationProposalCalls(part)
  expect(found).toHaveLength(1)
  expect(found[0]?.toolCallId).toBe("script:call:0")
  expect(parseAutomationProposal(found[0]?.output)?.name).toBe("Morning summary")
})

test("other script calls and other commands are not proposals", () => {
  const other = JSON.stringify({ ok: true, id: "session.rename", result: {} })
  const part = script(
    [{ invocationId: "script:0", ordinal: 0, tool: "openwork_execute", status: "completed", startedAt: 1, output: [{ type: "text", text: other }] }],
    [{ tool: "openwork_execute", status: "completed" }],
  )
  expect(automationProposalCalls(part)).toEqual([])
  expect(parseAutomationProposal([{ type: "text", text: "not json" }])).toBeNull()
  expect(parseAutomationProposal([])).toBeNull()
})

test("a direct proposal step still reads its text result", () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork_execute", toolCallId: "direct", state: "output-available", input: {}, output: envelope }
  expect(isAutomationProposalToolPart(part)).toBe(true)
  expect(automationProposalCalls(part)).toEqual([])
})

test("a turn's proposals are collected whether made directly or from a script", () => {
  const input = { id: "automation.propose", args: {} }
  const fromScript = script(
    [{ invocationId: "script:0", ordinal: 0, tool: "openwork_execute", input, status: "completed", startedAt: 1, output: [{ type: "text", text: envelope }] }],
    [{ tool: "openwork_execute", status: "completed", input }],
  )
  const direct: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork_execute", toolCallId: "direct", state: "output-available", input: {}, output: envelope }
  const other: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork_execute", toolCallId: "other", state: "output-available", input: {}, output: JSON.stringify({ ok: true, id: "session.rename", result: {} }) }
  const found = automationProposalsInParts([{ type: "text", text: "Drafting it." }, direct, other, fromScript])
  expect(found.map((part) => part.toolCallId)).toEqual(["direct", "script:call:0"])
})
