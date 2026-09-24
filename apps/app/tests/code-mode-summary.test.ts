import { expect, test } from "bun:test";
import type { DynamicToolUIPart } from "ai";
import { codeModeSummary } from "../src/lib/code-mode-summary";

function call(toolName: string, state: "input-available" | "output-available" | "output-error", input: Record<string, unknown> = {}): DynamicToolUIPart {
  const base = { type: "dynamic-tool", toolName, toolCallId: `${toolName}:${state}`, input };
  if (state === "output-available") return { ...base, state, output: undefined };
  if (state === "output-error") return { ...base, state, errorText: "Unavailable" };
  return { ...base, state };
}

const serviceName = (item: DynamicToolUIPart) => item.toolName.startsWith("linear_") ? "Linear" : item.toolName.startsWith("paper_") ? "Paper" : null;
const summary = (calls: DynamicToolUIPart[], running = false, failed = false) => codeModeSummary(calls, { serviceName, running, failed });

test("read-only steps name all known services rather than the last call", () => {
  const calls = [call("linear_list_teams", "output-available"), call("paper_get_basic_info", "output-available")];
  expect(summary(calls, true)).toBe("Looking up Linear and Paper");
  expect(summary(calls)).toBe("Looked up Linear and Paper");
});

test("a single write outranks reads, regardless of their order", () => {
  const before = call("linear_list_teams", "output-available");
  const write = call("linear_create_issue", "input-available");
  const after = call("paper_get_basic_info", "output-available");
  expect(summary([before, write, after], true)).toBe("Creating an issue in Linear");
  expect(summary([before, call("linear_create_issue", "output-available"), after])).toBe("Created an issue in Linear");
});

test("a failed write does not claim success, and two writes use a generic outcome", () => {
  expect(summary([call("linear_create_issue", "output-error")])).toBe("Tried to change Linear");
  expect(summary([call("linear_create_issue", "output-available"), call("paper_update_page", "output-available")])).toBe("Changed Linear and Paper");
  expect(summary([call("linear_create_issue", "output-available")], false, true)).toBe("Couldn't finish this step");
});

test("an unknown script still has an honest label", () => {
  expect(summary([], true)).toBe("Working on this step");
  expect(summary([call("unknown", "output-available")])).toBe("Looked up information");
});
