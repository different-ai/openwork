import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const org = await den.createOrg(await den.signUp("Feature Owner"), "Member feature workspace")
const target = await den.newMember(org.owner, org.orgId, "Selected Member")
const peer = await den.newMember(org.owner, org.orgId, "Unchanged Member")
const other = await den.createOrg(target, "Other feature workspace")
assert.equal((await den.setFeature(org.orgId, "nativeDictation", false)).status, 200)
const signedIn = await den.signIn(`platform-admin+${den.stamp}@example.test`)
const adminToken = text(field(signedIn.body, "token"), "platform admin session")
const path = (organizationId = org.orgId, memberId = target.memberId) => `/v1/admin/organizations/${organizationId}/members/${memberId}/capabilities`
const change = (value: boolean | null) => den.request(adminToken, "PUT", path(), { body: { capabilities: { nativeDictation: value } } })
const feature = async (token: string, orgId = org.orgId) => {
  const result = await den.request(token, "GET", "/v1/org", { orgId })
  assert.equal(result.status, 200, summary(result))
  return field(result.body, "features", "nativeDictation")
}

test("only a platform administrator can read or change a member's features", async () => {
  for (const token of [null, org.owner.token, target.token]) {
    const expected = token ? 403 : 401
    for (const method of ["GET", "PUT"] as const) {
      const result = await den.request(token, method, path(), { body: method === "PUT" ? { capabilities: { nativeDictation: true } } : undefined })
      assert.equal(result.status, expected, summary(result))
    }
  }
})

test("one member's override persists, stays within their organization, and resets to inheritance", async () => {
  assert.equal((await den.setFeature(org.orgId, "nativeDictation", false)).status, 200)
  assert.equal((await den.setFeature(other.orgId, "nativeDictation", false)).status, 200)
  assert.equal(await feature(target.token), false)
  const saved = await change(true)
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(field(saved.body, "featureStates", "nativeDictation", "source"), "member")
  assert.equal(await feature(target.token), true)
  const runner = await den.as(target, org.orgId)("POST", "/v1/session-runners/token", {
    runnerId: "member-pilot-runner", protocolVersion: 1, supportedExecutionTargets: ["desktop"], capabilities: [],
    appVersion: "0.0.0-test", platform: "darwin", concurrency: 1,
  })
  assert.equal(runner.status, 200, summary(runner))
  const runnerToken = text(field(runner.body, "token"), "runner token")
  const work = await den.request(runnerToken, "GET", "/v1/session-runners/work")
  assert.equal(work.status, 200, summary(work))
  assert.deepEqual(field(work.body, "enginePolicy"), { upgrade: true })
  assert.equal(await feature(peer.token), false)
  assert.equal(await feature(target.token, other.orgId), false)
  const read = await den.request(adminToken, "GET", path())
  assert.equal(field(read.body, "featureStates", "nativeDictation", "override"), true)
  const reset = await change(null)
  assert.equal(reset.status, 200, summary(reset))
  assert.equal(field(reset.body, "featureStates", "nativeDictation", "override"), null)
  assert.equal(await feature(target.token), false)
  assert.equal((await den.setFeature(org.orgId, "nativeDictation", true)).status, 200)
  assert.equal((await change(false)).status, 200)
  assert.equal(await feature(target.token), false)
  assert.equal(await feature(peer.token), true)
  assert.equal((await change(null)).status, 200)
  assert.equal(await feature(target.token), true)
})

test("a member override cannot bypass the deployment kill switch", async () => {
  assert.equal((await change(true)).status, 200)
  const kill = await den.request(adminToken, "PUT", "/v1/admin/features/nativeDictation", { body: { killed: true } })
  assert.equal(kill.status, 200, summary(kill))
  assert.equal(await feature(target.token), false)
  const state = await den.request(adminToken, "GET", path())
  assert.equal(field(state.body, "featureStates", "nativeDictation", "source"), "killed")
  assert.equal((await den.request(adminToken, "PUT", "/v1/admin/features/nativeDictation", { body: { killed: false } })).status, 200)
})

test("foreign, nonexistent, pending and removed memberships cannot receive overrides", async () => {
  for (const memberId of [other.owner.memberId, createDenTypeId("member")]) {
    const result = await den.request(adminToken, "PUT", path(org.orgId, memberId), { body: { capabilities: { nativeDictation: true } } })
    assert.equal(result.status, 404, summary(result))
  }
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("API test requires isolated MySQL")
  const pendingId = createDenTypeId("member")
  await client.execute("INSERT INTO member (id, organization_id, role) VALUES (?, ?, 'member')", [pendingId, org.orgId])
  assert.equal((await den.request(adminToken, "PUT", path(org.orgId, pendingId), { body: { capabilities: { nativeDictation: true } } })).status, 404)
  await client.execute("UPDATE member SET removed_at = NOW(3) WHERE id = ?", [target.memberId])
  for (const method of ["GET", "PUT"] as const) {
    const result = await den.request(adminToken, method, path(), { body: method === "PUT" ? { capabilities: { nativeDictation: true } } : undefined })
    assert.equal(result.status, 404, summary(result))
  }
})

test("invalid identifiers and unknown feature keys are rejected", async () => {
  assert.equal((await den.request(adminToken, "GET", path("invalid"))).status, 400)
  assert.equal((await den.request(adminToken, "PUT", path(), { body: { capabilities: { unknownFeature: true } } })).status, 400)
})
