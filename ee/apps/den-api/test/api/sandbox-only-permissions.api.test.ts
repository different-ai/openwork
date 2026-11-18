import assert from "node:assert/strict"
import { after, test } from "node:test"
import { AGENT_SANDBOX_ONLY_CAPABILITY_HEADER } from "@openwork/types/den/agent-permissions"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const supported = { [AGENT_SANDBOX_ONLY_CAPABILITY_HEADER]: "1" }
const everyone = "/v1/agent-permissions/everyone"
const denied = { settings: { hostExecution: { decision: "deny" } } }

async function fixture(name: string) {
  const org = await den.createOrg(await den.signUp(`${name} Owner`), `${name} workspace`)
  const member = await den.newMember(org.owner, org.orgId, `${name} Member`)
  const peer = await den.newMember(org.owner, org.orgId, `${name} Peer`)
  return { ...org, member, peer, ownerCall: den.as(org.owner, org.orgId), memberCall: den.as(member, org.orgId), peerCall: den.as(peer, org.orgId) }
}

function rules(body: unknown) { return list(field(body, "agentPermissions", "rules")) }

// Exercise actual authenticated routes/storage, not just the shared filter helper.
test("capable desktops receive the requirement; old clients receive known conservative rules without an unknown action", async () => {
  const org = await fixture("Compatibility")
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", true)).status, 200)
  const saved = await org.ownerCall("PUT", everyone, denied, supported)
  assert.equal(saved.status, 200, summary(saved))
  const current = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.equal(current.status, 200, summary(current))
  assert.ok(rules(current.body).some(rule => rule.action === "host_execution" && rule.effect === "deny"))
  const old = await org.memberCall("GET", "/v1/me/desktop-config")
  assert.equal(old.status, 200, summary(old))
  assert.equal(rules(old.body).some(rule => rule.action === "host_execution"), false)
  for (const action of ["shell", "edit", "external_directory", "computer", "script", "mcp", "webfetch"]) {
    assert.ok(rules(old.body).some(rule => rule.action === action && rule.effect === "deny"), action)
  }
  const forbidden = await org.memberCall("PUT", everyone, { settings: {} }, supported)
  assert.equal(forbidden.status, 403, summary(forbidden))
})

test("an old editor cannot erase a hidden team requirement and a peer outside the team is unaffected", async () => {
  const org = await fixture("Preservation")
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", true)).status, 200)
  const team = await den.createTeam(org.owner, org.orgId, "Restricted", [org.member.memberId])
  const path = `/v1/agent-permissions/teams/${team}`
  assert.equal((await org.ownerCall("PUT", path, denied, supported)).status, 200)
  const before = await org.peerCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.equal(rules(before.body).some(rule => rule.action === "host_execution" && rule.effect === "deny"), false)
  const oldRead = await org.ownerCall("GET", "/v1/agent-permissions")
  assert.equal(oldRead.status, 200, summary(oldRead))
  assert.equal(JSON.stringify(oldRead.body).includes("hostExecution"), false)
  const oldSave = await org.ownerCall("PUT", path, { settings: { commands: { decision: "allow" } } })
  assert.equal(oldSave.status, 200, summary(oldSave))
  const oldDelete = await org.ownerCall("DELETE", path)
  assert.equal(oldDelete.status, 204, summary(oldDelete))
  const stillRequired = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.ok(rules(stillRequired.body).some(rule => rule.action === "host_execution" && rule.effect === "deny"))
  const explicitRemoval = await org.ownerCall("DELETE", path, undefined, supported)
  assert.equal(explicitRemoval.status, 204, summary(explicitRemoval))
  const removed = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.equal(rules(removed.body).some(rule => rule.action === "host_execution" && rule.effect === "deny"), false)
})

test("flag off cannot introduce a managed requirement, cannot erase a saved requirement, and still permits explicit removal", async () => {
  const org = await fixture("Rollout")
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", false)).status, 200)
  assert.equal((await org.ownerCall("PUT", everyone, denied, supported)).status, 200)
  const notIntroduced = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.equal(rules(notIntroduced.body).some(rule => rule.action === "host_execution" && rule.effect === "deny"), false)
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", true)).status, 200)
  assert.equal((await org.ownerCall("PUT", everyone, denied, supported)).status, 200)
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", false)).status, 200)
  const retained = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.ok(rules(retained.body).some(rule => rule.action === "host_execution" && rule.effect === "deny"))
  const visible = await org.ownerCall("GET", "/v1/agent-permissions", undefined, supported)
  assert.equal(field(visible.body, "everyone", "settings", "hostExecution", "decision"), "deny")
  // An explicit computer choice is a managed lock, not the old implicit default.
  assert.equal((await org.ownerCall("PUT", everyone, { settings: { hostExecution: { decision: "allow" } } }, supported)).status, 200)
  const unchanged = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.ok(rules(unchanged.body).some(rule => rule.action === "host_execution" && rule.effect === "deny"))
  assert.equal((await org.ownerCall("PUT", everyone, { settings: {} }, supported)).status, 200)
  const removed = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.equal(rules(removed.body).some(rule => rule.action === "host_execution"), false)
})

test("explicit computer locks require the rollout and capability header, and default Allow remains unmanaged", async () => {
  const org = await fixture("Computer choice")
  const computer = { settings: { hostExecution: { decision: "allow" } } }
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", false)).status, 200)
  assert.equal((await org.ownerCall("PUT", everyone, computer, supported)).status, 200)
  assert.equal(rules((await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)).body).some(rule => rule.action === "host_execution"), false)
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", true)).status, 200)
  assert.equal((await org.ownerCall("PUT", everyone, computer)).status, 200)
  assert.equal(rules((await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)).body).some(rule => rule.action === "host_execution"), false)
  assert.equal((await org.ownerCall("PUT", everyone, computer, supported)).status, 200)
  const current = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.ok(rules(current.body).some(rule => rule.action === "host_execution" && rule.effect === "allow" && rule.source === "Everyone"))
  const old = await org.memberCall("GET", "/v1/me/desktop-config")
  assert.equal(rules(old.body).some(rule => rule.action === "host_execution"), false)
  assert.equal(rules(old.body).some(rule => rule.effect === "deny"), false)
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", false)).status, 200)
  assert.equal((await org.ownerCall("PUT", everyone, { settings: {} })).status, 200)
  assert.ok(rules((await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)).body).some(rule => rule.action === "host_execution" && rule.effect === "allow"))
  assert.equal((await org.ownerCall("PUT", everyone, { settings: {} }, supported)).status, 200)
  assert.equal(rules((await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)).body).some(rule => rule.action === "host_execution"), false)
})
