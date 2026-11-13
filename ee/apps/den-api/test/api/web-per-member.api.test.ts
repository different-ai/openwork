import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, type Member } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud" } })
after(() => den.close())

async function workspaceWithWeb(name: string) {
  const org = await den.createOrg(await den.signUp(`${name} Owner`), `${name} workspace`)
  const designer = await den.newMember(org.owner, org.orgId, `${name} Designer`)
  const analyst = await den.newMember(org.owner, org.orgId, `${name} Analyst`)
  const granted = await den.asPlatformAdmin("PUT", `/v1/admin/organizations/${encodeURIComponent(org.orgId)}/openwork-web-access`, { enabled: true, reason: "web per member test" })
  assert.equal(granted.status, 200, summary(granted))
  return { ...org, designer, analyst }
}

function setWeb(caller: Member, orgId: string, memberId: string, enabled: boolean) {
  return den.as(caller, orgId)("POST", `/v1/members/${encodeURIComponent(memberId)}/openwork-web`, { enabled })
}

async function webAccess(member: Member, orgId: string) {
  const response = await den.as(member, orgId)("GET", "/v1/billing/web")
  assert.equal(response.status, 200, summary(response))
  return { hasAccess: field(response.body, "billing", "stripe", "web", "hasAccess"), memberHasAccess: field(response.body, "billing", "stripe", "web", "memberHasAccess") }
}

async function memberWeb(viewer: Member, orgId: string, memberId: string) {
  const roster = await den.as(viewer, orgId)("GET", "/v1/org")
  return field(list(field(roster.body, "members")).find((entry) => field(entry, "id") === memberId), "openworkWeb")
}

async function cloudInstanceStatus(member: Member, orgId: string) {
  const response = await den.as(member, orgId)("GET", "/v1/cloud/instance")
  return { status: response.status, error: field(response.body, "error") }
}


test("an admin chooses who gets Web; retired rollout writes cannot grant a Web computer", async () => {
  const org = await workspaceWithWeb("Chosen")


  // A member can't change who gets Web.
  const byMember = await setWeb(org.analyst, org.orgId, org.designer.memberId, false)
  assert.equal(byMember.status, 403, summary(byMember))

  const turnedOff = await setWeb(org.owner, org.orgId, org.designer.memberId, false)
  assert.equal(turnedOff.status, 200, summary(turnedOff))
  assert.equal(field(turnedOff.body, "openworkWeb"), false)
  // Owner and analyst keep Web: 2 of 3 people.
  assert.equal(field(turnedOff.body, "webUsers"), 2)
  assert.equal(await memberWeb(org.owner, org.orgId, org.designer.memberId), false)

  assert.deepEqual(await webAccess(org.designer, org.orgId), { hasAccess: true, memberHasAccess: false })
  assert.deepEqual(await webAccess(org.analyst, org.orgId), { hasAccess: true, memberHasAccess: true })
  assert.deepEqual(await cloudInstanceStatus(org.designer, org.orgId), { status: 403, error: "openwork_web_access_required" })
  assert.notEqual((await cloudInstanceStatus(org.analyst, org.orgId)).error, "openwork_web_access_required")

  // Turning it back on is the same switch.
  const turnedOn = await setWeb(org.owner, org.orgId, org.designer.memberId, true)
  assert.equal(field(turnedOn.body, "webUsers"), 3)
  assert.deepEqual(await webAccess(org.designer, org.orgId), { hasAccess: true, memberHasAccess: true })

  // Retired controls cannot override a member's saved Web entitlement.
  await setWeb(org.owner, org.orgId, org.designer.memberId, false)
  assert.equal((await den.setFeature(org.orgId, "webPerMember", false)).status, 200)
  assert.deepEqual(await webAccess(org.designer, org.orgId), { hasAccess: true, memberHasAccess: false })
  assert.deepEqual(await cloudInstanceStatus(org.designer, org.orgId), { status: 403, error: "openwork_web_access_required" })
})
