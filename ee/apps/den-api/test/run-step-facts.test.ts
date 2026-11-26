import assert from "node:assert/strict"
import { test } from "node:test"
import { runStepConnectionName, runStepConnector, runStepOutcome } from "../src/automations/run-step-facts.js"

const connectionId = "emc_00000000000000000000000001"
const longTool = "a".repeat(200)
const parsedNames = new Map([
  [`mcp:${connectionId}:linear_create_issue`, { connectionId, toolName: "linear_create_issue" }],
  [`native:${connectionId}:postCapabilitiesGoogleWorkspaceGmailDrafts`, { connectionId, toolName: "postCapabilitiesGoogleWorkspaceGmailDrafts" }],
  [`mcp:${connectionId}:${longTool}`, { connectionId, toolName: longTool }],
  [`mcp:${connectionId}:`, { connectionId, toolName: "" }],
  [`mcp:${connectionId}:*`, { connectionId, toolName: "*" }],
  ["native:google-workspace:list", { connectionId: "google-workspace", toolName: "list" }],
  ["mcp:invalid:list", { connectionId: "invalid", toolName: "list" }],
])
const parse = (name: string) => parsedNames.get(name) ?? null
const execute = (input: Record<string, unknown>) => runStepConnector({ name: "execute_capability", input }, parse)

test("identifies external and row-backed native capability calls without retaining arguments", () => {
  assert.deepEqual(execute({ name: `mcp:${connectionId}:linear_create_issue`, arguments: { title: "an issue" } }), { connectionId, tool: "linear_create_issue" })
  assert.deepEqual(execute({ name: `native:${connectionId}:postCapabilitiesGoogleWorkspaceGmailDrafts`, body: { message: "a draft" } }), { connectionId, tool: "postCapabilitiesGoogleWorkspaceGmailDrafts" })
})

test("does not guess a connection for other call forms or malformed capability names", () => {
  for (const name of ["linear_create_issue", "search_capabilities", "execute_capability_script"]) {
    assert.equal(runStepConnector({ name, input: { name: `mcp:${connectionId}:linear_create_issue` } }, parse), undefined)
  }
  for (const name of [undefined, 5, {}, "", "postMeAgent", "skill:guide", "native:google-workspace:list", "mcp::list", "mcp:invalid:list", `mcp:${connectionId}`, `mcp:${connectionId}:`, `mcp:${connectionId}:*`]) {
    assert.equal(execute({ name }), undefined)
  }
})

test("caps both names and does not return a split surrogate", () => {
  assert.equal(execute({ name: `mcp:${connectionId}:${"a".repeat(200)}` })?.tool, "a".repeat(128))
  assert.equal(runStepConnectionName("b".repeat(200)), "b".repeat(160))
  assert.equal(runStepConnectionName(`${"b".repeat(159)}😀`), `${"b".repeat(159)}�`)
})

test("detects exact refusal codes in JSON and MCP text wrappers", () => {
  const asked = JSON.stringify({ error: "needs_approval", message: "a private message" })
  const blocked = JSON.stringify({ error: "policy_blocked" })
  assert.equal(runStepOutcome({ isError: true, output: asked }), "asked")
  assert.equal(runStepOutcome({ isError: true, output: blocked }), "blocked")
  assert.equal(runStepOutcome({ isError: true, output: JSON.stringify({ type: "text", text: blocked }) }), "blocked")
  assert.equal(runStepOutcome({ isError: true, output: JSON.stringify({ content: [{ type: "text", text: asked }] }) }), "asked")
})

test("falls back to isError for other JSON or plain text and needs a reply to report an outcome", () => {
  assert.equal(runStepOutcome({ isError: false, output: '{"status":"created"}' }), "done")
  assert.equal(runStepOutcome({ isError: true, output: '{"message":"needs_approval"}' }), "failed")
  assert.equal(runStepOutcome({ isError: false, output: "plain text" }), "done")
  assert.equal(runStepOutcome({ isError: true, output: "plain text mentioning policy_blocked" }), "failed")
  assert.equal(runStepOutcome({ isError: false }), "done")
  assert.equal(runStepOutcome(undefined), undefined)
})
