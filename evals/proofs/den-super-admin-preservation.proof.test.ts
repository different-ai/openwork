import { expect } from "vitest"
import { spec } from "@openwork/testkit"
import { superAdminUpgrade, field, preservedKeys } from "../worlds/den-super-admin-upgrade.ts"

const test = spec.world(superAdminUpgrade, {
  resources: { surfaces: [], services: ["den"] },
  needs: { placement: "local" },
  timeout: 600_000,
})

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected an API result array")
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Expected an API result object")
    return Object.fromEntries(Object.entries(item))
  })
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected an API string")
  return value
}
function keys(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(key => typeof key === "string")) throw new Error("Expected API permission keys")
  return value
}

test("pre-deprecation upgrades preserve only the active super-admin roster; later databases and revocations stay unchanged", async ({ world, step, evidence }) => {
  const { cohort, expected } = world
  let owner = await world.login(cohort.owner.email)
  const teamList = await world.call(owner, "/v1/org")
  const preserved = records(teamList.data.teams).filter(team => text(team.name).startsWith("Super Admins ("))
  expect(preserved).toHaveLength(1)
  const teamId = text(preserved[0].id)
  const detail = await world.call(owner, `/v1/teams/${teamId}`)
  const team = field(detail.data, "team")
  const setList = await world.call(owner, "/v1/permissions/sets")
  expect(setList.status, JSON.stringify(setList.data)).toBe(200)
  const sets = records(setList.data.sets).filter(set => set.name === "Super Admins Permissions")
  expect(sets).toHaveLength(1)
  const setId = text(sets[0].id)

  await step("the visible team contains only the active stored super-admins and grants exactly fourteen capabilities", async () => {
    expect(teamList.status).toBe(200)
    expect(detail.status).toBe(200)
    const roster = keys(field(team, "memberIds")).sort()
    expect(roster).toEqual(expected.map(label => cohort.ids[label]).sort())
    expect(field(team, "grantsOrganizationAdmin")).toBe(false)
    const read = await world.call(owner, `/v1/permissions/sets/${setId}`)
    const allowed = records(field(read.data, "set", "permissions")).filter(row => row.status === "allow").map(row => text(row.key)).sort()
    expect(allowed).toEqual(preservedKeys)
    const secondOwner = await world.login("exp-o2-second-owner@example.test")
    const secondTeams = await world.call(secondOwner, "/v1/org")
    expect(records(secondTeams.data.teams).filter(row => text(row.name).startsWith("Super Admins ("))).toHaveLength(0)
    evidence.recordAssertionEvidence("Only the active cohort receives the visible team and fourteen grants", `${world.version}: ${roster.length} selected memberships; ${allowed.length} allowed keys; no team in the second org`, roster.length === expected.length && allowed.length === preservedKeys.length)
  })

  await step("preserved people really manage roles and permissions while ordinary admins cannot enroll themselves", async () => {
    for (const label of [...expected, "admin", "member", "demoted", "teamadmin", "wrongcase", "substring", "owner", "ownercombo"]) {
      const who = await world.login(cohort.identities[label].email)
      const result = await world.call(who, "/v1/org")
      expect(result.status).toBe(200)
      const held = keys(field(result.data, "currentMember", "permissions"))
      if (expected.includes(label)) {
        expect(held).toHaveLength(55)
        expect(held).toEqual(expect.arrayContaining(preservedKeys))
        expect(held).not.toContain("agent_permissions.manage")
        expect(held).not.toContain("deployments.manage")
        expect((await world.call(who, `/v1/members/${cohort.ids.member}/role`, "POST", { role: "admin" })).status).toBe(200)
        const target = await world.login(cohort.identities.member.email)
        expect(field((await world.call(target, "/v1/org")).data, "currentMember", "role")).toBe("admin")
        expect((await world.call(who, `/v1/members/${cohort.ids.member}/role`, "POST", { role: "member" })).status).toBe(200)
        expect((await world.call(who, `/v1/permissions/sets/${setId}/permissions`, "PUT", { changes: [{ key: "branding.update", status: "deny" }] })).status).toBe(200)
        const read = await world.call(who, `/v1/permissions/sets/${setId}`)
        expect(records(field(read.data, "set", "permissions")).find(row => row.key === "branding.update")?.status).toBe("deny")
        expect((await world.call(who, `/v1/permissions/sets/${setId}/permissions`, "PUT", { changes: [{ key: "branding.update", status: "allow" }] })).status).toBe(403)
        expect((await world.call(owner, `/v1/permissions/sets/${setId}/permissions`, "PUT", { changes: [{ key: "branding.update", status: "allow" }] })).status).toBe(200)
      } else if (["admin", "demoted", "teamadmin"].includes(label)) {
        expect(held).toHaveLength(41)
        expect(held.filter(key => preservedKeys.includes(key))).toEqual([])
        expect((await world.call(who, `/v1/teams/${teamId}`, "PATCH", { memberIds: [...expected.map(name => cohort.ids[name]), cohort.ids[label]] })).status).toBe(403)
        expect((await world.call(who, `/v1/members/${cohort.ids.member}/role`, "POST", { role: "admin" })).status).toBe(403)
        expect((await world.call(who, `/v1/permissions/sets/${setId}/permissions`, "PUT", { changes: [{ key: "members.update", status: "allow" }] })).status).toBe(403)
      } else expect(held).toHaveLength(["owner", "ownercombo"].includes(label) ? 57 : 0)
      evidence.recordAssertionEvidence(`${label} has exactly its intended effective access`, `${held.length} keys on ${world.version}`, held.length === (expected.includes(label) ? 55 : ["admin", "demoted", "teamadmin"].includes(label) ? 41 : ["owner", "ownercombo"].includes(label) ? 57 : 0))
    }
    await world.capture(teamId, setId)
  })

  await step("replaying the upgrade cannot undo owner removal or permission-set deletion", async () => {
    const stable = await world.call(owner, `/v1/teams/${teamId}`)
    world.replay()
    expect((await world.call(owner, `/v1/teams/${teamId}`)).data).toEqual(stable.data)
    const retained = expected.filter(label => label !== "promoted").map(label => cohort.ids[label])
    expect((await world.call(owner, `/v1/teams/${teamId}`, "PATCH", { memberIds: retained })).status).toBe(200)
    world.replay()
    expect(keys(field((await world.call(owner, `/v1/teams/${teamId}`)).data, "team", "memberIds")).sort()).toEqual(retained.sort())
    const removed = await world.login(cohort.identities.promoted.email)
    expect((await world.call(removed, `/v1/members/${cohort.ids.member}/role`, "POST", { role: "admin" })).status).toBe(403)
    expect([200, 204]).toContain((await world.call(owner, `/v1/permissions/sets/${setId}`, "DELETE")).status)
    world.replay()
    const invited = await world.login(cohort.identities.invited.email)
    const denied = await world.call(invited, `/v1/members/${cohort.ids.member}/role`, "POST", { role: "admin" })
    expect(denied.status).toBe(403)
    expect(records((await world.call(owner, "/v1/permissions/sets")).data.sets).find(row => row.id === setId)).toBeUndefined()
    evidence.recordAssertionEvidence("Owner revocations survive restart and exact SQL replay", `remaining roster=${retained.length}; deleted set absent; member-role request=${denied.status}`, denied.status === 403 && retained.length === expected.length - 1)
  })

  await step("a database already upgraded through released 0.18.59 receives no new team or privilege", async () => {
    await world.alreadyDeprecated()
    owner = await world.login(cohort.owner.email)
    const teams = records((await world.call(owner, "/v1/org")).data.teams)
    expect(teams.filter(row => text(row.name).startsWith("Super Admins ("))).toHaveLength(0)
    for (const label of expected) {
      const who = await world.login(cohort.identities[label].email)
      const held = keys(field((await world.call(who, "/v1/org")).data, "currentMember", "permissions"))
      expect(held).toHaveLength(41)
      expect(held.filter(key => preservedKeys.includes(key))).toEqual([])
    }
    evidence.recordAssertionEvidence("Already-deprecated installations are not repaired by guessing history", `new preservation teams=${teams.filter(row => text(row.name).startsWith("Super Admins (")).length}`, teams.every(row => !text(row.name).startsWith("Super Admins (")))
  })

  await step("fresh installation and ordinary organization creation add no preservation team or custom role", async () => {
    const freshOwner = await world.fresh()
    const teams = records((await world.call(freshOwner, "/v1/org")).data.teams)
    const sets = records((await world.call(freshOwner, "/v1/permissions/sets")).data.sets)
    expect(teams.filter(row => text(row.name).startsWith("Super Admins ("))).toHaveLength(0)
    expect(sets.filter(row => row.name === "Super Admins Permissions")).toHaveLength(0)
    evidence.recordAssertionEvidence("Fresh organizations keep ordinary defaults", `teams=${teams.length}; preservation sets=${sets.filter(row => row.name === "Super Admins Permissions").length}`, sets.every(row => row.name !== "Super Admins Permissions"))
  })
})
