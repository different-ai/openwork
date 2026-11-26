import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { collectRunStepFacts, runStepConnectionName, runStepConnector, runStepOutcome, type RunStepCandidate } from "../src/automations/run-step-facts.js"

const connectionId = normalizeDenTypeId("externalMcpConnection", "emc_00000000000000000000000001")
const unresolvedId = normalizeDenTypeId("externalMcpConnection", "emc_00000000000000000000000002")
const unansweredId = normalizeDenTypeId("externalMcpConnection", "emc_00000000000000000000000003")
const maxLengthTool = `A${"0_.-".repeat(32).slice(0, 127)}`
const invalidToolNames = ["a".repeat(129), "pasted text", "create_issue\n", "_create_issue", "create/issue", "créate_issue"]
const parsedNames = new Map([
  [`mcp:${connectionId}:linear_create_issue`, { connectionId, toolName: "linear_create_issue" }],
  [`native:${connectionId}:postCapabilitiesGoogleWorkspaceGmailDrafts`, { connectionId, toolName: "postCapabilitiesGoogleWorkspaceGmailDrafts" }],
  [`mcp:${connectionId}:${maxLengthTool}`, { connectionId, toolName: maxLengthTool }],
  ...invalidToolNames.map((toolName): [string, { connectionId: string; toolName: string }] => [`mcp:${connectionId}:${toolName}`, { connectionId, toolName }]),
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

test("rejects invalid tool names instead of truncating or storing them", () => {
  assert.equal(execute({ name: `mcp:${connectionId}:${maxLengthTool}` })?.tool, maxLengthTool)
  for (const tool of invalidToolNames) assert.equal(execute({ name: `mcp:${connectionId}:${tool}` }), undefined)
})

test("caps the connection name without returning a split surrogate", () => {
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

test("successful replies always report done even when their content looks like a refusal", () => {
  for (const error of ["needs_approval", "policy_blocked"]) {
    const output = JSON.stringify({ error })
    assert.equal(runStepOutcome({ isError: false, output }), "done")
    assert.equal(runStepOutcome({ isError: false, output: JSON.stringify({ content: [{ type: "text", text: output }] }) }), "done")
  }
})

test("looks up each eligible connection once in a batch and only enriches answered steps with a returned connection", async () => {
  const steps = new Map<number, RunStepCandidate>([
    [0, { connectionId, tool: "create_issue", outcome: "asked" }],
    [1, { connectionId, tool: "list_issues", outcome: "done" }],
    [2, { connectionId, tool: "list_teams" }],
    [3, { connectionId: unresolvedId, tool: "list_issues", outcome: "failed" }],
    [4, { connectionId: unansweredId, tool: "list_issues" }],
  ])
  const lookup = test.mock.fn(async (ids: string[]) => [{ id: connectionId, name: "Tracker" }])
  const facts = await collectRunStepFacts(steps, lookup)
  assert.deepEqual(lookup.mock.calls.map((call) => call.arguments), [[[connectionId, unresolvedId]]])
  assert.deepEqual([...facts], [
    [0, { tool: "create_issue", connectionName: "Tracker", outcome: "asked" }],
    [1, { tool: "list_issues", connectionName: "Tracker", outcome: "done" }],
  ])
})

test("skips lookup when there are no eligible steps", async () => {
  const lookup = test.mock.fn(async () => [])
  const facts = await collectRunStepFacts(new Map([[0, { connectionId, tool: "list_issues" }]]), lookup)
  assert.equal(facts.size, 0)
  assert.equal(lookup.mock.callCount(), 0)
})

const answered = new Map<number, RunStepCandidate>([[0, { connectionId, tool: "list_issues", outcome: "done" }]])

test("a failed lookup leaves all facts out", async () => {
  const facts = await collectRunStepFacts(answered, async () => { throw new Error("Lookup failed") })
  assert.equal(facts.size, 0)
})

test("a lookup times out after 1.5 seconds and a later rejection is handled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const pending = collectRunStepFacts(answered, () => new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Late lookup failure")), 2_000)
  }))
  t.mock.timers.tick(1_499)
  assert.equal(await Promise.race([pending, Promise.resolve("pending")]), "pending")
  t.mock.timers.tick(1)
  assert.equal((await pending).size, 0)
  t.mock.timers.tick(500)
  await setImmediate()
})
