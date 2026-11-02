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
  externalFolders: { decision: "deny" },
}

async function setFeature(enabled: boolean) {
  const result = await den.setFeature(org.orgId, "agentHarnessPermissions", enabled)
  assert.equal(result.status, 200, summary(result))
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

test("flag off cannot create harness settings in a previously empty policy", async () => {
  await setFeature(false)
  for (const path of [everyonePath, teamPath]) {
    const saved = await owner("PUT", path, { settings: harness })
    assert.equal(saved.status, 200, summary(saved))
    assert.deepEqual(field(saved.body, "policy", "settings"), {})
  }
  await setFeature(true)
  const policies = await readPolicies()
  assert.deepEqual(field(policies.body, "everyone", "settings"), {})
  assert.deepEqual(list(field(policies.body, "teams")).find(entry => entry.teamId === teamId)?.settings, {})
  assert.deepEqual(await desktopRules(), [])
})

test("flag on saves and lists harness settings and delivers the member's rules", async () => {
  await setFeature(true)
  const saved = await owner("PUT", everyonePath, { settings: harness })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "policy", "settings"), harness)
  const team = await owner("PUT", teamPath, { settings: { computerUse: { decision: "ask" } } })
  assert.equal(team.status, 200, summary(team))
  const policies = await readPolicies()
  assert.deepEqual(field(policies.body, "everyone", "settings"), harness)
  assert.deepEqual(list(field(policies.body, "teams")).find(entry => entry.teamId === teamId)?.settings, { computerUse: { decision: "ask" } })
  const rules = await desktopRules()
  for (const [action, effect] of [["computer", "ask"], ["script", "deny"], ["external_directory", "deny"]]) {
    assert.ok(rules.some(rule => rule.action === action && rule.resource === "*" && rule.effect === effect), JSON.stringify(rules))
  }
})

test("flag off hides harness settings, ignores incoming ones and preserves stored Everyone and team settings", async () => {
  await setFeature(true)
  assert.equal((await owner("PUT", everyonePath, { settings: harness })).status, 200)
  assert.equal((await owner("PUT", teamPath, { settings: harness })).status, 200)
  await setFeature(false)
  const hidden = await readPolicies()
  assert.deepEqual(field(hidden.body, "everyone", "settings"), {})
  assert.deepEqual(list(field(hidden.body, "teams")).find(entry => entry.teamId === teamId)?.settings, {})
  const incoming = { computerUse: { decision: "allow" }, appScripting: { decision: "allow" }, externalFolders: { decision: "allow" }, commands: { decision: "ask" } }
  for (const path of [everyonePath, teamPath]) {
    const saved = await owner("PUT", path, { settings: incoming })
    assert.equal(saved.status, 200, summary(saved))
    assert.deepEqual(field(saved.body, "policy", "settings"), { commands: { decision: "ask" } })
  }
  const rules = await desktopRules()
  assert.equal(rules.some(rule => AGENT_HARNESS_PERMISSION_ACTIONS.some(action => action === rule.action)), false)
  assert.ok(rules.some(rule => rule.action === "shell" && rule.effect === "ask"))
  await setFeature(true)
  const restored = await readPolicies()
  const expected = { ...harness, commands: { decision: "ask" } }
  assert.deepEqual(field(restored.body, "everyone", "settings"), expected)
  assert.deepEqual(list(field(restored.body, "teams")).find(entry => entry.teamId === teamId)?.settings, expected)
})

test("clearing a team's visible settings while off preserves its harness settings", async () => {
  await setFeature(true)
  assert.equal((await owner("PUT", teamPath, { settings: harness })).status, 200)
  await setFeature(false)
  const removed = await owner("DELETE", teamPath)
  assert.equal(removed.status, 204, summary(removed))
  await setFeature(true)
  const restored = await readPolicies()
  assert.deepEqual(list(field(restored.body, "teams")).find(entry => entry.teamId === teamId)?.settings, harness)
})

test("member overrides govern list, save and desktop delivery rather than only organization state", async () => {
  await setFeature(true)
  assert.equal((await owner("PUT", everyonePath, { settings: harness })).status, 200)
  assert.equal((await owner("DELETE", teamPath)).status, 204)
  const signedIn = await den.signIn(`platform-admin+${den.stamp}@example.test`)
  const adminToken = text(field(signedIn.body, "token"), "platform admin session")
  const path = (memberId: string) => `/v1/admin/organizations/${org.orgId}/members/${memberId}/capabilities`
  for (const memberId of [org.owner.memberId, member.memberId]) {
    const result = await den.request(adminToken, "PUT", path(memberId), { body: { capabilities: { agentHarnessPermissions: false } } })
    assert.equal(result.status, 200, summary(result))
  }
  assert.deepEqual(field((await readPolicies()).body, "everyone", "settings"), {})
  const saved = await owner("PUT", everyonePath, { settings: { computerUse: { decision: "deny" } } })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "policy", "settings"), {})
  assert.equal((await desktopRules()).some(rule => AGENT_HARNESS_PERMISSION_ACTIONS.some(action => action === rule.action)), false)
  for (const memberId of [org.owner.memberId, member.memberId]) {
    const result = await den.request(adminToken, "PUT", path(memberId), { body: { capabilities: { agentHarnessPermissions: null } } })
    assert.equal(result.status, 200, summary(result))
  }
  assert.deepEqual(field((await readPolicies()).body, "everyone", "settings"), harness)
  assert.ok((await desktopRules()).some(rule => rule.action === "computer" && rule.effect === "ask"))
})
