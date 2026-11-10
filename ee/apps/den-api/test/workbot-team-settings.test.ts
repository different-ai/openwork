import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  applyWorkbotTeamSettingsWrite,
  countWorkbotTeamConflicts,
  readWorkbotEnabled,
  readWorkbotTeamSettings,
  resolveWorkbotTeamSettings,
  withWorkbotEnabled,
  workbotEveryoneSettingsWriteSchema,
  workbotTeamSettingsWriteSchema,
} from "@openwork/types/den/workbot-team-settings"

// Importing these modules never touches the database; the values only satisfy env validation.
for (const [name, value] of Object.entries({
  OPENWORK_DEV_MODE: "1",
  DB_MODE: "mysql",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den",
  DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890",
  BETTER_AUTH_SECRET: "local-dev-secret-not-for-production-use!!",
  BETTER_AUTH_URL: "http://localhost:8790",
})) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

const { organizationWorkbotSettings, resolveMemberWorkbotSettings } = await import("../src/workbot/team-settings.ts")
type Deps = NonNullable<Parameters<typeof resolveMemberWorkbotSettings>[1]>

const orgId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const organization = { model: "gateway/org", name: "Acme", enabled: true, maxSteps: null }
const fromOrganization = { kind: "organization" as const, teamConflict: false }
const onForEveryone = { value: true, from: fromOrganization }
const defaultSteps = { value: null, from: fromOrganization }

test("a member with no overriding team gets the organization's model and name", () => {
  const expected = { model: { value: "gateway/org", from: fromOrganization }, name: { value: "Acme", from: fromOrganization }, enabled: onForEveryone, maxSteps: defaultSteps }
  assert.deepEqual(resolveWorkbotTeamSettings({ organization, teams: [] }), expected)
  assert.deepEqual(resolveWorkbotTeamSettings({ organization, teams: [{ name: "Sales", settings: {} }] }), expected)
  // An organization with nothing set stays on the deployment's default model and no name.
  const unset = resolveWorkbotTeamSettings({ organization: { model: null, name: null, enabled: true, maxSteps: null }, teams: [{ name: "Sales", settings: {} }] })
  assert.equal(unset.model.value, null)
  assert.equal(unset.name.value, null)
  assert.equal(unset.enabled.value, true)
})

test("Workbot on or off resolves like the other settings: a team's own, the organization's on a conflict", () => {
  const off = { ...organization, enabled: false }
  const research = (enabled: boolean) => ({ name: "Research", settings: { enabled } })
  const design = (enabled: boolean) => ({ name: "Design", settings: { enabled } })
  const fromTeams = (...teamNames: string[]) => ({ kind: "team" as const, teamNames })
  const conflict = { kind: "organization" as const, teamConflict: true }
  const resolve = (base: typeof organization, teams: Parameters<typeof resolveWorkbotTeamSettings>[0]["teams"]) => resolveWorkbotTeamSettings({ organization: base, teams }).enabled

  // No team says: the organization's, on or off.
  assert.deepEqual(resolve(organization, [{ name: "Sales", settings: { name: "Scout" } }]), onForEveryone)
  assert.deepEqual(resolve(off, []), { value: false, from: fromOrganization })
  // One team turns it off for its members, or back on while the organization is off.
  assert.deepEqual(resolve(organization, [research(false), { name: "Sales", settings: {} }]), { value: false, from: fromTeams("Research") })
  assert.deepEqual(resolve(off, [research(true)]), { value: true, from: fromTeams("Research") })
  // Teams that agree apply; teams that differ give the organization's, whichever it is.
  assert.deepEqual(resolve(organization, [research(false), design(false)]), { value: false, from: fromTeams("Design", "Research") })
  assert.deepEqual(resolve(organization, [research(false), design(true)]), { value: true, from: conflict })
  assert.deepEqual(resolve(off, [design(true), research(false)]), { value: false, from: conflict })
  // The switch never moves the model or the name.
  const mixed = resolveWorkbotTeamSettings({ organization: off, teams: [{ name: "Research", settings: { enabled: true, model: "gateway/research" } }] })
  assert.deepEqual(mixed.model, { value: "gateway/research", from: fromTeams("Research") })
  assert.deepEqual(mixed.name, { value: "Acme", from: fromOrganization })
})

test("the step limit resolves like the other settings: a team's own, the organization's on a conflict", () => {
  const limited = { ...organization, maxSteps: 500 }
  const research = (maxSteps: number | null) => ({ name: "Research", settings: { maxSteps } })
  const design = (maxSteps: number | null) => ({ name: "Design", settings: { maxSteps } })
  const fromTeams = (...teamNames: string[]) => ({ kind: "team" as const, teamNames })
  const conflict = { kind: "organization" as const, teamConflict: true }
  const resolve = (base: typeof limited, teams: Parameters<typeof resolveWorkbotTeamSettings>[0]["teams"]) => resolveWorkbotTeamSettings({ organization: base, teams }).maxSteps

  // No team says: the organization's, a number or the deployment's default.
  assert.deepEqual(resolve(limited, [{ name: "Sales", settings: { name: "Scout" } }]), { value: 500, from: fromOrganization })
  assert.deepEqual(resolve({ ...limited, maxSteps: null }, []), defaultSteps)
  // A team's own limit; no limit (0) and the deployment's default (null) are choices too, not "use the organization's".
  assert.deepEqual(resolve(limited, [research(100), { name: "Sales", settings: {} }]), { value: 100, from: fromTeams("Research") })
  assert.deepEqual(resolve(limited, [research(0)]), { value: 0, from: fromTeams("Research") })
  assert.deepEqual(resolve(limited, [research(null)]), { value: null, from: fromTeams("Research") })
  // Teams that agree apply; teams that differ give the organization's.
  assert.deepEqual(resolve(limited, [research(100), design(100)]), { value: 100, from: fromTeams("Design", "Research") })
  assert.deepEqual(resolve(limited, [research(100), design(250)]), { value: 500, from: conflict })
  assert.deepEqual(resolve(limited, [design(null), research(0)]), { value: 500, from: conflict })
  // The step limit never moves the model, the name or the switch.
  const mixed = resolveWorkbotTeamSettings({ organization: limited, teams: [{ name: "Research", settings: { maxSteps: 100, model: "gateway/research" } }] })
  assert.deepEqual(mixed.model, { value: "gateway/research", from: fromTeams("Research") })
  assert.deepEqual(mixed.name, { value: "Acme", from: fromOrganization })
  assert.deepEqual(mixed.enabled, onForEveryone)
})

test("one overriding team replaces the organization's value, each setting on its own", () => {
  const resolved = resolveWorkbotTeamSettings({ organization, teams: [{ name: "Research", settings: { model: "gateway/research" } }, { name: "Sales", settings: {} }] })
  assert.deepEqual(resolved.model, { value: "gateway/research", from: { kind: "team", teamNames: ["Research"] } })
  assert.deepEqual(resolved.name, { value: "Acme", from: fromOrganization })
  // A team's null model is its own choice (the deployment's default), not "use the organization's".
  const deploymentDefault = resolveWorkbotTeamSettings({ organization, teams: [{ name: "Research", settings: { model: null, name: "Scout" } }] })
  assert.deepEqual(deploymentDefault.model, { value: null, from: { kind: "team", teamNames: ["Research"] } })
  assert.deepEqual(deploymentDefault.name, { value: "Scout", from: { kind: "team", teamNames: ["Research"] } })
})

test("teams that agree apply and are all named; teams that disagree fall back to the organization's", () => {
  const agreeing = resolveWorkbotTeamSettings({
    organization,
    teams: [{ name: "Zeta", settings: { model: "gateway/shared", name: "Scout" } }, { name: "Alpha", settings: { model: "gateway/shared" } }],
  })
  assert.deepEqual(agreeing.model, { value: "gateway/shared", from: { kind: "team", teamNames: ["Alpha", "Zeta"] } })
  assert.deepEqual(agreeing.name, { value: "Scout", from: { kind: "team", teamNames: ["Zeta"] } })

  const conflict = {
    organization,
    teams: [{ name: "Research", settings: { model: "gateway/research", name: "Scout" } }, { name: "Design", settings: { model: "gateway/design", name: "Scout" } }],
  }
  const resolved = resolveWorkbotTeamSettings(conflict)
  // The model conflicts, the name does not: only the model goes back to the organization's.
  assert.deepEqual(resolved.model, { value: "gateway/org", from: { kind: "organization", teamConflict: true } })
  assert.deepEqual(resolved.name, { value: "Scout", from: { kind: "team", teamNames: ["Design", "Research"] } })
  // Order never changes the answer.
  assert.deepEqual(resolveWorkbotTeamSettings({ ...conflict, teams: [...conflict.teams].reverse() }), resolved)
  // The deployment's default against a named model is a conflict too.
  const againstDefault = resolveWorkbotTeamSettings({ organization, teams: [{ name: "A", settings: { model: null } }, { name: "B", settings: { model: "gateway/b" } }] })
  assert.deepEqual(againstDefault.model, { value: "gateway/org", from: { kind: "organization", teamConflict: true } })
})

test("each team counts its members who are in a conflict for at least one setting", () => {
  const counts = countWorkbotTeamConflicts({
    teams: [
      { teamId: "research", settings: { model: "gateway/research", name: "Scout" } },
      { teamId: "design", settings: { model: "gateway/design" } },
      { teamId: "sales", settings: {} },
      { teamId: "ops", settings: { model: "gateway/research" } },
      { teamId: "support", settings: { name: "Helper" } },
      { teamId: "paused", settings: { enabled: false } },
      { teamId: "pilot", settings: { enabled: true } },
      { teamId: "short", settings: { maxSteps: 100 } },
      { teamId: "long", settings: { maxSteps: 0 } },
      { teamId: "plain", settings: { maxSteps: null } },
    ],
    memberships: [
      { teamId: "research", memberId: "a" }, { teamId: "design", memberId: "a" }, // a: models differ
      { teamId: "research", memberId: "b" }, { teamId: "ops", memberId: "b" }, // b: same model twice, one name
      { teamId: "design", memberId: "c" }, { teamId: "sales", memberId: "c" }, // c: sales uses the organization's
      { teamId: "research", memberId: "d" }, { teamId: "support", memberId: "d" }, // d: names differ, one model
      { teamId: "design", memberId: "e" }, { teamId: "support", memberId: "e" }, // e: different settings, no conflict
      { teamId: "paused", memberId: "f" }, { teamId: "pilot", memberId: "f" }, // f: one team off, one on
      { teamId: "paused", memberId: "g" }, { teamId: "sales", memberId: "g" }, // g: off in one, the organization's in the other
      { teamId: "short", memberId: "h" }, { teamId: "long", memberId: "h" }, // h: step limits differ
      { teamId: "long", memberId: "i" }, { teamId: "plain", memberId: "i" }, // i: no limit against the deployment's default
      { teamId: "short", memberId: "j" }, { teamId: "sales", memberId: "j" }, // j: one limit, the organization's in the other
    ],
  })
  assert.deepEqual(Object.fromEntries(counts), { research: 2, design: 1, sales: 0, ops: 0, support: 1, paused: 1, pilot: 1, short: 1, long: 2, plain: 1 })
})

test("stored settings keep what can be read and treat the rest as no override", () => {
  assert.deepEqual(readWorkbotTeamSettings({ model: "gateway/a", name: " Scout " }), { model: "gateway/a", name: "Scout" })
  assert.deepEqual(readWorkbotTeamSettings({ model: null }), { model: null })
  assert.deepEqual(readWorkbotTeamSettings({ enabled: false }), { enabled: false })
  assert.deepEqual(readWorkbotTeamSettings({ enabled: true, name: "Scout" }), { name: "Scout", enabled: true })
  assert.deepEqual(readWorkbotTeamSettings({ enabled: "false", name: "Scout" }), { name: "Scout" })
  // A step limit: a whole number in range, 0 for no limit, or null for the deployment's default.
  for (const maxSteps of [100, 0, null, 100_000]) assert.deepEqual(readWorkbotTeamSettings({ maxSteps }), { maxSteps })
  for (const maxSteps of [-1, 1.5, 100_001, "100", true]) assert.deepEqual(readWorkbotTeamSettings({ maxSteps, name: "Scout" }), { name: "Scout" }, String(maxSteps))
  // Keys added by a later version are tolerated; a value that cannot be read is no override.
  assert.deepEqual(readWorkbotTeamSettings({ name: "Scout", proactive: { enabled: false } }), { name: "Scout" })
  assert.deepEqual(readWorkbotTeamSettings({ model: 12, name: "x".repeat(41) }), {})
  assert.deepEqual(readWorkbotTeamSettings({ model: "", name: "Scout" }), { name: "Scout" })
  assert.deepEqual(readWorkbotTeamSettings(JSON.stringify({ name: "Scout" })), { name: "Scout" })
  for (const unreadable of [null, undefined, "not json", [], 7]) assert.deepEqual(readWorkbotTeamSettings(unreadable), {})
})

test("a change sets or clears each setting and leaves the others, including unknown keys", () => {
  const parse = (value: unknown) => workbotTeamSettingsWriteSchema.safeParse(value)
  assert.equal(parse({}).success, true)
  assert.equal(parse({ model: { inherit: true } }).success, true)
  assert.equal(parse({ model: { inherit: false, value: null }, name: { inherit: false, value: "Scout" } }).success, true)
  for (const enabled of [{ inherit: true }, { inherit: false, value: false }, { inherit: false, value: true }]) assert.equal(parse({ enabled }).success, true)
  for (const maxSteps of [{ inherit: true }, { inherit: false, value: 250 }, { inherit: false, value: 0 }, { inherit: false, value: null }]) assert.equal(parse({ maxSteps }).success, true, JSON.stringify(maxSteps))
  assert.deepEqual(parse({ name: { inherit: false, value: " Scout " } }).data, { name: { inherit: false, value: "Scout" } })
  for (const refused of [
    { model: { inherit: true, value: "gateway/a" } },
    { model: { inherit: false } },
    { model: { inherit: false, value: "" } },
    { name: { inherit: false, value: null } },
    { name: { inherit: false, value: "   " } },
    { name: { inherit: false, value: "x".repeat(41) } },
    { name: "Scout" },
    { enabled: false },
    { enabled: { inherit: false } },
    { enabled: { inherit: false, value: "off" } },
    { enabled: { inherit: true, value: false } },
    { maxSteps: 250 },
    { maxSteps: { inherit: false } },
    { maxSteps: { inherit: false, value: -1 } },
    { maxSteps: { inherit: false, value: 2.5 } },
    { maxSteps: { inherit: false, value: 100_001 } },
    { maxSteps: { inherit: false, value: "250" } },
    { maxSteps: { inherit: true, value: 250 } },
    { other: { inherit: true } },
  ]) assert.equal(parse(refused).success, false, JSON.stringify(refused))

  const stored = { model: "gateway/a", proactive: { enabled: false } }
  assert.deepEqual(applyWorkbotTeamSettingsWrite(stored, { name: { inherit: false, value: "Scout" } }), { ...stored, name: "Scout" })
  assert.deepEqual(applyWorkbotTeamSettingsWrite(stored, { model: { inherit: false, value: null } }), { model: null, proactive: { enabled: false } })
  assert.deepEqual(applyWorkbotTeamSettingsWrite(stored, { model: { inherit: true } }), { proactive: { enabled: false } })
  assert.deepEqual(applyWorkbotTeamSettingsWrite(stored, {}), stored)
  // Off is a value of its own; only "use the organization's" removes it.
  const paused = applyWorkbotTeamSettingsWrite(stored, { enabled: { inherit: false, value: false } })
  assert.deepEqual(paused, { ...stored, enabled: false })
  assert.deepEqual(applyWorkbotTeamSettingsWrite(paused, { enabled: { inherit: false, value: true } }), { ...stored, enabled: true })
  assert.deepEqual(applyWorkbotTeamSettingsWrite(paused, { name: { inherit: false, value: "Scout" } }), { ...paused, name: "Scout" })
  assert.deepEqual(applyWorkbotTeamSettingsWrite(paused, { enabled: { inherit: true } }), stored)
  assert.deepEqual(applyWorkbotTeamSettingsWrite({ enabled: false }, { enabled: { inherit: true } }), {})
  // No limit and the deployment's default are values of their own; only "use the organization's" removes the limit.
  const limited = applyWorkbotTeamSettingsWrite(stored, { maxSteps: { inherit: false, value: 250 } })
  assert.deepEqual(limited, { ...stored, maxSteps: 250 })
  assert.deepEqual(applyWorkbotTeamSettingsWrite(limited, { maxSteps: { inherit: false, value: 0 } }), { ...stored, maxSteps: 0 })
  assert.deepEqual(applyWorkbotTeamSettingsWrite(limited, { maxSteps: { inherit: false, value: null } }), { ...stored, maxSteps: null })
  assert.deepEqual(applyWorkbotTeamSettingsWrite(limited, { name: { inherit: false, value: "Scout" } }), { ...limited, name: "Scout" })
  assert.deepEqual(applyWorkbotTeamSettingsWrite(limited, { maxSteps: { inherit: true } }), stored)
  assert.deepEqual(applyWorkbotTeamSettingsWrite({ maxSteps: null }, { maxSteps: { inherit: true } }), {})
  assert.deepEqual(applyWorkbotTeamSettingsWrite({ maxSteps: "many", name: "Scout" }, { name: { inherit: true } }), {})
  // Nothing left: the caller deletes the row. A value that could not be read is dropped with it.
  assert.deepEqual(applyWorkbotTeamSettingsWrite({ model: "gateway/a", name: 5 }, { model: { inherit: true } }), {})
})

test("the organization's values come from its metadata", () => {
  assert.deepEqual(organizationWorkbotSettings({ brandAppName: " Acme ", workbot: { model: "gateway/org" } }), organization)
  assert.deepEqual(organizationWorkbotSettings(JSON.stringify({ brandAppName: "Acme" })), { model: null, name: "Acme", enabled: true, maxSteps: null })
  for (const empty of [null, undefined, "not json", { brandAppName: "  " }]) assert.deepEqual(organizationWorkbotSettings(empty), { model: null, name: null, enabled: true, maxSteps: null })
  assert.deepEqual(organizationWorkbotSettings({ brandAppName: "Acme", workbot: { model: "gateway/org", enabled: false } }), { ...organization, enabled: false })
  assert.deepEqual(organizationWorkbotSettings({ brandAppName: "Acme", workbot: { model: "gateway/org", maxSteps: 500 } }), { ...organization, maxSteps: 500 })
  assert.deepEqual(organizationWorkbotSettings({ brandAppName: "Acme", workbot: { model: "gateway/org", maxSteps: 0 } }), { ...organization, maxSteps: 0 })
})

test("Workbot is on for an organization unless its metadata turns it off, and turning it on removes the key", () => {
  // Absent, or anything that is not exactly false, is on: existing organizations are unchanged.
  for (const value of [null, undefined, "not json", {}, { workbot: null }, { workbot: {} }, { workbot: { enabled: true } }, { workbot: { enabled: "false" } }, { workbot: { enabled: 0 } }]) {
    assert.equal(readWorkbotEnabled(value), true, JSON.stringify(value))
  }
  assert.equal(readWorkbotEnabled({ workbot: { enabled: false } }), false)
  assert.equal(readWorkbotEnabled(JSON.stringify({ workbot: { enabled: false, model: "gateway/org" } })), false)

  const metadata = { brandAppName: "Acme", workbot: { model: "gateway/org", proactive: { enabled: true } } }
  const off = withWorkbotEnabled(metadata, false)
  assert.deepEqual(off, { brandAppName: "Acme", workbot: { model: "gateway/org", proactive: { enabled: true }, enabled: false } })
  assert.deepEqual(withWorkbotEnabled(off, true), metadata)
  assert.deepEqual(withWorkbotEnabled({ brandAppName: "Acme" }, false), { brandAppName: "Acme", workbot: { enabled: false } })
  // The change for everyone is a strict object, so a later setting cannot be sent to a server that ignores it.
  const parse = (value: unknown) => workbotEveryoneSettingsWriteSchema.safeParse(value).success
  for (const accepted of [{}, { enabled: false }, { enabled: true }]) assert.equal(parse(accepted), true, JSON.stringify(accepted))
  for (const refused of [{ enabled: "off" }, { enabled: null }, { enabled: { inherit: true } }, { model: null }, { enabled: false, name: "Scout" }]) assert.equal(parse(refused), false, JSON.stringify(refused))
})

const metadata = { brandAppName: "Acme", workbot: { model: "gateway/org" } }
const organizationValues = {
  model: "gateway/org", name: "Acme", enabled: true, maxSteps: null,
  modelFrom: fromOrganization, nameFrom: fromOrganization, enabledFrom: fromOrganization, maxStepsFrom: fromOrganization,
}
const never = async (): Promise<never> => { throw new Error("must not be read") }

test("with the feature off a member gets the organization's values and no team is read", async () => {
  const off: Deps = { metadata: async () => metadata, featureOn: async () => false, memberId: never, teams: never, rows: never }
  assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, memberId, userId }, off), organizationValues)
  // A caller that already holds the organization and its features reads nothing at all.
  const nothing: Deps = { metadata: never, featureOn: never, memberId: never, teams: never, rows: never }
  assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, memberId, organization: { metadata }, featureOn: false }, nothing), organizationValues)
  // A switch saved while the feature was on is kept but ignored: everyone has Workbot again.
  const savedOff = { organization: { metadata: { ...metadata, workbot: { ...metadata.workbot, enabled: false } } } }
  assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, memberId, ...savedOff, featureOn: false }, nothing), organizationValues)
})

test("with the feature on Workbot is off for a member when the organization or their teams turn it off", async () => {
  const teams = [{ id: "tem_1", name: "Research" }, { id: "tem_2", name: "Sales" }]
  const deps = (rows: { teamId: string; settings: unknown }[], organizationOn = true): Deps => ({
    metadata: async () => organizationOn ? metadata : { ...metadata, workbot: { ...metadata.workbot, enabled: false } },
    featureOn: never,
    memberId: never,
    teams: async () => teams,
    rows: async () => rows,
  })
  const resolve = async (rows: { teamId: string; settings: unknown }[], organizationOn = true) => {
    const resolved = await resolveMemberWorkbotSettings({ organizationId: orgId, memberId, featureOn: true }, deps(rows, organizationOn))
    return { enabled: resolved.enabled, from: resolved.enabledFrom }
  }
  assert.deepEqual(await resolve([]), { enabled: true, from: fromOrganization })
  assert.deepEqual(await resolve([], false), { enabled: false, from: fromOrganization })
  assert.deepEqual(await resolve([{ teamId: "tem_1", settings: { enabled: false } }]), { enabled: false, from: { kind: "team", teamNames: ["Research"] } })
  assert.deepEqual(await resolve([{ teamId: "tem_1", settings: { enabled: true } }], false), { enabled: true, from: { kind: "team", teamNames: ["Research"] } })
  const differ = [{ teamId: "tem_1", settings: { enabled: true } }, { teamId: "tem_2", settings: { enabled: false } }]
  assert.deepEqual(await resolve(differ), { enabled: true, from: { kind: "organization", teamConflict: true } })
  assert.deepEqual(await resolve(differ, false), { enabled: false, from: { kind: "organization", teamConflict: true } })
  // A member of no team, or one who cannot be found, has the organization's switch.
  assert.equal((await resolveMemberWorkbotSettings({ organizationId: orgId, memberId, featureOn: true }, { ...deps([], false), teams: async () => [] })).enabled, false)
  assert.equal((await resolveMemberWorkbotSettings({ organizationId: orgId, featureOn: true }, { ...deps([], false), teams: never, rows: never })).enabled, false)
})

test("a member's step limit is their team's with the feature on, and the organization's otherwise", async () => {
  const limited = { ...metadata, workbot: { ...metadata.workbot, maxSteps: 500 } }
  const teams = [{ id: "tem_1", name: "Research" }, { id: "tem_2", name: "Sales" }]
  const resolve = async (rows: { teamId: string; settings: unknown }[], featureOn = true) => {
    const deps: Deps = { metadata: async () => limited, featureOn: never, memberId: never, teams: featureOn ? async () => teams : never, rows: featureOn ? async () => rows : never }
    const resolved = await resolveMemberWorkbotSettings({ organizationId: orgId, memberId, featureOn }, deps)
    return { maxSteps: resolved.maxSteps, from: resolved.maxStepsFrom }
  }
  assert.deepEqual(await resolve([]), { maxSteps: 500, from: fromOrganization })
  assert.deepEqual(await resolve([{ teamId: "tem_1", settings: { name: "Scout" } }]), { maxSteps: 500, from: fromOrganization })
  assert.deepEqual(await resolve([{ teamId: "tem_1", settings: { maxSteps: 100 } }]), { maxSteps: 100, from: { kind: "team", teamNames: ["Research"] } })
  assert.deepEqual(await resolve([{ teamId: "tem_1", settings: { maxSteps: null } }]), { maxSteps: null, from: { kind: "team", teamNames: ["Research"] } })
  assert.deepEqual(await resolve([{ teamId: "tem_1", settings: { maxSteps: 100 } }, { teamId: "tem_2", settings: { maxSteps: 0 } }]), { maxSteps: 500, from: { kind: "organization", teamConflict: true } })
  // Team settings off: the organization's limit, and no team is read.
  assert.deepEqual(await resolve([{ teamId: "tem_1", settings: { maxSteps: 100 } }], false), { maxSteps: 500, from: fromOrganization })
})

test("with the feature on a member gets their teams' values, found from the member or the user", async () => {
  const seen: string[] = []
  const on: Deps = {
    metadata: async () => metadata,
    featureOn: async (_organizationId, user) => { seen.push(`enabled:${user}`); return true },
    memberId: async (_organizationId, user) => { seen.push(`member:${user}`); return memberId },
    teams: async (member) => { seen.push(`teams:${member.memberId}`); return [{ id: "tem_1", name: "Research" }, { id: "tem_2", name: "Sales" }] },
    rows: async (_organizationId, teamIds) => { seen.push(`rows:${teamIds.join(",")}`); return [{ teamId: "tem_1", settings: { model: "gateway/research", name: "Scout" } }] },
  }
  const expected = {
    model: "gateway/research", name: "Scout", enabled: true, maxSteps: null,
    modelFrom: { kind: "team", teamNames: ["Research"] }, nameFrom: { kind: "team", teamNames: ["Research"] }, enabledFrom: fromOrganization, maxStepsFrom: fromOrganization,
  }
  assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, userId }, on), expected)
  assert.deepEqual(seen, [`enabled:${userId}`, `member:${userId}`, `teams:${memberId}`, "rows:tem_1,tem_2"])
  seen.length = 0
  assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, memberId, userId, featureOn: true }, on), expected)
  assert.deepEqual(seen, [`teams:${memberId}`, "rows:tem_1,tem_2"])

  const conflicting: Deps = { ...on, rows: async () => [{ teamId: "tem_1", settings: { model: "gateway/research" } }, { teamId: "tem_2", settings: { model: "gateway/sales" } }] }
  assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, memberId, featureOn: true }, conflicting), {
    ...organizationValues, modelFrom: { kind: "organization", teamConflict: true },
  })
})

test("a member who cannot be found or a failed read gives the organization's values instead of failing the chat", async () => {
  const base: Deps = { metadata: async () => metadata, featureOn: async () => true, memberId: async () => memberId, teams: async () => [{ id: "tem_1", name: "Research" }], rows: never }
  const warn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, userId }, base), organizationValues)
    assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, userId }, { ...base, teams: never }), organizationValues)
    assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, userId }, { ...base, featureOn: never }), organizationValues)
    assert.equal(warnings.length, 3)
    // No member, no teams and no rows are ordinary answers, not failures.
    assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, userId }, { ...base, memberId: async () => null, teams: never }), organizationValues)
    assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId }, { ...base, memberId: never, teams: never }), organizationValues)
    assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, memberId }, { ...base, teams: async () => [] }), organizationValues)
    assert.deepEqual(await resolveMemberWorkbotSettings({ organizationId: orgId, memberId }, { ...base, rows: async () => [] }), organizationValues)
    assert.equal(warnings.length, 3)
  } finally {
    console.warn = warn
  }
})
