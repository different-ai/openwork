import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { WorkbotTeamSettingTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { ConfigApplyItemError, type ConfigAreaContext, type ConfigItem } from "../../src/config-blobs/area.js"
import { bootDen, summary, type Call, type Member } from "./harness.js"
import { updateOp } from "./config-blobs-area-ops.js"

// workbot.team-settings (Members › Teams › a team › Workbot): export, readItems, a one-key write, a round trip
// into a second organization (the team found by name) and delete; and workbot.settings' `enabled` (Everyone).
// No runner is contacted: models are the deployment default (null) or one the applier can't use.
const den = await bootDen({ env: { DEN_WORKBOT_URL: "http://localhost:3020" } })
after(async () => { await den.close() })
const { db } = await import("../../src/db.js")
const { getOrganizationFeatures } = await import("../../src/features.js")
const { workbotTeamSettingsArea } = await import("../../src/config-blobs/areas/workbot-team-settings.js")
const { workbotSettingsArea } = await import("../../src/config-blobs/areas/workbot-settings.js")
const { getConfigArea } = await import("../../src/config-blobs/registry.js")

const path = "/v1/org/workbot-settings/teams"
const own = (value: string | number | boolean | null) => ({ inherit: false, value })

async function ok(call: Promise<Call>, label: string) {
  const result = await call
  assert.ok(result.status < 300, `${label}: ${summary(result)}`)
  return result
}

async function contextFor(orgId: string, actor: Member): Promise<ConfigAreaContext> {
  return { db, organizationId: orgId, actor: { userId: actor.userId, memberId: actor.memberId }, deployment: "self_hosted", features: await getOrganizationFeatures(orgId, { userId: actor.userId }) }
}

async function enable(orgId: string, ...features: Array<"workbotTeamSettings">) {
  for (const feature of features) assert.equal((await den.setFeature(orgId, feature, true)).status, 200, feature)
}

async function rows(orgId: string) {
  return db.$primary.select({ id: WorkbotTeamSettingTable.id, teamId: WorkbotTeamSettingTable.teamId, settings: WorkbotTeamSettingTable.settings })
    .from(WorkbotTeamSettingTable)
    .where(eq(WorkbotTeamSettingTable.organizationId, normalizeDenTypeId("organization", orgId)))
}

function byTeam(items: ConfigItem[], name: string): ConfigItem {
  const item = items.find((candidate) => candidate.name === name)
  assert.ok(item, `${name} is exported`)
  return item
}

/** The item as the engine hands it to apply: the team ref resolved to `teamId` on the target. */
function resolved(item: ConfigItem, teamId: string) {
  const team = item.spec.team
  assert.ok(typeof team === "object" && team !== null && !Array.isArray(team))
  return { sourceId: item.id, name: item.name, spec: { ...item.spec, team: { ...team, id: teamId } } }
}

// ---------------------------------------------------------------------------
// Source organization, set up through the public routes.

const owner = await den.signUp("Workbot Teams Owner")
const source = await den.createOrg(owner, "Workbot Teams Source")
const as = den.as(owner, source.orgId)
await enable(source.orgId, "workbotTeamSettings")
const research = await den.createTeam(owner, source.orgId, "Research", [])
const design = await den.createTeam(owner, source.orgId, "Design", [])
await den.createTeam(owner, source.orgId, "Untouched", [])
await ok(as("PUT", `${path}/${research}`, { name: own("Scout"), enabled: own(false), model: own(null) }), "research settings")
await ok(as("PUT", `${path}/${design}`, { name: own("Sketch") }), "design settings")
// A row saved while teams had a step limit still holds one; it is never exported.
await db.update(WorkbotTeamSettingTable).set({ settings: { model: null, name: "Scout", enabled: false, maxSteps: 25 } }).where(eq(WorkbotTeamSettingTable.teamId, normalizeDenTypeId("team", research)))
const sourceCtx = await contextFor(source.orgId, source.owner)

test("registered, owning workbot_team_setting, behind workbotTeamSettings", () => {
  assert.equal(getConfigArea("workbot.team-settings"), workbotTeamSettingsArea)
  assert.deepEqual(workbotTeamSettingsArea.tables, ["workbot_team_setting"])
  assert.equal(workbotTeamSettingsArea.feature, "workbotTeamSettings")
  assert.deepEqual(workbotTeamSettingsArea.dependsOn, ["members.teams", "ai-gateway.providers"])
})

test("export: one item per team with its own settings, only what it overrides, valid specs", async () => {
  const items = await workbotTeamSettingsArea.exportItems(sourceCtx)
  assert.deepEqual(items.map((item) => item.name), ["Design", "Research"], "teams without their own settings aren't exported")
  const stored = await rows(source.orgId)
  for (const item of items) {
    assert.ok(item.id.startsWith("wts_"), item.id)
    assert.ok(stored.some((row) => row.id === item.id))
    const parsed = workbotTeamSettingsArea.specSchema.safeParse(item.spec)
    assert.ok(parsed.success, parsed.success ? "" : parsed.error.message)
  }
  assert.deepEqual(byTeam(items, "Research").spec, {
    team: { $ref: `members.teams/${research}`, name: "Research" },
    settings: { model: null, name: "Scout", enabled: false },
  })
  assert.equal((await rows(source.orgId)).find((row) => row.teamId === research)?.settings.maxSteps, 25, "the stored row still holds the retired key")
  assert.deepEqual(byTeam(items, "Design").spec, { team: { $ref: `members.teams/${design}`, name: "Design" }, settings: { name: "Sketch" } })
  // Strict: an unknown setting is refused.
  assert.equal(workbotTeamSettingsArea.specSchema.safeParse({ team: { $ref: `members.teams/${design}` }, settings: { colour: "red" } }).success, false)
  // Stable.
  assert.equal(JSON.stringify(await workbotTeamSettingsArea.exportItems(sourceCtx)), JSON.stringify(items))
})

test("readItems: only the asked rows, nothing for other ids", async () => {
  assert.ok(workbotTeamSettingsArea.readItems)
  const items = await workbotTeamSettingsArea.exportItems(sourceCtx)
  const researchItem = byTeam(items, "Research")
  assert.deepEqual(await workbotTeamSettingsArea.readItems(sourceCtx, [researchItem.id]), [researchItem])
  assert.deepEqual(await workbotTeamSettingsArea.readItems(sourceCtx, ["wts_00000000000000000000000000", "not-an-id"]), [])
})

test("update writes only the keys the plan changes", async () => {
  const before = byTeam(await workbotTeamSettingsArea.exportItems(sourceCtx), "Research")
  const settings = { model: null, name: "Scout Two", enabled: false }
  const op = updateOp(workbotTeamSettingsArea, before, resolved({ ...before, spec: { ...before.spec, settings } }, research))
  assert.deepEqual(op.changes.map((change) => change.path), ["settings.name"])
  const result = await workbotTeamSettingsArea.apply(sourceCtx, op)
  assert.deepEqual(result.steps, [{ action: "set", target: "settings.name", detail: "Scout Two" }])
  assert.equal(result.localId, before.id)
  assert.deepEqual(byTeam(await workbotTeamSettingsArea.exportItems(sourceCtx), "Research").spec.settings, settings)
  assert.deepEqual((await rows(source.orgId)).find((row) => row.teamId === research)?.settings, settings, "the write dropped the retired step limit from the row")

  // The spec also differs in `enabled`, but the plan names only the name: `enabled` is untouched.
  const now = byTeam(await workbotTeamSettingsArea.exportItems(sourceCtx), "Research")
  const back = await workbotTeamSettingsArea.apply(sourceCtx, {
    kind: "update", targetId: now.id, previous: now,
    item: resolved({ ...now, spec: { ...now.spec, settings: { ...settings, name: "Scout", enabled: true } } }, research),
    changes: [{ path: "settings.name", from: "Scout Two", to: "Scout" }], secretPaths: [],
  })
  assert.deepEqual(back.steps, [{ action: "set", target: "settings.name", detail: "Scout" }])
  assert.deepEqual(byTeam(await workbotTeamSettingsArea.exportItems(sourceCtx), "Research").spec.settings, { ...settings, name: "Scout" })

  // A key left out goes back to the organization's.
  const design0 = byTeam(await workbotTeamSettingsArea.exportItems(sourceCtx), "Design")
  const dropped = updateOp(workbotTeamSettingsArea, design0, resolved({ ...design0, spec: { ...design0.spec, settings: { name: "Sketch", enabled: true } } }, design))
  assert.deepEqual((await workbotTeamSettingsArea.apply(sourceCtx, dropped)).steps, [{ action: "set", target: "settings.enabled", detail: "true" }])
  const design1 = byTeam(await workbotTeamSettingsArea.exportItems(sourceCtx), "Design")
  const restored = updateOp(workbotTeamSettingsArea, design1, resolved(design0, design))
  assert.deepEqual((await workbotTeamSettingsArea.apply(sourceCtx, restored)).steps, [{ action: "set", target: "settings.enabled", detail: "the organization's" }])
  assert.deepEqual(byTeam(await workbotTeamSettingsArea.exportItems(sourceCtx), "Design").spec, design0.spec)
})

test("round trip into a second organization: the team is found by name; a step limit in an older file is read and never applied", async () => {
  const targetOwner = await den.signUp("Workbot Teams Target Owner")
  const target = await den.createOrg(targetOwner, "Workbot Teams Target")
  await enable(target.orgId, "workbotTeamSettings")
  const targetResearch = await den.createTeam(targetOwner, target.orgId, "research", [])
  const targetCtx = await contextFor(target.orgId, target.owner)
  const blob = byTeam(await workbotTeamSettingsArea.exportItems(sourceCtx), "Research")
  // The same item as a file exported while teams had a step limit carries it.
  const olderBlob = { ...blob, spec: { ...blob.spec, settings: { ...Object(blob.spec.settings), maxSteps: 25 } } }
  assert.equal(workbotTeamSettingsArea.specSchema.safeParse(olderBlob.spec).success, true, "the older file is still a valid spec")

  // Matched by the lowercased team name, never by id.
  const naturalKey = workbotTeamSettingsArea.naturalKeys[0]
  assert.ok(naturalKey)
  assert.equal(naturalKey.get(blob), "team:research")

  // Everything but the step limit is written; a free preferred id is reused (the engine offers the source's id
  // only when it is free on the whole instance).
  const preferredId = createDenTypeId("workbotTeamSetting")
  const created = await workbotTeamSettingsArea.apply(targetCtx, { kind: "create", item: resolved(olderBlob, targetResearch), preferredId })
  assert.equal(created.localId, preferredId)
  assert.deepEqual(created.steps, [{ action: "create", target: "research", detail: "model: default, name: Scout, enabled: false" }])
  assert.equal(created.warnings, undefined)
  assert.deepEqual((await rows(target.orgId)).map((row) => row.settings), [{ model: null, name: "Scout", enabled: false }])
  const [first] = await workbotTeamSettingsArea.exportItems(targetCtx)
  assert.ok(first)
  assert.equal(naturalKey.get(first), "team:research")
  assert.deepEqual(first.spec, { team: { $ref: `members.teams/${targetResearch}`, name: "research" }, settings: { model: null, name: "Scout", enabled: false } })

  // Importing the older file again writes nothing: its step limit is the only difference.
  // As the engine plans it: the blob's team ref localized to the target's team.
  const op = updateOp(workbotTeamSettingsArea, first, resolved({ ...olderBlob, spec: { ...olderBlob.spec, team: first.spec.team } }, targetResearch))
  assert.deepEqual((await workbotTeamSettingsArea.apply(targetCtx, op)).steps, [])
  const [second] = await workbotTeamSettingsArea.exportItems(targetCtx)
  assert.deepEqual(second?.spec.settings, blob.spec.settings)

  // A model the applier can't use here fails on its field before anything is written.
  assert.ok(second)
  const withModel = { ...second.spec, settings: { ...blob.spec.settings, model: "custom/not-a-served-model" } }
  await assert.rejects(
    workbotTeamSettingsArea.apply(targetCtx, updateOp(workbotTeamSettingsArea, second, resolved({ ...second, spec: withModel }, targetResearch))),
    (error: unknown) => error instanceof ConfigApplyItemError && ["unknown_model", "workbot_runner_unavailable"].includes(error.failure.code) && error.failure.field === "settings.model" && error.stepsDone.length === 0,
  )
  assert.deepEqual((await workbotTeamSettingsArea.exportItems(targetCtx))[0]?.spec, second.spec)

  // A second create for the same team is refused.
  await assert.rejects(
    workbotTeamSettingsArea.apply(targetCtx, { kind: "create", item: resolved(blob, targetResearch) }),
    (error: unknown) => error instanceof ConfigApplyItemError && error.failure.code === "workbot_team_settings_exist",
  )

  // Delete: the team's row goes, and it uses the organization's settings again.
  const removed = await workbotTeamSettingsArea.apply(targetCtx, { kind: "delete", targetId: second.id, previous: second })
  assert.deepEqual(removed.steps, [{ action: "delete", target: "research", detail: "uses the organization's Workbot settings" }])
  assert.deepEqual(await rows(target.orgId), [])
  assert.deepEqual(await workbotTeamSettingsArea.exportItems(targetCtx), [])
  // Deleting again writes nothing.
  assert.deepEqual((await workbotTeamSettingsArea.apply(targetCtx, { kind: "delete", targetId: second.id, previous: second })).steps, [])
})

test("only a step limit, which Workbot no longer has: the create is skipped at plan time", async () => {
  const otherOwner = await den.signUp("Workbot Teams Preflight Owner")
  const org = await den.createOrg(otherOwner, "Workbot Teams Preflight")
  await enable(org.orgId, "workbotTeamSettings")
  const teamId = await den.createTeam(otherOwner, org.orgId, "Ops", [])
  const ctx = await contextFor(org.orgId, org.owner)
  const item = { name: "Ops", spec: { team: { $ref: `members.teams/${teamId}`, name: "Ops" }, settings: { maxSteps: 10 } } }
  assert.ok(workbotTeamSettingsArea.preflight)
  const verdict = await workbotTeamSettingsArea.preflight(ctx, { kind: "create", item }, { secrets: [] })
  assert.equal(verdict?.skip, "only a step limit, which Workbot no longer has")
  await assert.rejects(
    workbotTeamSettingsArea.apply(ctx, { kind: "create", item: resolved({ id: "x", ...item }, teamId) }),
    (error: unknown) => error instanceof ConfigApplyItemError && error.failure.code === "feature_disabled",
  )
  assert.deepEqual(await rows(org.orgId), [])
})

test("workbot.settings carries whether Workbot is on for everyone, applied only where workbotTeamSettings is on", async () => {
  const switchOwner = await den.signUp("Workbot Switch Owner")
  const org = await den.createOrg(switchOwner, "Workbot switch org")
  const ctx = await contextFor(org.orgId, org.owner)
  const [before] = await workbotSettingsArea.exportItems(ctx)
  assert.ok(before)
  assert.equal(before.spec.enabled, true, "absent is on")
  const turnOff = (previous: ConfigItem) => workbotSettingsArea.apply(ctx, {
    kind: "update", targetId: org.orgId, previous, item: { name: previous.name, spec: { ...previous.spec, enabled: false } }, changes: [{ path: "enabled" }], secretPaths: [],
  })

  const off = await turnOff(before)
  assert.deepEqual(off.steps, [])
  assert.match(off.warnings?.join(" ") ?? "", /per team aren't on/)
  assert.equal((await workbotSettingsArea.exportItems(ctx))[0]?.spec.enabled, true)

  await enable(org.orgId, "workbotTeamSettings")
  assert.deepEqual((await turnOff(before)).steps, [{ action: "set", target: "enabled", detail: "off" }])
  const [after] = await workbotSettingsArea.exportItems(ctx)
  assert.deepEqual(after?.spec, { ...before.spec, enabled: false })
  const view = await ok(den.as(switchOwner, org.orgId)("GET", path), "view")
  assert.equal(JSON.stringify(view.body).includes("\"enabled\":false"), true)
  assert.ok(after)
  assert.deepEqual((await turnOff(after)).steps, [], "unchanged writes nothing")
})
