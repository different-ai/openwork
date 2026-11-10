/**
 * Unified roles: every role is a permission set that can be given to a person
 * or to a team.
 *
 * - Billing manager is a built-in set every organization has, beside Member,
 *   Admin and Super admin. It applies only to the people and teams it is given to.
 * - A custom role or Billing manager can be given to a person directly
 *   (PUT /v1/members/:memberId/permission-set), one at a time.
 * - A team can be given Billing manager, and Super admin with the owner's or a
 *   super-admin's authority (PUT /v1/teams/:teamId/permission-set).
 * - The same safety rules as every other grant: nobody changes their own
 *   role, and you can only give permissions you hold.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { BILLING_MANAGER_PERMISSION_KEYS, PERMISSION_KEYS } from "@openwork/types/den/permissions"
import { bootDen, field, list, strings, summary, text, type Member } from "./harness.js"

const den = await bootDen()
after(() => den.close())

async function world(label: string, options: { superAdminSet?: boolean } = {}) {
  const olivia = await den.signUp(`Olivia ${label}`)
  const { orgId, owner } = await den.createOrg(olivia, `Unified roles ${label}`)
  if (options.superAdminSet) {
    const enabled = await den.setFeature(orgId, "superAdminPermissionSet", true)
    assert.equal(enabled.status, 200, summary(enabled))
  }
  const sam = await den.newMember(owner, orgId, `Sam ${label}`)
  const adam = await den.newMember(owner, orgId, `Adam ${label}`, "admin")
  const ownerCall = den.as(owner, orgId)

  async function sets() {
    const response = await ownerCall("GET", "/v1/permissions/sets")
    assert.equal(response.status, 200, summary(response))
    return list(field(response.body, "sets"))
  }
  async function setOfKind(kind: string) {
    const set = (await sets()).find((entry) => entry.kind === kind)
    assert.ok(set, `a ${kind} set`)
    return set
  }
  async function held(member: Member): Promise<string[]> {
    const context = await den.as(member, orgId)("GET", "/v1/org")
    assert.equal(context.status, 200, summary(context))
    return strings(field(context.body, "currentMember", "permissions"))
  }
  async function customRole(name: string, keys: readonly string[], extra: Record<string, unknown> = {}) {
    const created = await ownerCall("POST", "/v1/permissions/sets", { name, permissions: keys.map((key) => ({ key, status: "allow" })), ...extra })
    assert.equal(created.status, 201, summary(created))
    return text(field(created.body, "set", "id"), "permission set id")
  }
  return { orgId, owner, sam, adam, ownerCall, sets, setOfKind, held, customRole }
}

test("Billing manager is a built-in role every organization has, and nobody holds it until it is given", async () => {
  const w = await world("built-in")
  const kinds = (await w.sets()).map((set) => set.kind)
  assert.deepEqual(kinds, ["member_default", "admin_default", "billing_manager_default"])

  const billing = await w.setOfKind("billing_manager_default")
  assert.equal(billing.name, "Billing manager permissions")
  assert.equal(billing.allowedCount, BILLING_MANAGER_PERMISSION_KEYS.length)
  assert.deepEqual(billing.directMemberIds, [])
  assert.deepEqual(billing.teams, [])
  const detail = await w.ownerCall("GET", `/v1/permissions/sets/${billing.id}`)
  assert.equal(detail.status, 200, summary(detail))
  const allowed = list(field(detail.body, "set", "permissions")).filter((entry) => entry.status === "allow").map((entry) => entry.key)
  assert.deepEqual([...allowed].sort(), [...BILLING_MANAGER_PERMISSION_KEYS].sort())

  // Built in: it keeps its name and can't be deleted.
  const renamed = await w.ownerCall("PATCH", `/v1/permissions/sets/${billing.id}`, { name: "Finance" })
  assert.equal(renamed.status, 400, summary(renamed))
  assert.equal(field(renamed.body, "error"), "default_permission_set")
  const deleted = await w.ownerCall("DELETE", `/v1/permissions/sets/${billing.id}`)
  assert.equal(deleted.status, 400, summary(deleted))

  // Existing access is untouched: an admin still can't open the billing portal, a member holds nothing.
  assert.equal((await w.held(w.adam)).includes("billing_portal.use"), false)
  assert.deepEqual(await w.held(w.sam), [])
})

test("a person given Billing manager directly holds its permissions, one role at a time, until it is taken away", async () => {
  const w = await world("person")
  const billing = await w.setOfKind("billing_manager_default")

  const given = await w.ownerCall("PUT", `/v1/members/${w.sam.memberId}/permission-set`, { permissionSetId: billing.id })
  assert.equal(given.status, 200, summary(given))
  assert.deepEqual(field(given.body, "set", "directMemberIds"), [w.sam.memberId])
  assert.deepEqual([...(await w.held(w.sam))].sort(), [...BILLING_MANAGER_PERMISSION_KEYS].sort())
  // Still a Member: the role adds permissions, it doesn't make them an admin.
  const context = await den.as(w.sam, w.orgId)("GET", "/v1/org")
  assert.equal(field(context.body, "currentMember", "role"), "member")

  const explained = await w.ownerCall("GET", `/v1/members/${w.sam.memberId}/permissions`)
  assert.equal(explained.status, 200, summary(explained))
  const portal = list(field(explained.body, "permissions")).find((entry) => entry.key === "billing_portal.use")
  assert.deepEqual(list(portal?.sources).map((source) => [source.kind, source.setId]), [["direct", billing.id]])

  // Giving another role replaces it.
  const publisher = await w.customRole("Skill publisher", ["plugins.import"])
  const replaced = await w.ownerCall("PUT", `/v1/members/${w.sam.memberId}/permission-set`, { permissionSetId: publisher })
  assert.equal(replaced.status, 200, summary(replaced))
  assert.deepEqual(await w.held(w.sam), ["plugins.import"])
  assert.deepEqual((await w.setOfKind("billing_manager_default")).directMemberIds, [])

  const cleared = await w.ownerCall("PUT", `/v1/members/${w.sam.memberId}/permission-set`, { permissionSetId: null })
  assert.equal(cleared.status, 200, summary(cleared))
  assert.equal(field(cleared.body, "set"), null)
  assert.deepEqual(await w.held(w.sam), [])
})

test("giving a role to a person follows the role-change rules: not your own, only what you hold, and Change member roles", async () => {
  const w = await world("rules")
  const billing = await w.setOfKind("billing_manager_default")
  const adminCall = den.as(w.adam, w.orgId)
  const memberCall = den.as(w.sam, w.orgId)

  // Changing roles is owner-only by default: neither a member nor an admin can give anyone a role.
  for (const call of [memberCall, adminCall]) {
    const refused = await call("PUT", `/v1/members/${w.owner.memberId}/permission-set`, { permissionSetId: billing.id })
    assert.equal(refused.status, 403, summary(refused))
    assert.equal(field(refused.body, "requiredPermission"), "members.update")
  }

  // The owner lets Adam change roles. He still can't hand out the billing portal: admins don't hold it.
  const roleManager = await w.customRole("Role manager", ["members.update"])
  const delegated = await w.ownerCall("PUT", `/v1/members/${w.adam.memberId}/permission-set`, { permissionSetId: roleManager })
  assert.equal(delegated.status, 200, summary(delegated))
  const beyondAdmin = await adminCall("PUT", `/v1/members/${w.sam.memberId}/permission-set`, { permissionSetId: billing.id })
  assert.equal(beyondAdmin.status, 403, summary(beyondAdmin))
  assert.equal(field(beyondAdmin.body, "error"), "permission_not_held", summary(beyondAdmin))
  assert.deepEqual(field(beyondAdmin.body, "keys"), ["billing_portal.use"])
  assert.deepEqual(await w.held(w.sam), [])

  // Nobody gives themselves a role, even one they could give others.
  const reader = await w.customRole("Team reader", ["teams.view"])
  const own = await adminCall("PUT", `/v1/members/${w.adam.memberId}/permission-set`, { permissionSetId: reader })
  assert.equal(own.status, 403, summary(own))
  assert.equal(field(own.body, "error"), "own_role")

  // An admin can give a role made of permissions admins hold.
  const within = await adminCall("PUT", `/v1/members/${w.sam.memberId}/permission-set`, { permissionSetId: reader })
  assert.equal(within.status, 200, summary(within))
  assert.deepEqual(await w.held(w.sam), ["teams.view"])

  // Member, Admin and Super admin are organization roles, never given this way; the owner needs nothing.
  for (const kind of ["member_default", "admin_default"]) {
    const set = await w.setOfKind(kind)
    const refused = await w.ownerCall("PUT", `/v1/members/${w.sam.memberId}/permission-set`, { permissionSetId: set.id })
    assert.equal(refused.status, 400, `${kind}: ${summary(refused)}`)
    assert.equal(field(refused.body, "error"), "default_permission_set")
  }
  const toOwner = await adminCall("PUT", `/v1/members/${w.owner.memberId}/permission-set`, { permissionSetId: reader })
  assert.equal(toOwner.status, 400, summary(toOwner))
  const unknown = await w.ownerCall("PUT", "/v1/members/om_01k00000000000000000000000/permission-set", { permissionSetId: reader })
  assert.equal(unknown.status, 404, summary(unknown))
})

test("a role given directly ends when the role is deleted or the person leaves, and doesn't come back", async () => {
  const w = await world("ends")
  const publisher = await w.customRole("Skill publisher", ["plugins.import"])
  const given = await w.ownerCall("PUT", `/v1/members/${w.sam.memberId}/permission-set`, { permissionSetId: publisher })
  assert.equal(given.status, 200, summary(given))
  assert.deepEqual(await w.held(w.sam), ["plugins.import"])

  const deleted = await w.ownerCall("DELETE", `/v1/permissions/sets/${publisher}`)
  assert.equal(deleted.status, 204, summary(deleted))
  assert.deepEqual(await w.held(w.sam), [])

  // Removed from the organization while holding Billing manager, then invited again: a plain Member.
  const billing = await w.setOfKind("billing_manager_default")
  const again = await w.ownerCall("PUT", `/v1/members/${w.sam.memberId}/permission-set`, { permissionSetId: billing.id })
  assert.equal(again.status, 200, summary(again))
  const removed = await w.ownerCall("DELETE", `/v1/members/${w.sam.memberId}`)
  assert.ok(removed.status < 300, summary(removed))
  assert.deepEqual((await w.setOfKind("billing_manager_default")).directMemberIds, [])
  // Removal signed Sam out; he signs in again and accepts a new invitation.
  const signedIn = await den.signIn(w.sam.email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  const back = await den.join(w.owner, w.orgId, { ...w.sam, token: text(field(signedIn.body, "token"), "session token") })
  assert.deepEqual(await w.held(back), [])
  assert.deepEqual((await w.setOfKind("billing_manager_default")).directMemberIds, [])
})

test("creating a role can give it to people straight away, with the same rules", async () => {
  const w = await world("create")
  const created = await w.ownerCall("POST", "/v1/permissions/sets", {
    name: "Support lead",
    memberIds: [w.sam.memberId],
    permissions: [{ key: "teams.view", status: "allow" }],
  })
  assert.equal(created.status, 201, summary(created))
  assert.deepEqual(field(created.body, "set", "directMemberIds"), [w.sam.memberId])
  assert.deepEqual(await w.held(w.sam), ["teams.view"])

  const self = await w.ownerCall("POST", "/v1/permissions/sets", { name: "Mine", memberIds: [w.owner.memberId], permissions: [] })
  assert.equal(self.status, 403, summary(self))
  assert.equal(field(self.body, "error"), "own_role")
  const stranger = await w.ownerCall("POST", "/v1/permissions/sets", { name: "Nobody", memberIds: ["om_01k00000000000000000000000"], permissions: [] })
  assert.equal(stranger.status, 404, summary(stranger))
  assert.equal((await w.sets()).some((set) => set.name === "Mine" || set.name === "Nobody"), false)
})

test("a team can be given Billing manager, and its members hold it", async () => {
  const w = await world("team")
  const billing = await w.setOfKind("billing_manager_default")
  const finance = await den.createTeam(w.owner, w.orgId, "Finance", [w.sam.memberId])

  const given = await w.ownerCall("PUT", `/v1/teams/${finance}/permission-set`, { permissionSetId: billing.id })
  assert.equal(given.status, 200, summary(given))
  assert.deepEqual(list(field(given.body, "set", "teams")).map((team) => team.id), [finance])
  assert.deepEqual([...(await w.held(w.sam))].sort(), [...BILLING_MANAGER_PERMISSION_KEYS].sort())
  assert.deepEqual(list((await w.setOfKind("billing_manager_default")).teams).map((team) => team.id), [finance])

  // Member and Admin follow the role and the Admin team switch, never a link.
  const admin = await w.setOfKind("admin_default")
  const refused = await w.ownerCall("PUT", `/v1/teams/${finance}/permission-set`, { permissionSetId: admin.id })
  assert.equal(refused.status, 400, summary(refused))
  assert.equal(field(refused.body, "error"), "default_permission_set")

  const cleared = await w.ownerCall("PUT", `/v1/teams/${finance}/permission-set`, { permissionSetId: null })
  assert.equal(cleared.status, 200, summary(cleared))
  assert.deepEqual(await w.held(w.sam), [])
})

test("giving a team Super admin, or taking it away, needs the owner or a super admin", async () => {
  const w = await world("super", { superAdminSet: true })
  const superAdmin = await w.setOfKind("super_admin_default")
  const leadership = await den.createTeam(w.owner, w.orgId, "Leadership", [w.sam.memberId])

  // Adam holds every permission through a custom role, but is not a super admin.
  const everything = await w.customRole("Everything", PERMISSION_KEYS)
  const widened = await w.ownerCall("PUT", `/v1/members/${w.adam.memberId}/permission-set`, { permissionSetId: everything })
  assert.equal(widened.status, 200, summary(widened))
  assert.deepEqual([...(await w.held(w.adam))].sort(), [...PERMISSION_KEYS].sort())
  const adminCall = den.as(w.adam, w.orgId)

  const byAdmin = await adminCall("PUT", `/v1/teams/${leadership}/permission-set`, { permissionSetId: superAdmin.id })
  assert.equal(byAdmin.status, 403, summary(byAdmin))
  assert.equal(field(byAdmin.body, "error"), "super_admin_role_requires_super_admin")
  assert.deepEqual(await w.held(w.sam), [])

  const byOwner = await w.ownerCall("PUT", `/v1/teams/${leadership}/permission-set`, { permissionSetId: superAdmin.id })
  assert.equal(byOwner.status, 200, summary(byOwner))
  assert.deepEqual([...(await w.held(w.sam))].sort(), [...PERMISSION_KEYS].sort())
  assert.deepEqual(list((await w.setOfKind("super_admin_default")).teams).map((team) => team.id), [leadership])

  // Taking it away, by clearing it or by replacing it, is protected the same way.
  for (const permissionSetId of [null, everything]) {
    const taken = await adminCall("PUT", `/v1/teams/${leadership}/permission-set`, { permissionSetId })
    assert.equal(taken.status, 403, summary(taken))
    assert.equal(field(taken.body, "error"), "super_admin_role_requires_super_admin")
  }
  assert.deepEqual([...(await w.held(w.sam))].sort(), [...PERMISSION_KEYS].sort())
  const cleared = await w.ownerCall("PUT", `/v1/teams/${leadership}/permission-set`, { permissionSetId: null })
  assert.equal(cleared.status, 200, summary(cleared))
  assert.deepEqual(await w.held(w.sam), [])
})

test("an invited person can be given a role before they join, and holds it once they do", async () => {
  const w = await world("invite")
  const billing = await w.setOfKind("billing_manager_default")
  const riley = await den.signUp("Riley invite")
  const invited = await w.ownerCall("POST", "/v1/invitations", { email: riley.email, role: "member" })
  assert.ok(invited.status < 300, summary(invited))
  const roster = await w.ownerCall("GET", "/v1/org")
  const placeholder = list(field(roster.body, "members")).find((entry) => field(entry, "user", "email") === riley.email)
  const placeholderId = text(placeholder?.id, "the invited person's member id")

  const given = await w.ownerCall("PUT", `/v1/members/${placeholderId}/permission-set`, { permissionSetId: billing.id })
  assert.equal(given.status, 200, summary(given))
  const accepted = await den.as(riley, w.orgId)("POST", "/v1/orgs/invitations/accept", { id: text(field(invited.body, "inviteToken"), "invite token") })
  assert.ok(accepted.status < 300, summary(accepted))
  const joined: Member = { ...riley, memberId: placeholderId }
  assert.deepEqual([...(await w.held(joined))].sort(), [...BILLING_MANAGER_PERMISSION_KEYS].sort())
})
