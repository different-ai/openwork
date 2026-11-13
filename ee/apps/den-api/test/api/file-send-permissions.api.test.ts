import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const org = await den.createOrg(await den.signUp("Send Owner"), "File send permissions workspace")
const member = await den.newMember(org.owner, org.orgId, "Send Member")
const owner = den.as(org.owner, org.orgId)
const recipient = den.as(member, org.orgId)
const support = { "X-OpenWork-File-Send-Permissions": "1" }
const teamId = await den.createTeam(org.owner, org.orgId, "Reviewers", [member.memberId])
const teamPath = `/v1/agent-permissions/teams/${teamId}`
const everyonePath = "/v1/agent-permissions/everyone"
const settings = { fileSends: { decision: "deny" } }

async function policies(headers: Record<string, string> = support) {
  const result = await owner("GET", "/v1/agent-permissions", undefined, headers)
  assert.equal(result.status, 200, summary(result))
  return result
}
async function desktop(headers: Record<string, string> = support) {
  const result = await recipient("GET", "/v1/me/desktop-config", undefined, headers)
  assert.equal(result.status, 200, summary(result))
  return result
}
const sendRules = (config: Awaited<ReturnType<typeof desktop>>) =>
  list(field(config.body, "agentPermissions", "rules")).filter(rule => rule.action === "file_send")


test("Allow, Ask first and Block each reach the member's desktop with a verified member scope", async () => {
  for (const decision of ["allow", "ask", "deny"]) {
    const saved = await owner("PUT", everyonePath, { settings: { fileSends: { decision } } }, support)
    assert.equal(saved.status, 200, summary(saved))
    assert.deepEqual(field(saved.body, "policy", "settings"), { fileSends: { decision } })
    const config = await desktop()
    assert.deepEqual(field(config.body, "fileSendPermissions"), { enabled: true, organizationId: org.orgId, memberId: member.memberId })
    assert.deepEqual(sendRules(config), [{ action: "file_send", resource: "*", effect: decision, source: "Everyone" }])
  }
  // The strictest team wins over Everyone's Allow.
  assert.equal((await owner("PUT", everyonePath, { settings: { fileSends: { decision: "allow" } } }, support)).status, 200)
  assert.equal((await owner("PUT", teamPath, { settings }, support)).status, 200)
  assert.equal(sendRules(await desktop()).some(rule => rule.effect === "deny" && rule.source === "Reviewers"), true)
})

test("a desktop that does not ask for file-send rules never receives the action it cannot read", async () => {
  const config = await desktop({})
  assert.equal(field(config.body, "fileSendPermissions"), undefined)
  assert.deepEqual(sendRules(config), [])
})

test("an editor that cannot show the setting neither sees nor erases it", async () => {
  assert.equal((await owner("PUT", everyonePath, { settings }, support)).status, 200)
  for (const headers of [{}]) {
    const result = await owner("PUT", everyonePath, { settings: { fileSends: { decision: "allow" }, commands: { decision: "ask" } } }, headers)
    assert.equal(result.status, 200, summary(result))
    assert.deepEqual(field(result.body, "policy", "settings"), { commands: { decision: "ask" } })
    assert.equal(field((await policies(headers)).body, "everyone", "settings", "fileSends"), undefined)
    assert.deepEqual(field((await policies()).body, "everyone", "settings", "fileSends"), settings.fileSends)
  }
})
