import assert from "node:assert/strict"
import { after, test } from "node:test"
import { AUTOMATION_FREE_MODEL, automationDetailSchema } from "@openwork/types/automations"
import { bootDen, field, startFakeMcpServer, summary, text } from "./harness.js"

const tracker = await startFakeMcpServer({ tools: [{ name: "create_issue", description: "Create a tracker issue", text: "Created issue" }] })
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "self_hosted", DEN_FEATURE_PERSONAL_AGENTS: "true", DEN_FEATURE_TOOL_PERMISSIONS: "true",
} })
after(async () => { await den.close(); await tracker.close() })
const { orgId, owner: dana } = await den.createOrg(await den.signUp("Dana Reyes", "dana@acme.test"), "Self-hosted fixture")
const sam = await den.newMember(dana, orgId, "Sam Okafor")
const priya = await den.newMember(dana, orgId, "Priya Nair")
const admin = den.as(dana, orgId)
const token = await den.mintMcpToken(sam, orgId)

async function status(pending: ReturnType<typeof admin>, expected: number) {
  const result = await pending
  assert.equal(result.status, expected, summary(result))
  return result.body
}

test("self-hosted cannot enable Agents or tool permissions with operator locks", async () => {
  const org = await status(admin("GET", "/v1/org"), 200)
  assert.equal(field(org, "features", "personalAgents"), false)
  assert.equal(field(org, "features", "toolPermissions"), false)
  for (const path of ["/v1/personal-agents", "/v1/org/personal-agents", "/v1/org/tool-permissions", "/v1/tool-approvals"]) {
    await status(admin("GET", path), 404)
  }
  for (const path of ["/mcp", "/mcp/agent"]) {
    const result = await den.request(token, "POST", path, {
      headers: { accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })
    assert.equal(result.status, 200, summary(result))
    assert.match(result.text, /tools/)
    assert.doesNotMatch(result.text, /personal.?agent|tool.?approval|tool.?permission|agent_remember|agent_note_progress/i)
  }
  const discovery = await den.callMcpTool(token, "search_capabilities", { query: "personal agent tool permission approvals", type: "api", limit: 20 })
  assert.doesNotMatch(discovery.text, /\/v1\/(?:org\/)?(?:personal-agent|tool-permissions|tool-approvals)/)
})

test("ordinary Automations, member and team deletion, and connector writes still work", async () => {
  const teamId = await den.createTeam(dana, orgId, "Tracker team", [priya.memberId])
  await status(admin("DELETE", `/v1/members/${priya.memberId}`), 204)
  await status(admin("DELETE", `/v1/teams/${teamId}`), 204)
  const samApi = den.as(sam, orgId)
  const created = automationDetailSchema.parse(await status(samApi("POST", "/v1/automations", {
    name: "Tracker follow-up", instructions: "Review the tracker.", model: AUTOMATION_FREE_MODEL,
    schedule: { kind: "once", at: Date.now() + 600_000, timezone: "UTC" },
  }), 201))
  const started = await status(samApi("POST", `/v1/automations/${created.automation.id}/run`, {}), 202)
  assert.ok(["queued", "claimed", "running"].includes(text(field(started, "status") ?? field(started, "run", "status"), "run status")))
  const connection = await status(admin("POST", "/v1/mcp-connections", {
    name: "Tracker", url: `${tracker.url}/mcp`, authType: "none", access: { orgWide: true, memberIds: [], teamIds: [] },
  }), 200)
  const result = await den.callMcpTool(token, "execute_capability", { name: `mcp:${text(field(connection, "id"), "connection id")}:create_issue`, body: {} })
  assert.equal(result.isError, false, result.raw)
  assert.equal(tracker.wire.filter(({ rpcMethod }) => rpcMethod === "tools/call").length, 1)
  const { db } = await import("../../src/db.js")
  const { ToolApprovalTable } = await import("@openwork-ee/den-db/schema")
  assert.deepEqual(await db.select().from(ToolApprovalTable), [])
})
