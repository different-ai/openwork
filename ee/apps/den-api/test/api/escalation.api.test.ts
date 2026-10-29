/**
 * Nobody can use roles, teams or Permissions to give themselves or anyone else
 * more than they hold. Ported from evals/core/team-roles*.e2e.test.ts and
 * evals/specs/permissions-escalation.test.ts.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, strings, summary, type Member } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const ADMIN_GRANT_REQUIRES_ADMIN = "Only the owner or an admin can make someone an admin."
const ADMIN_TEAM_REQUIRES_ADMIN = "Only the owner or an admin can make a team an Admin team or add people to one."

/**
 * One organization: Olivia owns it, Adam is an admin, Maya and Nora are
 * members, Tess is in the "Permission editors" team. Permissions is on.
 */
async function world(label: string) {
  const olivia = await den.signUp(`Olivia ${label}`)
  const { orgId, owner } = await den.createOrg(olivia, `Escalation ${label}`)
  const adam = await den.newMember(owner, orgId, `Adam ${label}`)
  const maya = await den.newMember(owner, orgId, `Maya ${label}`)
  const tess = await den.newMember(owner, orgId, `Tess ${label}`)
  const nora = await den.newMember(owner, orgId, `Nora ${label}`)
  const ownerCall = den.as(owner, orgId)
  const promoted = await ownerCall("POST", `/v1/members/${adam.memberId}/role`, { role: "admin" })
  assert.equal(promoted.status, 200, summary(promoted))
  const editors = await den.createTeam(owner, orgId, "Permission editors", [tess.memberId])

  async function grantTeam(teamId: string, keys: string[]): Promise<string> {
    const created = await ownerCall("POST", "/v1/permissions/sets", { teamId, permissions: keys.map((key) => ({ key, status: "allow" })) })
    assert.equal(created.status, 201, summary(created))
    return String(field(created.body, "set", "id"))
  }
  async function defaultSet(kind: "admin_default" | "member_default"): Promise<string> {
    const sets = await ownerCall("GET", "/v1/permissions/sets")
    assert.equal(sets.status, 200, summary(sets))
    return String(list(field(sets.body, "sets")).find((set) => set.kind === kind)?.id ?? "")
  }
  async function held(member: Member): Promise<{ role: string; permissions: string[] }> {
    const context = await den.as(member, orgId)("GET", "/v1/org")
    assert.equal(context.status, 200, summary(context))
    return { role: String(field(context.body, "currentMember", "directRole")), permissions: strings(field(context.body, "currentMember", "permissions")) }
  }
  /** A member's stored role, as the owner's roster shows it. */
  async function rosterRole(member: Member): Promise<string> {
    const roster = await ownerCall("GET", "/v1/org")
    return String(list(field(roster.body, "members")).find((entry) => entry.id === member.memberId)?.role)
  }
  return { orgId, owner, adam, maya, tess, nora, editors, ownerCall, grantTeam, defaultSet, held, rosterRole }
}

test("a member who may change roles and invite through a team cannot make anyone, or herself, an admin, nor demote an admin; the owner can", async () => {
  const w = await world("roles")
  await w.grantTeam(w.editors, ["members.update", "invitations.manage"])
  assert.deepEqual([...(await w.held(w.tess)).permissions].sort(), ["invitations.manage", "members.update"])
  const tess = den.as(w.tess, w.orgId)

  const promote = await tess("POST", `/v1/members/${w.maya.memberId}/role`, { role: "admin" })
  assert.equal(promote.status, 403, summary(promote))
  assert.equal(field(promote.body, "message"), ADMIN_GRANT_REQUIRES_ADMIN)

  const invite = await tess("POST", "/v1/invitations", { email: `escalation-invitee+${den.stamp}@example.test`, role: "admin" })
  assert.equal(invite.status, 403, summary(invite))
  assert.equal(field(invite.body, "message"), ADMIN_GRANT_REQUIRES_ADMIN)

  const self = await tess("POST", `/v1/members/${w.tess.memberId}/role`, { role: "admin" })
  assert.equal(self.status, 403, summary(self))
  assert.equal(field(self.body, "message"), "You can't change your own role. Ask the owner or another admin.")

  const demote = await tess("POST", `/v1/members/${w.adam.memberId}/role`, { role: "member" })
  assert.equal(demote.status, 403, summary(demote))
  assert.equal(field(demote.body, "message"), "Only the owner or an admin can change an admin's role.")

  assert.equal(await w.rosterRole(w.maya), "member")
  assert.equal(await w.rosterRole(w.tess), "member")
  assert.equal(await w.rosterRole(w.adam), "admin")

  // The same request from the owner works, so the refusals above are about who asks.
  const ownerPromote = await w.ownerCall("POST", `/v1/members/${w.maya.memberId}/role`, { role: "admin" })
  assert.equal(ownerPromote.status, 200, summary(ownerPromote))
  assert.equal(await w.rosterRole(w.maya), "admin")
})

test("even an admin allowed to change roles cannot change his own", async () => {
  const w = await world("self")
  const adminSet = await w.defaultSet("admin_default")
  const granted = await w.ownerCall("PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "members.update", status: "allow" }] })
  assert.equal(granted.status, 200, summary(granted))
  const self = await den.as(w.adam, w.orgId)("POST", `/v1/members/${w.adam.memberId}/role`, { role: "member" })
  assert.equal(self.status, 403, summary(self))
  assert.equal(field(self.body, "message"), "You can't change your own role. Ask the owner or another admin.")
  assert.equal(await w.rosterRole(w.adam), "admin")
})

test("someone who manages permissions can only hand out permissions they hold, and a non-admin cannot edit Admin permissions", async () => {
  const w = await world("grant")
  await w.grantTeam(w.editors, ["permissions.view", "permissions.manage", "teams.view"])
  const memberSet = await w.defaultSet("member_default")
  const adminSet = await w.defaultSet("admin_default")
  const tess = den.as(w.tess, w.orgId)

  const escalate = await tess("PUT", `/v1/permissions/sets/${memberSet}/permissions`, { changes: [{ key: "billing.manage", status: "allow" }] })
  assert.equal(escalate.status, 403, summary(escalate))
  assert.equal(field(escalate.body, "error"), "permission_not_held")
  assert.deepEqual(field(escalate.body, "keys"), ["billing.manage"])
  assert.equal((await w.held(w.nora)).permissions.includes("billing.manage"), false)

  const adminEdit = await tess("PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "teams.view", status: "allow" }] })
  assert.equal(adminEdit.status, 403, summary(adminEdit))
  assert.equal(field(adminEdit.body, "error"), "admin_permissions_require_admin")

  // A permission she does hold is grantable, so the refusal is about holding it.
  const allowed = await tess("PUT", `/v1/permissions/sets/${memberSet}/permissions`, { changes: [{ key: "teams.view", status: "allow" }] })
  assert.equal(allowed.status, 200, summary(allowed))
  assert.deepEqual((await w.held(w.nora)).permissions, ["teams.view"])
})

test("an admin allowed to manage permissions cannot give admins the owner-only Manage single sign-on", async () => {
  const w = await world("sso")
  const adminSet = await w.defaultSet("admin_default")
  const adam = den.as(w.adam, w.orgId)
  const before = await adam("PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "billing.manage", status: "deny" }] })
  assert.equal(before.status, 403, summary(before))
  assert.equal(field(before.body, "requiredPermission"), "permissions.manage")

  const granted = await w.ownerCall("PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "permissions.manage", status: "allow" }] })
  assert.equal(granted.status, 200, summary(granted))
  const escalate = await adam("PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "sso.manage", status: "allow" }] })
  assert.equal(escalate.status, 403, summary(escalate))
  assert.equal(field(escalate.body, "error"), "permission_not_held")
  assert.deepEqual(field(escalate.body, "keys"), ["sso.manage"])
  assert.equal((await w.held(w.adam)).permissions.includes("sso.manage"), false)
})

test("permissions held through a team cannot grow an Admin team: not an admin-through-team, not a member holding every Admin permission", async () => {
  const w = await world("adminteam")
  const opsAdmins = await den.createTeam(w.owner, w.orgId, "Ops admins", [w.maya.memberId], { grantsOrganizationAdmin: true })
  const catalog = await den.as(w.maya, w.orgId)("GET", "/v1/permissions/catalog")
  assert.equal(catalog.status, 200, summary(catalog))
  const adminDefaults = list(field(catalog.body, "permissions")).filter((entry) => strings(entry.defaultOn).includes("admin")).map((entry) => String(entry.key))
  const maya = await w.held(w.maya)
  assert.equal(maya.role, "member")
  for (const key of adminDefaults) assert.ok(maya.permissions.includes(key), `Maya holds ${key} through Ops admins`)

  // Maya, an admin only through the team, cannot add Nora to it.
  const mayaAdds = await den.as(w.maya, w.orgId)("PATCH", `/v1/teams/${opsAdmins}`, { memberIds: [w.maya.memberId, w.nora.memberId] })
  assert.equal(mayaAdds.status, 403, summary(mayaAdds))

  // Tess holds every Admin permission and Manage Admin teams through her own team, and still cannot.
  await w.grantTeam(w.editors, [...adminDefaults, "members.update", "teams.manage_admin"])
  const tess = den.as(w.tess, w.orgId)
  const add = await tess("PATCH", `/v1/teams/${opsAdmins}`, { memberIds: [w.maya.memberId, w.nora.memberId] })
  assert.equal(add.status, 403, summary(add))
  assert.equal(field(add.body, "message"), ADMIN_TEAM_REQUIRES_ADMIN)
  const promoteTeam = await tess("PATCH", `/v1/teams/${w.editors}`, { grantsOrganizationAdmin: true })
  assert.equal(promoteTeam.status, 403, summary(promoteTeam))
  assert.equal(field(promoteTeam.body, "message"), ADMIN_TEAM_REQUIRES_ADMIN)
  const promoteMaya = await tess("POST", `/v1/members/${w.maya.memberId}/role`, { role: "admin" })
  assert.equal(promoteMaya.status, 403, summary(promoteMaya))
  assert.equal(field(promoteMaya.body, "message"), ADMIN_GRANT_REQUIRES_ADMIN)
  const removeAdam = await tess("DELETE", `/v1/members/${w.adam.memberId}`)
  assert.equal(removeAdam.status, 403, summary(removeAdam))
  assert.equal(field(removeAdam.body, "message"), "Only the owner or an admin can remove an admin from the organization.")

  assert.equal((await w.held(w.nora)).permissions.includes("teams.manage"), false)
  assert.equal(await w.rosterRole(w.maya), "member")
  assert.equal(await w.rosterRole(w.adam), "admin")

  // A real admin, once the owner allows Manage Admin teams, can: the rule is about who asks.
  const adam = den.as(w.adam, w.orgId)
  const adamBefore = await adam("PATCH", `/v1/teams/${opsAdmins}`, { memberIds: [w.maya.memberId, w.nora.memberId] })
  assert.equal(adamBefore.status, 403, summary(adamBefore))
  assert.equal(field(adamBefore.body, "requiredPermission"), "teams.manage_admin")
  const adminSet = await w.defaultSet("admin_default")
  const granted = await w.ownerCall("PUT", `/v1/permissions/sets/${adminSet}/permissions`, { changes: [{ key: "teams.manage_admin", status: "allow" }] })
  assert.equal(granted.status, 200, summary(granted))
  const adamAdds = await adam("PATCH", `/v1/teams/${opsAdmins}`, { memberIds: [w.maya.memberId, w.nora.memberId] })
  assert.equal(adamAdds.status, 200, summary(adamAdds))
  assert.equal((await w.held(w.nora)).permissions.includes("teams.manage"), true)
})
