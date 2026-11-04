import assert from "node:assert/strict"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { AGENT_MCP_GUIDANCE_URI, WORKFLOW_SAVE_INSTRUCTIONS, createAgentMcpServer } from "../src/mcp/agent-server.js"
import { workflowSearchBoost } from "../src/mcp/search.js"
import { workflowRunNeedsLiveRuntime } from "../src/mcp/workflow-live-inference.js"

test("the agent testing a procedure is told to offer a save with a name, confirm with the Library link, and skip the jargon", () => {
  assert.ok(WORKFLOW_SAVE_INSTRUCTIONS.includes("offer to save it as a Workflow under a short name"))
  assert.ok(WORKFLOW_SAVE_INSTRUCTIONS.includes("\"Saved as <name>\" with its libraryUrl"))
  assert.ok(WORKFLOW_SAVE_INSTRUCTIONS.includes("never receipts, schemas, Plugins or modes"))
})

test("the guidance explains the save moment, the quiet retry and finding workflows by name", async () => {
  const server = createAgentMcpServer({ appServers: true })
  const client = new Client({ name: "workflow-guidance-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    const guidance = await client.readResource({ uri: AGENT_MCP_GUIDANCE_URI })
    const text = guidance.contents.flatMap(content => "text" in content ? [content.text] : []).join("\n")
    assert.ok(text.includes("Do not save before they agree"))
    assert.ok(text.includes("follow it without asking and tell the person only its userMessage"))
    assert.ok(text.includes("When the person asks for their workflows"))
  } finally {
    await client.close()
    await server.close()
  }
})

test("asking for workflows finds them even when the words miss their names, the person's own first", () => {
  assert.equal(workflowSearchBoost({ isWorkflow: true, ownedByCaller: true, queryTokens: ["what", "workflows", "do", "i", "have"] }), 2)
  assert.equal(workflowSearchBoost({ isWorkflow: true, ownedByCaller: false, queryTokens: ["run", "my", "workflow"] }), 1)
  assert.equal(workflowSearchBoost({ isWorkflow: true, ownedByCaller: true, queryTokens: ["morning", "brief"] }), 0)
  assert.equal(workflowSearchBoost({ isWorkflow: false, ownedByCaller: true, queryTokens: ["workflow"] }), 0)
})

test("running a saved live workflow with no input gives it today's runtime instead of crashing", () => {
  const live = "const now = Date.parse(input.runtime.now); return { now }"
  assert.equal(workflowRunNeedsLiveRuntime(live, undefined), true)
  assert.equal(workflowRunNeedsLiveRuntime(live, {}), true)
  assert.equal(workflowRunNeedsLiveRuntime("return input?.runtime?.today", null), true)
  assert.equal(workflowRunNeedsLiveRuntime(live, { day: "2026-11-03" }), false)
  assert.equal(workflowRunNeedsLiveRuntime("return { members: 1 }", undefined), false)
  assert.equal(workflowRunNeedsLiveRuntime("return input.runtimeLabel", {}), false)
})
