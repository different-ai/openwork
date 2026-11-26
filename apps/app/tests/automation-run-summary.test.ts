import { expect, test } from "bun:test"
import type { AutomationRunEvent } from "@openwork/types/automations"

import { renderMarkdownHtml } from "../src/components/markdown/markdown-primitive"
import { runMarkdownText, runResultData, runSteps, runTextPreview, runToolPreview, runToolSummary, runUsageLabel, toolLabel } from "../src/react-app/domains/automations/automation-run-summary"

function event(type: AutomationRunEvent["type"], payload: AutomationRunEvent["payload"], time = 1): AutomationRunEvent {
  return { id: `event-${time}`, runId: "private-run", attempt: 1, sequence: time, type, payload, createdAt: time }
}

const issue = { tool: "linear_create_issue", connectionName: "Linear" }

test("labels strip only the leading connection prefix and use sentence case", () => {
  expect(toolLabel("linear_create_issue", "Linear")).toBe("Create issue")
  expect(toolLabel("google_calendar_list_events", "Google Calendar")).toBe("List events")
  expect(toolLabel("find_linear_issue", "Linear")).toBe("Find linear issue")
  expect(toolLabel("send_message", null)).toBe("Send message")
})

test("groups by connection and tool in first-seen order with the worst outcome", () => {
  const events = [
    event("capability_execution", { ...issue, outcome: "failed" }),
    event("capability_execution", { ...issue, connectionName: "Second Linear", outcome: "done" }),
    event("capability_execution", { ...issue, tool: "linear_read_issue", outcome: "done" }),
    event("capability_execution", { ...issue, outcome: "blocked" }),
    event("capability_execution", { ...issue, tool: "linear_read_issue", outcome: "failed" }),
    event("capability_execution", { ...issue, outcome: "asked" }),
    event("capability_execution", { ...issue, outcome: "done" }),
  ]
  expect(runToolSummary(events)).toEqual([
    { ...issue, label: "Create issue", count: 4, outcome: "asked" },
    { ...issue, connectionName: "Second Linear", label: "Linear create issue", count: 1, outcome: "done" },
    { ...issue, tool: "linear_read_issue", label: "Read issue", count: 2, outcome: "failed" },
  ])
  expect(runToolSummary(events.slice(0, 4))[0]?.outcome).toBe("blocked")
})

test("older gateway calls become generic lines, while local tools appear only in steps", () => {
  const events = [
    event("capability_search", { query: "issues" }),
    event("capability_execution", { name: "execute_capability" }),
    event("capability_execution", { name: "openwork_cloud_search_capabilities" }),
    event("capability_execution", { name: "list_tools" }),
    event("capability_execution", { name: "openwork-cloud_invoke_capability" }),
    event("capability_execution", { name: "list_files" }),
    event("capability_execution", { name: "readFile" }),
  ]
  expect(runToolSummary(events, [{ toolName: issue.tool }])).toEqual([
    { tool: null, connectionName: null, label: "Looked for tools", count: 3, outcome: "done" },
    { tool: null, connectionName: null, label: "Used a connected app", count: 2, outcome: "done" },
  ])
  expect(runToolSummary([event("assistant", { text: "Done" })])).toEqual([])
  expect(runSteps(events).slice(-2).map((step) => step.label)).toEqual(["List files", "Read file"])
})

test("pending approvals do not invent an outcome when the event has none", () => {
  const pending = [{ toolName: issue.tool, connectionName: issue.connectionName }]
  expect(runToolSummary([event("capability_execution", issue)], pending)[0]?.outcome).toBe("done")
  expect(runToolSummary([event("capability_execution", { ...issue, outcome: "done" })], pending)[0]?.outcome).toBe("done")
  expect(runToolSummary([event("capability_execution", { ...issue, connectionName: "Other" })], pending)[0]?.outcome).toBe("done")
})

test("steps keep meaningful text and times but not empty replies, raw payloads, or ids", () => {
  const steps = runSteps([
    event("user", { text: "Create an issue", messageId: "private-message" }, 1),
    event("assistant", { text: "", messageId: "private-message" }, 2),
    event("assistant", { text: " \t\n " }, 3),
    event("assistant", { text: "It needs approval" }, 4),
    event("capability_execution", { ...issue, name: "execute_capability", callId: "private-call", outcome: "asked" }, 5),
    event("capability_execution", { name: "execute_capability", payload: { internal: true } }, 6),
    event("capability_search", { query: "issues" }, 7),
    event("warning", { message: "Check your sign-in" }, 8),
    event("warning", { code: "private-warning" }, 9),
    event("terminal", { status: "succeeded", model: "private-model" }, 10),
    event("terminal", { status: "failed" }, 11),
    event("terminal", { status: "cancelled" }, 12),
  ])
  expect(steps).toEqual([
    { kind: "user", label: "Instructions", detail: "Create an issue", time: 1 },
    { kind: "assistant", label: "Reply", detail: "It needs approval", time: 4 },
    { kind: "capability_execution", label: "Used Create issue in Linear", detail: "Asked for a yes", time: 5 },
    { kind: "capability_execution", label: "Used a connected app", time: 6 },
    { kind: "capability_search", label: "Looked for tools", time: 7 },
    { kind: "warning", label: "Note", detail: "Check your sign-in", time: 8 },
    { kind: "terminal", label: "Finished", time: 10 },
    { kind: "terminal", label: "Failed", time: 11 },
    { kind: "terminal", label: "Cancelled", time: 12 },
  ])
})

test("usage has no trailing dash, reports known cost, and skips empty token counts", () => {
  const usage = { inputTokens: 58_693, outputTokens: 1_570, costMicros: null }
  expect(runSteps([
    event("usage", usage, 1),
    event("usage", { ...usage, costMicros: 12_300 }, 2),
    event("usage", { inputTokens: null, outputTokens: null, costMicros: 0 }, 3),
    event("usage", { inputTokens: null, outputTokens: 0, costMicros: "unknown" }, 4),
  ])).toEqual([
    { kind: "usage", label: "Tokens: 58,693 in · 1,570 out", time: 1 },
    { kind: "usage", label: "Tokens: 58,693 in · 1,570 out · $0.0123", time: 2 },
    { kind: "usage", label: "Tokens: 0 out", time: 4 },
  ])
})


test("asked is historical unless a matching approval is pending; legacy errors are failures", () => {
  const asked = event("capability_execution", { ...issue, outcome: "asked" })
  expect(runSteps([asked], [{ toolName: issue.tool, connectionName: "Other" }])[0]?.detail).toBe("Asked for a yes")
  expect(runSteps([asked], [{ toolName: issue.tool, connectionName: "Linear" }])[0]?.detail).toBe("Waiting for your yes")
  expect(runSteps([event("capability_execution", { name: "list_files", status: "error" })])[0]?.detail).toBe("Did not work")
  expect(runSteps([event("capability_execution", { ...issue })])[0]?.detail).toBeUndefined()
  expect(runToolSummary([event("capability_execution", { name: "execute_capability", status: "error" })])[0]?.outcome).toBe("failed")
})

test("run previews clamp long content and show six tool lines", () => {
  const text = "A".repeat(1201)
  expect(runTextPreview(text, 1200, false)).toEqual({ long: true, text: `${text.slice(0, 1200)}…` })
  expect(runTextPreview(text, 1200, true)).toEqual({ long: true, text })
  expect(runTextPreview("Short", 1200, false)).toEqual({ long: false, text: "Short" })
  const lines = runToolSummary(Array.from({ length: 8 }, (_, i) => event("capability_execution", { tool: `test_${i}` })))
  expect(runToolPreview(lines)).toEqual({ visible: lines.slice(0, 6), remaining: 2 })
  expect(runToolPreview(lines.slice(0, 2))).toEqual({ visible: lines.slice(0, 2), remaining: 0 })
})

test("structured results are formatted separately from Markdown prose", () => {
  expect(runResultData('{"ready":true}')).toBe('{\n  "ready": true\n}')
  expect(runResultData('[1,2]')).toBe('[\n  1,\n  2\n]')
  expect(runResultData("**Ready**")).toBeNull()
  expect(runResultData(null)).toBeNull()
})

test("run Markdown renders emphasis and lists, not source HTML", () => {
  const html = renderMarkdownHtml(runMarkdownText('**Status badge**\n\n- Ready\n\n<details data-openwork-shiki="true">Raw</details>\n\n<div>More raw</div>'), "remote")
  expect(html).toContain("<strong>Status badge</strong>")
  expect(html).toMatch(/<li[^>]*>Ready/)
  expect(html).not.toContain("<details")
  expect(html).not.toContain("More raw")
})

test("history omits usage cost and the Tokens prefix", () => {
  expect(runUsageLabel({ inputTokens: 78_346, outputTokens: 1_907, costMicros: 100 }, true)).toBe("78,346 in · 1,907 out")
  expect(runUsageLabel({ inputTokens: null, outputTokens: null }, true)).toBeNull()
})
