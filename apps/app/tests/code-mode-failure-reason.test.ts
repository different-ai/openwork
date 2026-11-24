import { expect, test } from "bun:test"
import type { DynamicToolUIPart } from "ai"
import { codeModeFailureReason, shortFailureText } from "../src/lib/code-mode-summary"

const failed = (toolCallId: string, errorText: string): DynamicToolUIPart => ({ type: "dynamic-tool", toolName: "openwork-cloud_execute_capability_script", toolCallId, state: "output-error", input: {}, errorText })
const ok = (toolCallId: string): DynamicToolUIPart => ({ type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId, state: "output-available", input: {}, output: "{}" })

test("a failed script group says why in one line instead of a bare count", () => {
  const script = failed("script", "Error: {\"error\":\"script_failed\",\"message\":\"tools.workshop_jira.jira_search is not a function. Check the tool path.\"}")
  expect(codeModeFailureReason(ok("group"), [script], false)).toBe("tools.workshop_jira.jira_search is not a function.")
  // The script's own error wins over a child's.
  expect(codeModeFailureReason(failed("group", "Script timed out after 30s."), [script], false)).toBe("Script timed out after 30s.")
  // Several different failures, or a run still going, show no single reason.
  expect(codeModeFailureReason(ok("group"), [script, failed("other", "denied")], false)).toBeNull()
  expect(codeModeFailureReason(ok("group"), [script], true)).toBeNull()
})

test("a dropped connection reads as one plain sentence, not the engine's raw error", () => {
  const dropped = 'MCP tool "search_capabilities" on server "openwork-cloud" failed: ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()'
  expect(shortFailureText(dropped)).toBe("The connection dropped. Trying again usually works.")
  expect(codeModeFailureReason(ok("group"), [failed("call", dropped)], false)).toBe("The connection dropped. Trying again usually works.")
  // A tool's own answer is kept: it says more than a generic sentence.
  expect(shortFailureText("Channel not found. Check the name.")).toBe("Channel not found.")
})
