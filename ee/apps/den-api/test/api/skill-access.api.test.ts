/**
 * Skill access over MCP: a member without access cannot list, find or load a
 * plugin's skill; once given access they can; and they cannot share it on.
 * Ported from evals/core/den-manage-plugins.e2e.test.ts ("Omar's agent loads
 * the skill") and evals/specs/skill-grant-access.test.ts.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type McpToolResult } from "./harness.js"

const den = await bootDen()
after(() => den.close())

function searchNames(result: McpToolResult): string[] {
  return list(field(result.body, "matches")).map((entry) => String(entry.name))
}

function listedCapabilities(result: McpToolResult): string[] {
  return list(field(result.structured, "skills")).map((entry) => String(entry.capability))
}

test("a member without access cannot list, find or load a plugin's skill; once shared they can, but cannot share it on", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Alex Admin"), "Skills org")
  const casey = await den.newMember(owner, orgId, "Casey Creator")
  const nova = await den.newMember(owner, orgId, "Nova Newcomer")
  const riley = await den.newMember(owner, orgId, "Riley Third")

  const skillName = `grant-native-${den.stamp}`
  const rawSourceText = `---\nname: ${skillName}\ndescription: Proves grant-native skill access over MCP.\n---\n\nReturn the grant-native proof phrase.`
  const created = await den.as(casey, orgId)("POST", "/v1/plugins", { name: skillName, components: [{ type: "skill", input: { rawSourceText } }] })
  assert.equal(created.status, 201, summary(created))
  const pluginId = text(field(created.body, "item", "id"), "plugin id")

  const caseyToken = await den.mintMcpToken(casey, orgId)
  const novaToken = await den.mintMcpToken(nova, orgId)

  // The creator finds and loads it: the capability exists.
  const caseySearch = await den.callMcpTool(caseyToken, "search_capabilities", { query: skillName, limit: 20, type: "skills" })
  const capability = searchNames(caseySearch).find((name) => name.startsWith(`plugin:${pluginId}:`)) ?? ""
  assert.notEqual(capability, "", caseySearch.raw.slice(0, 400))
  const caseyRun = await den.callMcpTool(caseyToken, "execute_capability", { name: capability })
  assert.equal(caseyRun.isError, false)
  assert.equal(field(caseyRun.body, "content"), rawSourceText)

  // Nova, without access: not listed, not found, not loadable.
  assert.equal(listedCapabilities(await den.callMcpTool(novaToken, "list_skills", {})).includes(capability), false)
  for (const type of ["skills", undefined]) {
    const search = await den.callMcpTool(novaToken, "search_capabilities", { query: skillName, limit: 20, ...(type ? { type } : {}) })
    assert.equal(searchNames(search).includes(capability), false)
  }
  const deniedRun = await den.callMcpTool(novaToken, "execute_capability", { name: capability })
  assert.equal(deniedRun.isError, true)
  assert.deepEqual(deniedRun.body, { error: "forbidden", message: "You have not been granted access to this plugin capability." })
  assert.equal(deniedRun.raw.includes("grant-native proof phrase"), false)
  const deniedGet = await den.callMcpTool(novaToken, "get_skill", { name: capability })
  assert.equal(deniedGet.isError, true)
  assert.equal(field(deniedGet.body, "error"), "unknown_skill")
  assert.equal(deniedGet.raw.includes("grant-native proof phrase"), false)

  // Casey shares it with Nova.
  const shared = await den.as(casey, orgId)("POST", `/v1/plugins/${pluginId}/access`, { orgMembershipId: nova.memberId, role: "viewer" })
  assert.equal(shared.status, 201, summary(shared))
  assert.equal(searchNames(await den.callMcpTool(novaToken, "search_capabilities", { query: skillName, limit: 20, type: "skills" })).includes(capability), true)
  assert.deepEqual(listedCapabilities(await den.callMcpTool(novaToken, "list_skills", { query: skillName })), [capability])
  const sharedRun = await den.callMcpTool(novaToken, "execute_capability", { name: capability })
  assert.equal(sharedRun.isError, false)
  assert.equal(field(sharedRun.body, "content"), rawSourceText)
  const sharedGet = await den.callMcpTool(novaToken, "get_skill", { name: capability })
  assert.equal(sharedGet.isError, false)
  assert.equal(field(sharedGet.structured, "capability"), capability)

  // A viewer cannot share it on.
  const reshared = await den.as(nova, orgId)("POST", `/v1/plugins/${pluginId}/access`, { orgMembershipId: riley.memberId, role: "viewer" })
  assert.equal(reshared.status, 403, summary(reshared))
  const rileyToken = await den.mintMcpToken(riley, orgId)
  const rileyRun = await den.callMcpTool(rileyToken, "execute_capability", { name: capability })
  assert.equal(rileyRun.isError, true)
})
