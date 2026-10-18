import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("custom team grants never alter direct Admin, and an ordinary member cannot read or replace someone else's grants", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Access Owner"), "Access workspace")
  for (const feature of ["permissions", "teamRoles", "sharedRoles"]) {
    const enabled = await den.setFeature(orgId, feature, true)
    assert.equal(enabled.status, 200, summary(enabled))
  }
  const admin = await den.newMember(owner, orgId, "Direct Admin", "admin")
  const member = await den.newMember(owner, orgId, "Plain Member")
  const ownerApi = den.as(owner, orgId)
  const memberApi = den.as(member, orgId)
  const teamId = await den.createTeam(owner, orgId, "Editors", [admin.memberId], { grantsOrganizationAdmin: true })
  const created = await ownerApi("POST", "/v1/permissions/sets", { name: "Editors role", permissions: [{ key: "teams.view", status: "allow" }] })
  assert.equal(created.status, 201, summary(created))
  const setId = text(field(created.body, "set", "id"), "custom role")
  const assigned = await ownerApi("PUT", `/v1/teams/${teamId}/permission-set`, { permissionSetId: setId })
  assert.equal(assigned.status, 200, summary(assigned))
  const roster = await ownerApi("GET", "/v1/org")
  assert.equal(list(field(roster.body, "members")).find((entry) => entry.id === admin.memberId)?.role, "admin")
  assert.equal(list(field(roster.body, "teams")).find((entry) => entry.id === teamId)?.grantsOrganizationAdmin, true)

  const own = await memberApi("GET", `/v1/members/${member.memberId}/permissions`)
  assert.equal(own.status, 200, summary(own))
  const other = await memberApi("GET", `/v1/members/${admin.memberId}/permissions`)
  assert.equal(other.status, 403, summary(other))
  assert.equal(other.text.includes("Editors role"), false)
  const deniedRole = await memberApi("PUT", `/v1/teams/${teamId}/permission-set`, { permissionSetId: null })
  assert.equal(deniedRole.status, 403, summary(deniedRole))
  const deniedAdmin = await memberApi("PATCH", `/v1/teams/${teamId}`, { grantsOrganizationAdmin: false })
  assert.equal(deniedAdmin.status, 403, summary(deniedAdmin))
  const afterDenied = await ownerApi("GET", `/v1/permissions/sets/${setId}`)
  assert.equal(list(field(afterDenied.body, "set", "teams")).some((entry) => entry.id === teamId), true)

  const removed = await ownerApi("PUT", `/v1/teams/${teamId}/permission-set`, { permissionSetId: null })
  assert.equal(removed.status, 200, summary(removed))
  const afterRemoval = await ownerApi("GET", "/v1/org")
  assert.equal(list(field(afterRemoval.body, "members")).find((entry) => entry.id === admin.memberId)?.role, "admin")
  assert.equal(list(field(afterRemoval.body, "teams")).find((entry) => entry.id === teamId)?.grantsOrganizationAdmin, true)
})
