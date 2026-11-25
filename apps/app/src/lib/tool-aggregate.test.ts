import assert from "node:assert/strict"
import { test } from "node:test"
import type { DynamicToolUIPart } from "ai"
import { getAggregateRowFile, getWorkspacePathResolutions } from "./tool-aggregate"

for (const errorText of ["Unknown: FileSystem.writeFile (/report.html)", "The user rejected permission to use this specific tool call."]) {
  test(`a failed write does not claim success: ${errorText}`, () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "write", toolCallId: "write-report",
      state: "output-error", input: { filePath: "/report.html", content: "hello" }, errorText,
    }
    assert.deepEqual(getAggregateRowFile(part), { verb: "Write failed:", path: "/report.html" })
  })
}

test("an explicitly denied write does not claim success", () => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "write", toolCallId: "write-report", state: "output-denied",
    input: { filePath: "/report.html", content: "hello" }, approval: { id: "write-approval", approved: false },
  }
  assert.deepEqual(getAggregateRowFile(part), { verb: "Write failed:", path: "/report.html" })
})

test("a successful write says Wrote and an unfinished write says Writing", () => {
  const input = { filePath: "/project/report.html", content: "hello" }
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "write", toolCallId: "write-report",
    state: "output-available", input, output: "Wrote file successfully.",
  }
  assert.equal(getAggregateRowFile(part)?.verb, "Wrote")
  for (const state of ["input-available", "input-streaming"] satisfies DynamicToolUIPart["state"][]) {
    const pending: DynamicToolUIPart = { type: "dynamic-tool", toolName: "write", toolCallId: "write-report", state, input }
    assert.equal(getAggregateRowFile(pending)?.verb, "Writing")
  }
})

test("the actual native destination wins over the model's rooted input and retains an explicit notice", () => {
  const resolved = "C:\\Users\\Tester\\Workspace\\report.html"
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "write", toolCallId: "resolved-report", state: "output-available",
    input: { filePath: "/report.html" }, output: "Wrote file successfully.",
    callProviderMetadata: { openwork: { fileDestination: resolved, workspacePaths: [{ requested: "/report.html", resolved }] } },
  }
  assert.deepEqual(getAggregateRowFile(part), { verb: "Wrote", path: resolved })
  assert.deepEqual(getWorkspacePathResolutions(part), [{ requested: "/report.html", resolved }])
})

test("a plain relative file reports the actual opened-workspace path", () => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "write", toolCallId: "relative", state: "output-available",
    input: { filePath: "report.html" }, output: "Wrote file successfully.",
    callProviderMetadata: { openwork: { fileDestination: "/opened/report.html" } },
  }
  assert.deepEqual(getWorkspacePathResolutions(part), [{ requested: "report.html", resolved: "/opened/report.html" }])
})

test("v2 path-only inputs and malformed mapping metadata do not invent a v1 file destination", () => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "write", toolCallId: "native-v2", state: "output-available",
    input: { path: "/opened/report.html" }, output: "Created file successfully.",
    callProviderMetadata: { openwork: { workspacePaths: [{ requested: 42, resolved: false }] } },
  }
  assert.equal(getAggregateRowFile(part), null)
  assert.deepEqual(getWorkspacePathResolutions(part), [])
})

test("a write without a known path does not invent a file row", () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "write", toolCallId: "write-report", state: "output-error", input: {}, errorText: "Invalid arguments" }
  assert.equal(getAggregateRowFile(part), null)
})
