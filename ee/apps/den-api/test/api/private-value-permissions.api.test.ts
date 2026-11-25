import assert from "node:assert/strict"
import { after, test } from "node:test"
import { AGENT_PRIVATE_VALUES_CAPABILITY_HEADER } from "@openwork/types/den/agent-permissions"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const supported = { [AGENT_PRIVATE_VALUES_CAPABILITY_HEADER]: "1" }
const everyone = "/v1/agent-permissions/everyone"
const VALUE_ACTIONS = ["private_value_fill", "private_value_command", "private_value_paste", "private_value_terminal", "private_value_run"]
const restricted = { settings: {
  privateValueFills: { decision: "deny", allow: ["*.example.com"] },
  privateValueCommands: { block: ["security *"] },
  privateValuePaste: { decision: "deny" },
  commands: { block: ["rm *"] },
} }

async function fixture(name: string) {
  const org = await den.createOrg(await den.signUp(`${name} Owner`), `${name} workspace`)
  const member = await den.newMember(org.owner, org.orgId, `${name} Member`)
  return { ...org, member, ownerCall: den.as(org.owner, org.orgId), memberCall: den.as(member, org.orgId) }
}

function valueRules(body: unknown) {
  return list(field(body, "agentPermissions", "rules")).filter(rule => VALUE_ACTIONS.includes(String(rule.action)))
}

test("private-value rules reach only a desktop that says it reads them, in an organization where the feature is on", async () => {
  const org = await fixture("Delivery")
  assert.equal((await den.setFeature(org.orgId, "privateValues", true)).status, 200)
  const saved = await org.ownerCall("PUT", everyone, restricted, supported)
  assert.equal(saved.status, 200, summary(saved))

  const current = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.equal(current.status, 200, summary(current))
  assert.deepEqual(valueRules(current.body).map(rule => [rule.action, rule.resource, rule.effect]), [
    ["private_value_fill", "*", "deny"],
    ["private_value_fill", "*.example.com", "allow"],
    ["private_value_command", "security *", "deny"],
    ["private_value_paste", "*", "deny"],
    ["private_value_terminal", "*", "deny"],
  ])

  const old = await org.memberCall("GET", "/v1/me/desktop-config")
  assert.equal(old.status, 200, summary(old))
  assert.deepEqual(valueRules(old.body), [])
  assert.ok(list(field(old.body, "agentPermissions", "rules")).some(rule => rule.action === "shell" && rule.resource === "rm *"))

  assert.equal((await den.setFeature(org.orgId, "privateValues", false)).status, 200)
  const off = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.deepEqual(valueRules(off.body), [])
})

test("an editor that cannot show the private-value rows neither sees nor erases them", async () => {
  const org = await fixture("Preservation")
  assert.equal((await den.setFeature(org.orgId, "privateValues", true)).status, 200)
  assert.equal((await org.ownerCall("PUT", everyone, restricted, supported)).status, 200)

  const shown = await org.ownerCall("GET", "/v1/agent-permissions", undefined, supported)
  assert.equal(shown.status, 200, summary(shown))
  assert.equal(field(shown.body, "everyone", "settings", "privateValuePaste", "decision"), "deny")
  assert.deepEqual(field(shown.body, "everyone", "settings", "privateValueFills", "allow"), ["*.example.com"])

  const oldRead = await org.ownerCall("GET", "/v1/agent-permissions")
  assert.equal(oldRead.status, 200, summary(oldRead))
  assert.equal(JSON.stringify(oldRead.body).includes("privateValue"), false)
  const oldSave = await org.ownerCall("PUT", everyone, { settings: { commands: { block: ["rm *"] } } })
  assert.equal(oldSave.status, 200, summary(oldSave))
  const kept = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.equal(valueRules(kept.body).length, 5)

  const removed = await org.ownerCall("PUT", everyone, { settings: { commands: { block: ["rm *"] } } }, supported)
  assert.equal(removed.status, 200, summary(removed))
  const after = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.deepEqual(valueRules(after.body).map(rule => [rule.action, rule.effect]), [["private_value_terminal", "deny"]])
})

test("with the feature off the rows are hidden from the editor, and what was saved is kept for when it returns", async () => {
  const org = await fixture("Rollout")
  const hidden = await org.ownerCall("PUT", everyone, restricted, supported)
  assert.equal(hidden.status, 200, summary(hidden))
  const read = await org.ownerCall("GET", "/v1/agent-permissions", undefined, supported)
  assert.equal(JSON.stringify(read.body).includes("privateValue"), false)
  assert.equal((await den.setFeature(org.orgId, "privateValues", true)).status, 200)
  const none = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.deepEqual(valueRules(none.body).map(rule => [rule.action, rule.effect]), [["private_value_terminal", "deny"]])

  assert.equal((await org.ownerCall("PUT", everyone, restricted, supported)).status, 200)
  assert.equal((await den.setFeature(org.orgId, "privateValues", false)).status, 200)
  assert.equal((await org.ownerCall("PUT", everyone, { settings: {} }, supported)).status, 200)
  assert.equal((await den.setFeature(org.orgId, "privateValues", true)).status, 200)
  const back = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.equal(valueRules(back.body).length, 5)

  const forbidden = await org.memberCall("PUT", everyone, { settings: {} }, supported)
  assert.equal(forbidden.status, 403, summary(forbidden))
})

test("password managers stay out of the agent's terminal by default, and an administrator's Allow reaches the desktop", async () => {
  const org = await fixture("Terminal")
  assert.equal((await den.setFeature(org.orgId, "privateValues", true)).status, 200)
  const terminal = (body: unknown) => valueRules(body).filter(rule => rule.action === "private_value_terminal").map(rule => [rule.effect, rule.source])

  const fresh = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.deepEqual(terminal(fresh.body), [["deny", "Everyone"]])
  const old = await org.memberCall("GET", "/v1/me/desktop-config")
  assert.deepEqual(valueRules(old.body), [])

  const allowed = await org.ownerCall("PUT", everyone, { settings: { privateValueTerminal: { decision: "allow" } } }, supported)
  assert.equal(allowed.status, 200, summary(allowed))
  assert.equal(field((await org.ownerCall("GET", "/v1/agent-permissions", undefined, supported)).body, "everyone", "settings", "privateValueTerminal", "decision"), "allow")
  const lifted = await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)
  assert.deepEqual(terminal(lifted.body), [["allow", "Everyone"]])
  assert.equal(list(field(lifted.body, "agentPermissions", "rules")).some(rule => rule.action === "shell"), false)

  assert.equal((await den.setFeature(org.orgId, "privateValues", false)).status, 200)
  assert.deepEqual(valueRules((await org.memberCall("GET", "/v1/me/desktop-config", undefined, supported)).body), [])
})
