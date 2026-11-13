import assert from "node:assert/strict"
import { after, test } from "node:test"
import { AGENT_HARNESS_PERMISSION_ACTIONS } from "@openwork/types/den/agent-permissions"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const org = await den.createOrg(await den.signUp("Permission Owner"), "Harness permissions workspace")
const member = await den.newMember(org.owner, org.orgId, "Test Member")
const owner = den.as(org.owner, org.orgId)
const asMember = den.as(member, org.orgId)
const teamId = await den.createTeam(org.owner, org.orgId, "Contractors", [member.memberId])
const teamPath = `/v1/agent-permissions/teams/${teamId}`
const everyonePath = "/v1/agent-permissions/everyone"
const harness = {
  computerUse: { decision: "ask" },
  appScripting: { decision: "deny" },
  computerFiles: { decision: "ask" },
  computerClipboard: { decision: "deny" },
  externalFolders: { decision: "deny" },
}

async function readPolicies() {
  const result = await owner("GET", "/v1/agent-permissions")
  assert.equal(result.status, 200, summary(result))
  return result
}

async function desktopRules() {
  const result = await asMember("GET", "/v1/me/desktop-config")
  assert.equal(result.status, 200, summary(result))
  return list(field(result.body, "agentPermissions", "rules"))
}

test("saves and lists harness settings and delivers the member's rules", async () => {
  const saved = await owner("PUT", everyonePath, { settings: harness })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "policy", "settings"), harness)
  const team = await owner("PUT", teamPath, { settings: { computerUse: { decision: "ask" } } })
  assert.equal(team.status, 200, summary(team))
  const policies = await readPolicies()
  assert.deepEqual(field(policies.body, "everyone", "settings"), harness)
  assert.deepEqual(list(field(policies.body, "teams")).find(entry => entry.teamId === teamId)?.settings, { computerUse: { decision: "ask" } })
  const rules = await desktopRules()
  for (const [action, effect] of [["computer", "ask"], ["computer_files", "ask"], ["computer_clipboard", "deny"], ["script", "deny"], ["external_directory", "deny"]]) {
    assert.ok(rules.some(rule => rule.action === action && rule.resource === "*" && rule.effect === effect), JSON.stringify(rules))
  }
})

test("computer use denial restricts scripting and preserves saved policies", async () => {
  const settings = { computerUse: { decision: "deny" }, appScripting: { decision: "ask" }, externalFolders: { decision: "deny" }, commands: { decision: "ask" } }
  // Exercise both Everyone's and team-only computer deny, including inheritance.
  for (const scope of [everyonePath, teamPath]) {
    assert.equal((await owner("PUT", everyonePath, { settings: {} })).status, 200)
    assert.equal((await owner("DELETE", teamPath)).status, 204)
    assert.equal((await owner("PUT", scope, { settings })).status, 200)
    {
      const rules = await desktopRules()
      assert.equal(rules.some(rule => rule.action === "computer"), true, JSON.stringify(rules))
      assert.ok(rules.some(rule => rule.action === "script" && rule.effect === "deny"), JSON.stringify(rules))
      assert.equal(rules.some(rule => rule.action === "script" && rule.effect === "deny"), true)
      assert.ok(rules.some(rule => rule.action === "external_directory" && rule.effect === "deny"))
      assert.ok(rules.some(rule => rule.action === "shell" && rule.effect === "ask"))
      const policies = await readPolicies()
      const stored = scope === everyonePath ? field(policies.body, "everyone", "settings") : list(field(policies.body, "teams")).find(entry => entry.teamId === teamId)?.settings
      assert.deepEqual(stored, settings)
    }
  }
})
