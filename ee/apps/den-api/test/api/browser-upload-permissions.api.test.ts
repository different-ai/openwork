import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const org = await den.createOrg(await den.signUp("Upload Owner"), "Upload permissions workspace")
const member = await den.newMember(org.owner, org.orgId, "Upload Member")
const owner = den.as(org.owner, org.orgId)
const recipient = den.as(member, org.orgId)
const support = { "X-OpenWork-Browser-Upload-Permissions": "1" }
const teamId = await den.createTeam(org.owner, org.orgId, "Reviewers", [member.memberId])
const teamPath = `/v1/agent-permissions/teams/${teamId}`
const everyonePath = "/v1/agent-permissions/everyone"
const settings = { browserUploads: { decision: "ask", allow: ["files.example.test"], block: ["files.example.test/private"] } }

async function enabled(value: boolean) {
  const result = await den.setFeature(org.orgId, "browserUploadPermissions", value)
  assert.equal(result.status, 200, summary(result))
}
async function policies() {
  const result = await owner("GET", "/v1/agent-permissions", undefined, support)
  assert.equal(result.status, 200, summary(result))
  return result
}
async function desktop(headers = support) {
  const result = await recipient("GET", "/v1/me/desktop-config", undefined, headers)
  assert.equal(result.status, 200, summary(result))
  return result
}

test("flag off ignores uploads in new policies, preserves strict validation and omits delivered action", async () => {
  await enabled(false)
  for (const path of [everyonePath, teamPath]) {
    const result = await owner("PUT", path, { settings }, support)
    assert.equal(result.status, 200, summary(result))
    assert.deepEqual(field(result.body, "policy", "settings"), {})
  }
  const invalid = await owner("PUT", everyonePath, { settings: { unknown: {} } }, support)
  assert.equal(invalid.status, 400, summary(invalid))
  const config = await desktop()
  assert.equal(field(config.body, "browserUploadPermissions", "enabled"), false)
  assert.equal(list(field(config.body, "agentPermissions", "rules")).some(rule => rule.action === "browser_upload"), false)
  await enabled(true)
  assert.deepEqual(field((await policies()).body, "everyone", "settings"), {})
  assert.deepEqual(list(field((await desktop()).body, "agentPermissions", "rules")), [])
})

test("admin settings roundtrip, upload Allow emits and authenticated metadata scopes to recipient", async () => {
  await enabled(true)
  for (const path of [everyonePath, teamPath]) {
    const result = await owner("PUT", path, { settings }, support)
    assert.equal(result.status, 200, summary(result))
    assert.deepEqual(field(result.body, "policy", "settings"), settings)
  }
  assert.deepEqual(field((await policies()).body, "everyone", "settings"), settings)
  assert.equal((await owner("DELETE", teamPath, undefined, support)).status, 204)
  for (const decision of ["allow", "ask", "deny"]) {
    assert.equal((await owner("PUT", everyonePath, { settings: { browserUploads: { decision }, websites: { decision: "allow" } } }, support)).status, 200)
    const config = await desktop()
    assert.deepEqual(field(config.body, "browserUploadPermissions"), { enabled: true, organizationId: org.orgId, memberId: member.memberId })
    assert.deepEqual(list(field(config.body, "agentPermissions", "rules")), [{ action: "browser_upload", resource: "*", effect: decision, source: "Everyone" }])
  }
})

test("disabled rollout and old editors cannot overwrite or delete hidden upload settings", async () => {
  await enabled(true)
  for (const path of [everyonePath, teamPath]) assert.equal((await owner("PUT", path, { settings }, support)).status, 200)
  for (const legacy of [false, true]) {
    await enabled(legacy)
    const headers = legacy ? {} : support
    const result = await owner("PUT", everyonePath, { settings: { browserUploads: { decision: "allow" }, commands: { decision: "ask" } } }, headers)
    assert.equal(result.status, 200, summary(result))
    assert.deepEqual(field(result.body, "policy", "settings"), { commands: { decision: "ask" } })
    assert.equal((await owner("DELETE", teamPath, undefined, headers)).status, 204)
    const hidden = await owner("GET", "/v1/agent-permissions", undefined, headers)
    assert.equal(field(hidden.body, "everyone", "settings", "browserUploads"), undefined)
    await enabled(true)
    const restored = await policies()
    assert.deepEqual(field(restored.body, "everyone", "settings", "browserUploads"), settings.browserUploads)
    assert.deepEqual(list(field(restored.body, "teams")).find(team => team.teamId === teamId)?.settings, settings)
  }
})

test("legacy desktops receive a conservative website block for active managed uploads, not unknown actions", async () => {
  const config = await desktop({})
  assert.equal(field(config.body, "browserUploadPermissions"), undefined)
  const rules = list(field(config.body, "agentPermissions", "rules"))
  assert.equal(rules.some(rule => rule.action === "browser_upload"), false)
  assert.deepEqual(rules.at(-1), { action: "webfetch", resource: "*", effect: "deny", source: "Browser upload policy requires an updated OpenWork app" })
  await enabled(false)
  assert.equal(list(field((await desktop({})).body, "agentPermissions", "rules")).some(rule => rule.action === "webfetch"), false)
})

test("member overrides independently govern admin reads/writes and recipient application", async () => {
  await enabled(true)
  const signedIn = await den.signIn(`platform-admin+${den.stamp}@example.test`)
  const token = text(field(signedIn.body, "token"), "platform admin session")
  const path = (id: string) => `/v1/admin/organizations/${org.orgId}/members/${id}/capabilities`
  for (const id of [org.owner.memberId, member.memberId]) {
    const result = await den.request(token, "PUT", path(id), { body: { capabilities: { browserUploadPermissions: false } } })
    assert.equal(result.status, 200, summary(result))
  }
  assert.equal(field((await policies()).body, "everyone", "settings", "browserUploads"), undefined)
  const saved = await owner("PUT", everyonePath, { settings: { browserUploads: { decision: "allow" } } }, support)
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(field(saved.body, "policy", "settings", "browserUploads"), undefined)
  const config = await desktop()
  assert.equal(field(config.body, "browserUploadPermissions", "enabled"), false)
  assert.equal(list(field(config.body, "agentPermissions", "rules")).some(rule => rule.action === "browser_upload"), false)
  for (const id of [org.owner.memberId, member.memberId]) {
    const result = await den.request(token, "PUT", path(id), { body: { capabilities: { browserUploadPermissions: null } } })
    assert.equal(result.status, 200, summary(result))
  }
  assert.deepEqual(field((await policies()).body, "everyone", "settings", "browserUploads"), settings.browserUploads)
  assert.equal(field((await desktop()).body, "browserUploadPermissions", "enabled"), true)
})
