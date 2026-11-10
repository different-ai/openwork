import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { isConfigRef } from "@openwork/types/den/config-blobs"
import type { ConfigArea, ConfigAreaContext, ConfigItem } from "../../src/config-blobs/area.js"
import { ConfigApplyItemError } from "../../src/config-blobs/area.js"
import { updateOp } from "./config-blobs-area-ops.js"
import { bootDen, field, summary, type Call, type Member } from "./harness.js"

const den = await bootDen()
after(async () => { await den.close() })
const { db } = await import("../../src/db.js")
const { getOrganizationFeatures } = await import("../../src/features.js")
const { listDevEmails } = await import("../../src/utils/email/send-email.js")
const { membersTeamsArea } = await import("../../src/config-blobs/areas/members-teams.js")
const { membersRolesArea } = await import("../../src/config-blobs/areas/members-roles.js")
const { membersPeopleArea, SEND_INVITE_EMAIL_FIELD } = await import("../../src/config-blobs/areas/members-people.js")
const { settingsGeneralArea } = await import("../../src/config-blobs/areas/settings-general.js")
const { settingsWebOriginsArea } = await import("../../src/config-blobs/areas/settings-web-origins.js")

const AREAS: ConfigArea[] = [membersTeamsArea, membersRolesArea, membersPeopleArea, settingsGeneralArea, settingsWebOriginsArea]

async function contextFor(orgId: string, actor: Member): Promise<ConfigAreaContext> {
  return {
    db,
    organizationId: orgId,
    actor: { userId: actor.userId, memberId: actor.memberId },
    deployment: "self_hosted",
    features: await getOrganizationFeatures(orgId, { userId: actor.userId }),
  }
}

async function ok(call: Promise<Call>, label: string) {
  const result = await call
  assert.ok(result.status < 300, `${label}: ${summary(result)}`)
  return result
}

// ---------------------------------------------------------------------------
// Source organization, set up through the public API.

const owner = await den.signUp("Blob Owner")
const source = await den.createOrg(owner, "Blob Source")
const ownerMember = source.owner
const admin = await den.newMember(owner, source.orgId, "Blob Admin", "admin")
const person = await den.newMember(owner, source.orgId, "Blob Person")
const as = den.as(owner, source.orgId)

const platform = await den.createTeam(owner, source.orgId, "Platform", [person.memberId])
const adminsTeam = await den.createTeam(owner, source.orgId, "Admins", [admin.memberId], { grantsOrganizationAdmin: true })
const invitedEmail = `blob-invited+${Date.now().toString(36)}@example.test`
await ok(as("POST", "/v1/invitations", { email: invitedEmail, role: "member", teamId: platform }), "invite")
const role = await ok(as("POST", "/v1/permissions/sets", { name: "Viewers", teamIds: [platform], permissions: [{ key: "teams.view", status: "allow" }] }), "create role")
const roleId = String(field(role.body, "set", "id"))
await ok(as("POST", "/v1/org/web-origins", { origin: "https://blob-source.example.com" }), "approve origin")
await ok(as("PATCH", "/v1/org", { allowedEmailDomains: ["example.test"] }), "allowed domains")
await ok(as("PUT", "/v1/org/automation-settings", { desktop: false }), "automation settings")

const sourceCtx = await contextFor(source.orgId, ownerMember)

async function exportAll(ctx: ConfigAreaContext): Promise<Map<string, ConfigItem[]>> {
  const out = new Map<string, ConfigItem[]>()
  for (const area of AREAS) out.set(area.key, await area.exportItems(ctx))
  return out
}

/** Adds `id` to every `$ref` the way the engine resolves refs, through `ids` (source id → local id). */
function resolveRefs(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, ids))
  if (isConfigRef(value)) {
    const target = value.$ref.slice(value.$ref.indexOf("/") + 1)
    return { ...value, id: ids.get(target) ?? target }
  }
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveRefs(entry, ids)]))
  return value
}

function specWithResolvedRefs(item: ConfigItem, ids: Map<string, string> = new Map()) {
  const resolved = resolveRefs(item.spec, ids)
  assert.ok(typeof resolved === "object" && resolved !== null && !Array.isArray(resolved))
  return Object.fromEntries(Object.entries(resolved))
}

// ---------------------------------------------------------------------------

test("export: allowlisted shapes, valid specs, no secrets or tokens", async () => {
  const exported = await exportAll(sourceCtx)
  const text = JSON.stringify(Object.fromEntries(exported))
  for (const forbidden of ["inviteToken", "invite_token", "token", "password", "userId", "createdAt", "enc:v1:"]) {
    assert.ok(!text.includes(forbidden), `export contains ${forbidden}`)
  }
  for (const area of AREAS) {
    for (const item of exported.get(area.key) ?? []) {
      const parsed = area.specSchema.safeParse(item.spec)
      assert.ok(parsed.success, `${area.key} ${item.name}: ${parsed.success ? "" : parsed.error.message}`)
    }
  }

  const teams = exported.get("members.teams") ?? []
  assert.deepEqual(teams.map((team) => [team.id, team.name, team.spec]), [
    [adminsTeam, "Admins", { grantsOrganizationAdmin: true, managedBy: "manual" }],
    [platform, "Platform", { grantsOrganizationAdmin: false, managedBy: "manual" }],
  ])

  const roles = exported.get("members.roles") ?? []
  assert.deepEqual(roles.slice(0, 2).map((item) => item.key), ["member", "admin"])
  const viewers = roles.find((item) => item.id === roleId)
  assert.deepEqual(viewers?.spec, { builtIn: null, allow: ["teams.view"], teams: [{ $ref: `members.teams/${platform}`, name: "Platform" }] })

  const people = exported.get("members.people") ?? []
  const byEmail = new Map(people.map((item) => [String(item.spec.email), item]))
  assert.equal(byEmail.get(owner.email.toLowerCase())?.spec.role, "owner")
  assert.equal(byEmail.get(admin.email.toLowerCase())?.spec.role, "admin")
  assert.deepEqual(byEmail.get(person.email.toLowerCase())?.spec, {
    email: person.email.toLowerCase(), role: "member", status: "active", managedBy: "manual",
    teams: [{ $ref: `members.teams/${platform}`, name: "Platform" }],
  })
  const invited = byEmail.get(invitedEmail)
  assert.equal(invited?.spec.status, "invited")
  assert.deepEqual(invited?.spec.teams, [{ $ref: `members.teams/${platform}`, name: "Platform" }])
  assert.match(invited?.id ?? "", /^om_/)

  const [general] = exported.get("settings.general") ?? []
  assert.equal(general?.id, source.orgId)
  assert.deepEqual(general?.spec, { allowedEmailDomains: ["example.test"], allowedDesktopVersions: null, automations: { desktop: false, cloud: true }, desktopAppRestrictions: {} })
  assert.deepEqual((exported.get("settings.web-origins") ?? []).map((item) => item.spec), [{ origin: "https://blob-source.example.com" }])

  // Exports are stable.
  assert.equal(JSON.stringify(Object.fromEntries(await exportAll(sourceCtx))), text)
})

test("export → apply(update, same spec) is a no-op in every area", async () => {
  const before = await exportAll(sourceCtx)
  for (const area of AREAS) {
    for (const item of before.get(area.key) ?? []) {
      const op = updateOp(area, item, { sourceId: item.id, key: item.key ?? null, name: item.name, spec: specWithResolvedRefs(item) })
      assert.deepEqual(op.changes, [], `${area.key} ${item.name}: same spec, no changes`)
      const result = await area.apply(sourceCtx, op)
      assert.equal(result.localId, item.id, `${area.key} ${item.name}`)
      assert.deepEqual(result.warnings ?? [], [], `${area.key} ${item.name}`)
      assert.deepEqual(result.steps ?? [], [], `${area.key} ${item.name}: nothing written`)
    }
  }
  assert.deepEqual(Object.fromEntries(await exportAll(sourceCtx)), Object.fromEntries(before))
})

test("create with preferredId keeps the id", async () => {
  const teamId = createDenTypeId("team")
  const created = await membersTeamsArea.apply(sourceCtx, { kind: "create", preferredId: teamId, item: { name: "Reused Id", key: "reused-id", spec: { grantsOrganizationAdmin: false, managedBy: "manual" } } })
  assert.equal(created.localId, teamId)
  const exported = await membersTeamsArea.exportItems(sourceCtx)
  const team = exported.find((item) => item.id === teamId)
  assert.equal(team?.key, "reused-id")

  const originId = createDenTypeId("organizationWebOrigin")
  const origin = await settingsWebOriginsArea.apply(sourceCtx, { kind: "create", preferredId: originId, item: { name: "https://reused.example.com", spec: { origin: "https://reused.example.com" } } })
  assert.equal(origin.localId, originId)

  // Clean up through delete ops.
  assert.ok(team)
  await membersTeamsArea.apply(sourceCtx, { kind: "delete", targetId: teamId, previous: team })
  await settingsWebOriginsArea.apply(sourceCtx, { kind: "delete", targetId: originId, previous: { id: originId, name: "https://reused.example.com", spec: { origin: "https://reused.example.com" } } })
  assert.ok(!(await membersTeamsArea.exportItems(sourceCtx)).some((item) => item.id === teamId))
})

test("round trip into a second organization: creates, then the same export", async () => {
  const exported = await exportAll(sourceCtx)
  const target = await den.createOrg(owner, "Blob Target")
  const targetCtx = await contextFor(target.orgId, target.owner)
  const ids = new Map<string, string>()
  const emailsSent = listDevEmails("organizationInvite").length

  // Teams first (dependency order), then roles, then people.
  for (const item of exported.get("members.teams") ?? []) {
    const result = await membersTeamsArea.apply(targetCtx, { kind: "create", item: { sourceId: item.id, key: item.key ?? null, name: item.name, spec: specWithResolvedRefs(item) } })
    ids.set(item.id, result.localId)
  }
  const targetRoles = await membersRolesArea.exportItems(targetCtx)
  for (const item of exported.get("members.roles") ?? []) {
    const builtIn = targetRoles.find((role) => role.key && role.key === item.key)
    const spec = specWithResolvedRefs(item, ids)
    const result = builtIn
      ? await membersRolesArea.apply(targetCtx, updateOp(membersRolesArea, builtIn, { sourceId: item.id, key: item.key ?? null, name: item.name, spec }))
      : await membersRolesArea.apply(targetCtx, { kind: "create", item: { sourceId: item.id, name: item.name, spec } })
    ids.set(item.id, result.localId)
  }
  const targetPeople = await membersPeopleArea.exportItems(targetCtx)
  for (const item of exported.get("members.people") ?? []) {
    const existing = targetPeople.find((entry) => entry.spec.email === item.spec.email)
    const spec = specWithResolvedRefs(item, ids)
    const result = existing
      ? await membersPeopleArea.apply(targetCtx, updateOp(membersPeopleArea, existing, { sourceId: item.id, name: item.name, spec }))
      : await membersPeopleArea.apply(targetCtx, { kind: "create", item: { sourceId: item.id, name: item.name, spec } })
    ids.set(item.id, result.localId)
  }
  const [general] = exported.get("settings.general") ?? []
  assert.ok(general)
  await settingsGeneralArea.apply(targetCtx, { kind: "create", item: { sourceId: general.id, name: general.name, spec: general.spec } })
  for (const item of exported.get("settings.web-origins") ?? []) {
    await settingsWebOriginsArea.apply(targetCtx, { kind: "create", item: { sourceId: item.id, name: item.name, spec: item.spec } })
  }

  // Silent: no invite email for the people invited by the import.
  assert.equal(listDevEmails("organizationInvite").length, emailsSent)

  const again = await exportAll(targetCtx)
  /** Replaces target ids with source ids, so both exports compare. */
  const toSource = new Map([...ids].map(([sourceId, localId]) => [localId, sourceId]))
  const normalize = (items: ConfigItem[]) => JSON.parse(JSON.stringify(items, (key, value: unknown) => {
    if (typeof value === "string" && toSource.has(value)) return toSource.get(value)
    if (typeof value === "string" && value.startsWith("members.teams/")) return `members.teams/${toSource.get(value.slice("members.teams/".length)) ?? value.slice("members.teams/".length)}`
    return value
  })) as ConfigItem[]
  const sameKeys = (left: ConfigItem[], right: ConfigItem[]) => {
    const order = (items: ConfigItem[]) => [...items].sort((a, b) => a.id.localeCompare(b.id))
    assert.deepEqual(order(normalize(left)), order(right))
  }
  sameKeys(again.get("members.teams") ?? [], exported.get("members.teams") ?? [])
  sameKeys((again.get("members.roles") ?? []).map((item) => ({ ...item, id: item.key ?? item.id })), (exported.get("members.roles") ?? []).map((item) => ({ ...item, id: item.key ?? item.id })))
  assert.deepEqual((again.get("settings.general") ?? []).map((item) => item.spec), [general.spec])
  assert.deepEqual((again.get("settings.web-origins") ?? []).map((item) => item.spec), (exported.get("settings.web-origins") ?? []).map((item) => item.spec))

  // People: the same people, roles and teams; everyone but the owner is invited (they accept to join).
  const peopleOf = (items: ConfigItem[]) => normalize(items).map((item) => ({ email: item.spec.email, role: item.spec.role, teams: item.spec.teams })).sort((a, b) => String(a.email).localeCompare(String(b.email)))
  assert.deepEqual(peopleOf(again.get("members.people") ?? []), peopleOf(exported.get("members.people") ?? []))
  for (const item of again.get("members.people") ?? []) {
    assert.equal(item.spec.status, item.spec.email === owner.email.toLowerCase() ? "active" : "invited", String(item.spec.email))
  }
})

test("people: update an existing member's role and teams", async () => {
  const people = await membersPeopleArea.exportItems(sourceCtx)
  const item = people.find((entry) => entry.spec.email === person.email.toLowerCase())
  assert.ok(item)
  const spec = { ...specWithResolvedRefs(item), role: "admin", teams: [{ $ref: `members.teams/${adminsTeam}`, id: adminsTeam }] }
  const result = await membersPeopleArea.apply(sourceCtx, updateOp(membersPeopleArea, item, { sourceId: item.id, name: item.name, spec }))
  assert.equal(result.localId, item.id)
  const after = (await membersPeopleArea.exportItems(sourceCtx)).find((entry) => entry.id === item.id)
  assert.equal(after?.spec.role, "admin")
  assert.deepEqual(after?.spec.teams, [{ $ref: `members.teams/${adminsTeam}`, name: "Admins" }])

  // Back to how it was.
  await membersPeopleArea.apply(sourceCtx, updateOp(membersPeopleArea, after ?? item, { sourceId: item.id, name: item.name, spec: specWithResolvedRefs(item) }))
})

test("people: invitations are silent by default and send email only when asked", async () => {
  const before = listDevEmails("organizationInvite").length
  const silentEmail = `blob-silent+${Date.now().toString(36)}@example.test`
  const silent = await membersPeopleArea.apply(sourceCtx, { kind: "create", item: { name: silentEmail, spec: { email: silentEmail, role: "member", status: "invited", teams: [], managedBy: "manual" } } })
  assert.match(silent.localId, /^om_/)
  assert.equal(listDevEmails("organizationInvite").length, before)
  const listed = (await membersPeopleArea.exportItems(sourceCtx)).find((entry) => entry.spec.email === silentEmail)
  assert.equal(listed?.id, silent.localId)
  assert.equal(listed?.spec.status, "invited")

  const loudEmail = `blob-loud+${Date.now().toString(36)}@example.test`
  await membersPeopleArea.apply(sourceCtx, { kind: "create", item: { name: loudEmail, spec: { email: loudEmail, role: "member", status: "invited", teams: [], managedBy: "manual", [SEND_INVITE_EMAIL_FIELD]: true } } })
  assert.equal(listDevEmails("organizationInvite").length, before + 1)

  // Outside the allowed email domains: refused by the invitation rules.
  await assert.rejects(
    membersPeopleArea.apply(sourceCtx, { kind: "create", item: { name: "x", spec: { email: "someone@elsewhere.invalid", role: "member", status: "invited", teams: [], managedBy: "manual" } } }),
    /only allows/,
  )

  // Deleting an invited person cancels the invitation.
  assert.ok(listed)
  await membersPeopleArea.apply(sourceCtx, { kind: "delete", targetId: listed.id, previous: listed })
  assert.ok(!(await membersPeopleArea.exportItems(sourceCtx)).some((entry) => entry.spec.email === silentEmail))
})

test("people and roles: protected deletes", async () => {
  const people = await membersPeopleArea.exportItems(sourceCtx)
  const self = people.find((entry) => entry.id === ownerMember.memberId)
  assert.ok(self)
  assert.ok(membersPeopleArea.protectedFromDelete?.(self, sourceCtx))
  await assert.rejects(membersPeopleArea.apply(sourceCtx, { kind: "delete", targetId: self.id, previous: self }), /yourself/)

  // An admin applying can't remove the owner either.
  const adminCtx = await contextFor(source.orgId, admin)
  assert.ok(membersPeopleArea.protectedFromDelete?.(self, adminCtx))
  await assert.rejects(membersPeopleArea.apply(adminCtx, { kind: "delete", targetId: self.id, previous: self }), /owner/)

  const roles = await membersRolesArea.exportItems(sourceCtx)
  const memberSet = roles.find((item) => item.key === "member")
  assert.ok(memberSet)
  assert.ok(membersRolesArea.protectedFromDelete?.(memberSet, sourceCtx))
  await assert.rejects(membersRolesArea.apply(sourceCtx, { kind: "delete", targetId: memberSet.id, previous: memberSet }), /can't be deleted/)

  const [general] = await settingsGeneralArea.exportItems(sourceCtx)
  assert.ok(general)
  assert.ok(settingsGeneralArea.protectedFromDelete?.(general, sourceCtx))
})

test("roles: can't grant more than the applier holds", async () => {
  // An admin without permissions.manage is refused by the permission rules, not by the adapter.
  const adminCtx = await contextFor(source.orgId, admin)
  await assert.rejects(
    membersRolesArea.apply(adminCtx, { kind: "create", item: { name: "Too much", spec: { builtIn: null, allow: ["organization.update"], teams: [] } } }),
    (error: unknown) => error instanceof ConfigApplyItemError && error.failure.status === 403 && /permission/i.test(error.message) && error.stepsDone.length === 0,
  )
})

// ---------------------------------------------------------------------------
// Writes follow the plan's changes

const { eq: eqOp } = await import("@openwork-ee/den-db/drizzle")
const { TeamMemberTable, TeamTable: TeamRows, PermissionSetTeamTable } = await import("@openwork-ee/den-db/schema")

async function teamMemberRows(teamId: string) {
  return (await db.select().from(TeamMemberTable).where(eqOp(TeamMemberTable.teamId, teamId as typeof TeamMemberTable.$inferSelect.teamId)))
    .map((row) => `${row.orgMembershipId}:${row.id}`).sort()
}

test("people: adding one team writes only that person's membership row; steps list the writes", async () => {
  const other = await den.newMember(owner, source.orgId, "Blob Neighbour")
  const neighbourTeam = await den.createTeam(owner, source.orgId, "Neighbours", [other.memberId])
  const beforeRows = await teamMemberRows(neighbourTeam)
  const item = (await membersPeopleArea.readItems?.(sourceCtx, [person.memberId]))?.[0]
  assert.ok(item)
  const spec = { ...specWithResolvedRefs(item), teams: [...specWithResolvedRefs(item).teams as unknown[], { $ref: `members.teams/${neighbourTeam}`, name: "Neighbours", id: neighbourTeam }] }
  const op = updateOp(membersPeopleArea, item, { name: item.name, spec })
  assert.deepEqual(op.changes.map((change) => change.path), ["teams"])
  const result = await membersPeopleArea.apply(sourceCtx, op)
  assert.deepEqual(result.steps, [{ action: "add", target: "teams", detail: "Neighbours" }])
  const afterRows = await teamMemberRows(neighbourTeam)
  assert.equal(afterRows.length, beforeRows.length + 1)
  for (const row of beforeRows) assert.ok(afterRows.includes(row), "the neighbour keeps their membership row (same id)")
  // The other team the person is in is not touched by the undo either.
  const platformRows = await teamMemberRows(platform)
  const back = (await membersPeopleArea.readItems?.(sourceCtx, [person.memberId]))?.[0]
  assert.ok(back)
  const undo = await membersPeopleArea.apply(sourceCtx, updateOp(membersPeopleArea, back, { name: item.name, spec: specWithResolvedRefs(item) }))
  assert.deepEqual(undo.steps, [{ action: "remove", target: "teams", detail: "Neighbours" }])
  assert.deepEqual(await teamMemberRows(platform), platformRows)
  assert.deepEqual(await teamMemberRows(neighbourTeam), beforeRows)
})

test("people: a failed write names its field and step, and lists the writes already done", async () => {
  const item = (await membersPeopleArea.readItems?.(sourceCtx, [person.memberId]))?.[0]
  assert.ok(item)
  const missingTeam = createDenTypeId("team")
  const spec = { ...specWithResolvedRefs(item), role: "admin", teams: [...specWithResolvedRefs(item).teams as unknown[], { $ref: `members.teams/${missingTeam}`, id: missingTeam }] }
  const op = updateOp(membersPeopleArea, item, { name: item.name, spec })
  await assert.rejects(membersPeopleArea.apply(sourceCtx, op), (error: unknown) => {
    assert.ok(error instanceof ConfigApplyItemError, String(error))
    assert.equal(error.failure.field, "teams")
    assert.deepEqual(error.failure.step, { action: "add", target: "teams", detail: missingTeam })
    assert.equal(error.failure.status, 404)
    assert.deepEqual(error.stepsDone, [{ action: "set", target: "role", detail: "admin" }])
    return true
  })
  // Put the role back.
  const now = (await membersPeopleArea.readItems?.(sourceCtx, [person.memberId]))?.[0]
  assert.ok(now)
  await membersPeopleArea.apply(sourceCtx, updateOp(membersPeopleArea, now, { name: item.name, spec: specWithResolvedRefs(item) }))
})

test("roles: changing the permissions doesn't touch which teams have the role", async () => {
  const [viewers] = (await membersRolesArea.readItems?.(sourceCtx, [roleId])) ?? []
  assert.ok(viewers)
  const teamRowsBefore = await db.select().from(PermissionSetTeamTable).where(eqOp(PermissionSetTeamTable.permissionSetId, roleId as typeof PermissionSetTeamTable.$inferSelect.permissionSetId))
  const spec = { ...specWithResolvedRefs(viewers), allow: ["teams.view", "web_origins.view"] }
  const op = updateOp(membersRolesArea, viewers, { name: viewers.name, spec })
  assert.deepEqual(op.changes.map((change) => change.path), ["allow"])
  const result = await membersRolesArea.apply(sourceCtx, op)
  assert.deepEqual(result.steps, [{ action: "update", target: "allow", detail: "+web_origins.view" }])
  const teamRowsAfter = await db.select().from(PermissionSetTeamTable).where(eqOp(PermissionSetTeamTable.permissionSetId, roleId as typeof PermissionSetTeamTable.$inferSelect.permissionSetId))
  assert.deepEqual(teamRowsAfter, teamRowsBefore)
  const back = (await membersRolesArea.readItems?.(sourceCtx, [roleId]))?.[0]
  assert.ok(back)
  const undo = await membersRolesArea.apply(sourceCtx, updateOp(membersRolesArea, back, { name: viewers.name, spec: specWithResolvedRefs(viewers) }))
  assert.deepEqual(undo.steps, [{ action: "update", target: "allow", detail: "-web_origins.view" }])
})

test("teams: a rename writes the name only; settings: one setting writes only that setting", async () => {
  const [team] = (await membersTeamsArea.readItems?.(sourceCtx, [platform])) ?? []
  assert.ok(team)
  const [adminsBefore] = await db.select().from(TeamRows).where(eqOp(TeamRows.id, adminsTeam as typeof TeamRows.$inferSelect.id))
  const renamed = await membersTeamsArea.apply(sourceCtx, updateOp(membersTeamsArea, team, { name: "Platform Core", key: team.key ?? null, spec: team.spec }))
  assert.deepEqual(renamed.steps, [{ action: "set", target: "name", detail: "Platform Core" }])
  const [adminsAfter] = await db.select().from(TeamRows).where(eqOp(TeamRows.id, adminsTeam as typeof TeamRows.$inferSelect.id))
  assert.deepEqual(adminsAfter, adminsBefore, "other teams untouched")
  const back = (await membersTeamsArea.readItems?.(sourceCtx, [platform]))?.[0]
  assert.ok(back)
  await membersTeamsArea.apply(sourceCtx, updateOp(membersTeamsArea, back, { name: "Platform", key: team.key ?? null, spec: team.spec }))

  const [general] = (await settingsGeneralArea.readItems?.(sourceCtx, [source.orgId])) ?? []
  assert.ok(general)
  const automations = { desktop: true, cloud: true }
  const op = updateOp(settingsGeneralArea, general, { name: general.name, spec: { ...general.spec, automations } })
  assert.deepEqual(op.changes.map((change) => change.path), ["automations.desktop"])
  const result = await settingsGeneralArea.apply(sourceCtx, op)
  assert.deepEqual(result.steps, [{ action: "set", target: "automations.desktop", detail: "desktop on" }])
  const restored = (await settingsGeneralArea.readItems?.(sourceCtx, [source.orgId]))?.[0]
  assert.ok(restored)
  await settingsGeneralArea.apply(sourceCtx, updateOp(settingsGeneralArea, restored, { name: general.name, spec: general.spec }))
})

test("readItems returns exactly what exportItems returns for those ids", async () => {
  const exported = await exportAll(sourceCtx)
  for (const area of AREAS) {
    const items = exported.get(area.key) ?? []
    const pick = items.filter((_, index) => index % 2 === 0)
    const read = await area.readItems?.(sourceCtx, [...pick.map((item) => item.id), "om_missing0000000000000000000"])
    assert.deepEqual(read, pick, area.key)
    assert.deepEqual(await area.readItems?.(sourceCtx, []), [], `${area.key}: no ids`)
  }
})

test("irreversible effects are listed in plain words", async () => {
  const people = await membersPeopleArea.exportItems(sourceCtx)
  const active = people.find((entry) => entry.spec.email === person.email.toLowerCase())
  const invited = people.find((entry) => entry.spec.status === "invited")
  assert.ok(active && invited)
  const removeActive = membersPeopleArea.irreversible?.({ kind: "delete", targetId: active.id, previous: active }) ?? []
  assert.ok(removeActive.some((line) => line.includes("can only invite them again")), JSON.stringify(removeActive))
  assert.ok(removeActive.some((line) => line.includes("revoked")), JSON.stringify(removeActive))
  assert.deepEqual(membersPeopleArea.irreversible?.({ kind: "delete", targetId: invited.id, previous: invited }), [`The invitation of ${invited.spec.email} is cancelled; a restore sends them a new one.`])
  const email = "ada@example.test"
  const spec = { email, role: "member", status: "invited", teams: [], managedBy: "manual" }
  assert.deepEqual(membersPeopleArea.irreversible?.({ kind: "create", item: { name: email, spec: { ...spec, [SEND_INVITE_EMAIL_FIELD]: true } } }), [`An invitation email is sent to ${email}.`])
  assert.deepEqual(membersPeopleArea.irreversible?.({ kind: "create", item: { name: email, spec } }), [])
  const [team] = await membersTeamsArea.exportItems(sourceCtx)
  assert.ok(team)
  assert.equal(membersTeamsArea.irreversible?.({ kind: "delete", targetId: team.id, previous: team }).length, 2)
  assert.deepEqual(membersTeamsArea.irreversible?.(updateOp(membersTeamsArea, team, { name: "x", spec: team.spec })), [])
})
