import assert from "node:assert/strict"
import { after, test } from "node:test"
import { AGENT_SANDBOX_MODES_CAPABILITY_HEADER, AGENT_SANDBOX_ONLY_CAPABILITY_HEADER, AGENT_SANDBOX_ONLY_UPDATE_REQUIRED_SOURCE } from "@openwork/types/den/agent-permissions"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const supported = { [AGENT_SANDBOX_ONLY_CAPABILITY_HEADER]: "1" }
const everyone = "/v1/agent-permissions/everyone"
const denied = { settings: { hostExecution: { decision: "deny" } } }
const useOnly = { settings: { sandboxOptOut: { decision: "deny" } } }
const both = { settings: { ...denied.settings, ...useOnly.settings } }
const currentHeaders = { ...supported, [AGENT_SANDBOX_MODES_CAPABILITY_HEADER]: "1" }

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
  assert.equal((await org.ownerCall("PUT", everyone, { settings: { hostExecution: { decision: "allow" } } }, supported)).status, 200)
  const removed = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.equal(rules(removed.body).some(rule => rule.action === "host_execution" && rule.effect === "deny"), false)
})

test("Use-only, Force-only, and both requirements reach only desktops that can read them", async () => {
  const org = await fixture("Sandbox modes")
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", true)).status, 200)
  const forbidden = await org.memberCall("PUT", everyone, both, currentHeaders)
  assert.equal(forbidden.status, 403, summary(forbidden))
  const compatibilityActions = ["shell", "edit", "external_directory", "computer", "computer_files", "computer_clipboard", "script", "mcp", "webfetch"]
  for (const { policy, actions } of [
    { policy: denied, actions: ["host_execution"] },
    { policy: useOnly, actions: ["sandbox_opt_out"] },
    { policy: both, actions: ["sandbox_opt_out", "host_execution"] },
  ]) {
    const saved = await org.ownerCall("PUT", everyone, policy, currentHeaders)
    assert.equal(saved.status, 200, summary(saved))
    assert.deepEqual(field(saved.body, "policy", "settings"), policy.settings)
    const clients: { headers: Record<string, string>; expectedActions: string[]; legacy?: boolean }[] = [
      { headers: currentHeaders, expectedActions: actions },
      { headers: supported, expectedActions: actions.filter(action => action === "host_execution") },
      { headers: {}, expectedActions: [], legacy: true },
    ]
    for (const { headers, expectedActions, legacy } of clients) {
      const response = await org.memberCall("GET", "/v1/me/desktop-config", undefined, headers)
      assert.equal(response.status, 200, summary(response))
      assert.deepEqual(rules(response.body).filter(rule => rule.action === "sandbox_opt_out" || rule.action === "host_execution"), expectedActions.map(action => ({ action, resource: "*", effect: "deny", source: "Everyone" })))
      const conservative = rules(response.body).filter(rule => rule.source === AGENT_SANDBOX_ONLY_UPDATE_REQUIRED_SOURCE)
      assert.deepEqual(conservative.map(rule => rule.action), legacy && actions.includes("host_execution") ? compatibilityActions : [])
    }
  }
})

test("a Force-only editor cannot see or replace a team's Use requirement, even on reset", async () => {
  const org = await fixture("Sandbox editor")
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", true)).status, 200)
  const team = await den.createTeam(org.owner, org.orgId, "Policy team", [org.member.memberId])
  const path = `/v1/agent-permissions/teams/${team}`
  assert.equal((await org.ownerCall("PUT", path, both, currentHeaders)).status, 200)
  const legacy = await org.ownerCall("GET", "/v1/agent-permissions", undefined, supported)
  assert.equal(legacy.status, 200, summary(legacy))
  assert.deepEqual(field(list(field(legacy.body, "teams")).find(item => item.teamId === team), "settings"), denied.settings)
  const saved = await org.ownerCall("PUT", path, { settings: { sandboxOptOut: { decision: "allow" } } }, supported)
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(field(saved.body, "policy", "settings"), {})
  assert.equal((await org.ownerCall("DELETE", path, undefined, supported)).status, 204)
  const current = await org.ownerCall("GET", "/v1/agent-permissions", undefined, currentHeaders)
  assert.equal(current.status, 200, summary(current))
  assert.deepEqual(field(list(field(current.body, "teams")).find(item => item.teamId === team), "settings"), useOnly.settings)
  assert.equal((await org.ownerCall("DELETE", path, undefined, currentHeaders)).status, 204)
  const removed = await org.memberCall("GET", "/v1/me/desktop-config", undefined, currentHeaders)
  assert.equal(removed.status, 200, summary(removed))
  assert.equal(rules(removed.body).some(rule => rule.action === "sandbox_opt_out"), false)
})

test("rollout off preserves each stored requirement independently and accepts removing the other", async () => {
  const org = await fixture("Independent rollout")
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", false)).status, 200)
  const ignored = await org.ownerCall("PUT", everyone, both, currentHeaders)
  assert.equal(ignored.status, 200, summary(ignored))
  assert.deepEqual(field(ignored.body, "policy", "settings"), {})
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", true)).status, 200)
  assert.equal((await org.ownerCall("PUT", everyone, both, currentHeaders)).status, 200)
  assert.equal((await den.setFeature(org.orgId, "sandboxTools", false)).status, 200)
  const visible = await org.ownerCall("GET", "/v1/agent-permissions", undefined, currentHeaders)
  assert.equal(visible.status, 200, summary(visible))
  assert.deepEqual(field(visible.body, "everyone", "settings"), both.settings)
  const keptUse = await org.ownerCall("PUT", everyone, useOnly, currentHeaders)
  assert.equal(keptUse.status, 200, summary(keptUse))
  assert.deepEqual(field(keptUse.body, "policy", "settings"), useOnly.settings)
  const notReplaced = await org.ownerCall("PUT", everyone, denied, currentHeaders)
  assert.equal(notReplaced.status, 200, summary(notReplaced))
  assert.deepEqual(field(notReplaced.body, "policy", "settings"), {})
})
