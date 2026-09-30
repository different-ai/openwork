import assert from "node:assert/strict"
import { test } from "node:test"
import { FILE_LIMITS, normalizePath, runFileTool } from "../src/files.js"
import { formatToolResult, modelToolName } from "../src/mcp.js"
import { Store } from "../src/store.js"

test("paths cannot escape the session workspace", () => {
  assert.equal(normalizePath("notes/./a.md"), "notes/a.md")
  assert.equal(normalizePath("/abs/path.md"), "abs/path.md")
  assert.equal(normalizePath("../etc/passwd"), null)
  assert.equal(normalizePath("a/../../b"), null)
  assert.equal(normalizePath(""), null)
  assert.equal(normalizePath("bad\u0000name"), null)
})

test("files are isolated per session and quota-limited", () => {
  const store = new Store(":memory:")
  const a = store.createSession({})
  const b = store.createSession({})
  assert.equal(runFileTool(store, a.id, "write_file", { path: "x.md", content: "hello" }).isError, false)
  assert.equal(runFileTool(store, b.id, "read_file", { path: "x.md" }).isError, true)
  assert.equal(runFileTool(store, a.id, "edit_file", { path: "x.md", find: "hello", replace: "bye" }).isError, false)
  assert.equal(runFileTool(store, a.id, "read_file", { path: "x.md" }).output, "bye")
  const big = "x".repeat(FILE_LIMITS.maxFileBytes + 1)
  assert.equal(runFileTool(store, a.id, "write_file", { path: "big.txt", content: big }).isError, true)
  assert.equal(runFileTool(store, a.id, "write_file", { path: 7 }).isError, true)
  assert.equal(runFileTool(store, a.id, "delete_file", { path: "x.md" }).isError, false)
  assert.equal(runFileTool(store, a.id, "list_files", {}).output, "The workspace is empty.")
})

test("MCP tool names are provider-safe and never shadow built-in tools", () => {
  assert.equal(modelToolName("slack.search messages", new Set()), "slack_search_messages")
  assert.equal(modelToolName("write_file", new Set(["write_file"])), "mcp_write_file")
})

test("MCP results are flattened to bounded text", () => {
  assert.deepEqual(formatToolResult({ content: [{ type: "text", text: "a" }, { type: "image", data: "…" }] }), {
    output: "a\n[image content omitted]",
    isError: false,
  })
  assert.deepEqual(formatToolResult({ content: [], structuredContent: { n: 1 }, isError: true }), { output: "{\"n\":1}", isError: true })
  assert.ok(formatToolResult({ content: [{ type: "text", text: "z".repeat(60_000) }] }).output.includes("[truncated"))
})
