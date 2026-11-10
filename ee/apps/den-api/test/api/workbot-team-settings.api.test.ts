/**
 * Workbot settings per team (workbotTeamSettings): GET /v1/org/workbot-settings/teams and
 * PUT /v1/org/workbot-settings/teams/:teamId, and what GET /v1/workbot/session then tells each member.
 * - off: the routes answer 404 feature_disabled and a saved team row is ignored;
 * - on: admins save, read and remove a team's model and name; members of that team get them, members of two
 *   teams that differ get the organization's, and deleting the team removes its row.
 * Workbot on or off (PUT /v1/org/workbot-settings/everyone and a team's `enabled`): a member whose Workbot is off
 * gets `enabled: false` from the session and a refusal from every other /v1/workbot route, from My agent and from
 * their agent's checks; admins keep their settings routes.
 * A team's step limit (`maxSteps`) needs workbotStepLimit as well: without it the write is refused, the view omits
 * it, and the session clears a limit a team gave the member.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable, WorkbotTeamSettingTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary, type Call, type Member } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

// Workbot's models are each caller's own AI Gateway assignments; only the public model catalog is synthetic.
const restoreFetch = stubPublicModelCatalog()
// DEN_WORKBOT_URL: Workbot is deployed here, so members' agents (My agent, their checks) can be on at all.
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_DEPLOYMENT: "self_hosted", DEN_FEATURE_WORKBOT: "false", DEN_FEATURE_WORKBOT_LUNA_DEFAULT: "false", DEN_WORKBOT_URL: "http://localhost:3020" } })
after(async () => { restoreFetch(); await den.close() })

const feature = "workbotTeamSettings"
const path = "/v1/org/workbot-settings/teams"
const everyone = "/v1/org/workbot-settings/everyone"
const inherit = { inherit: true }
const own = (value: string | number | null) => ({ inherit: false, value })

/** An organization whose default Workbot model is one of two Gateway models its owner can choose. */
async function workspace(label: string) {
  const { orgId, owner } = await den.createOrg(await den.signUp(`${label} Owner`), `${label} workspace`)
  const { "gpt-6-luna": luna, "gpt-fixture-other": other } = await grantGatewayModels(den, owner, orgId, [owner], ["gpt-6-luna", "gpt-fixture-other"])
  const call = den.as(owner, orgId)
  const saved = await call("PUT", "/v1/org/workbot-settings", { model: luna })
  assert.equal(saved.status, 200, summary(saved))
  return { orgId, owner, call, luna, other }
}

async function setFeature(orgId: string, enabled: boolean) {
  const changed = await den.setFeature(orgId, feature, enabled)
  assert.equal(changed.status, 200, summary(changed))
}

/** What Workbot is told about one member: their model and the name it goes by. */
async function workbotSession(member: Member, orgId: string) {
  const result = await den.request(await den.mintMcpToken(member, orgId), "GET", "/v1/workbot/session")
  assert.equal(result.status, 200, summary(result))
  return { model: field(result.body, "model"), name: field(result.body, "organization", "brandAppName") }
}

function team(view: Call, teamId: string) {
  assert.equal(view.status, 200, summary(view))
  const entry = list(field(view.body, "teams")).find((candidate) => candidate.teamId === teamId)
  assert.ok(entry, `team ${teamId} is listed`)
  return entry
}

async function storedRows(teamId: string) {
  const { db } = await import("../../src/db.js")
  return db.$primary.select({ id: WorkbotTeamSettingTable.id }).from(WorkbotTeamSettingTable).where(eq(WorkbotTeamSettingTable.teamId, normalizeDenTypeId("team", teamId)))
}

test("with the feature off the routes answer feature_disabled and a saved team row is ignored", { timeout: 120_000 }, async () => {
  const { orgId, owner, call, luna, other } = await workspace("Off")
  const ada = await den.newMember(owner, orgId, "Off Ada")
  const research = await den.createTeam(owner, orgId, "Research", [ada.memberId])
  const { organizationCloudModelSelection } = await import("../../src/workbot/model.js")

  for (const refused of [await call("GET", path), await call("PUT", `${path}/${research}`, { name: own("Scout") }), await call("PUT", everyone, { enabled: false })]) {
    assert.equal(refused.status, 404, summary(refused))
    assert.deepEqual(refused.body, { error: "feature_disabled", feature })
  }
  assert.deepEqual(await storedRows(research), [])
  assert.deepEqual(await workbotSession(ada, orgId), { model: luna, name: null })

  await setFeature(orgId, true)
  const saved = await call("PUT", `${path}/${research}`, { model: own(other), name: own("Scout") })
  assert.equal(saved.status, 200, summary(saved))
  assert.deepEqual(await workbotSession(ada, orgId), { model: other, name: "Scout" })
  assert.equal(await organizationCloudModelSelection({ organizationId: orgId, userId: ada.userId }), other)

  // Off again: the row stays, nobody reads it, and the member is back on the organization's values.
  await setFeature(orgId, false)
  assert.equal((await call("GET", path)).status, 404)
  assert.equal((await storedRows(research)).length, 1)
  assert.deepEqual(await workbotSession(ada, orgId), { model: luna, name: null })
  assert.equal(await organizationCloudModelSelection({ organizationId: orgId, userId: ada.userId }), luna)

  await setFeature(orgId, true)
  assert.deepEqual(await workbotSession(ada, orgId), { model: other, name: "Scout" })
})

test("admins save, read and remove a team's settings; other members and other organizations are refused", { timeout: 120_000 }, async () => {
  const { orgId, owner, call, luna, other } = await workspace("Admin")
  const elsewhere = await workspace("Elsewhere")
  await setFeature(orgId, true)
  const viewer = await den.newMember(owner, orgId, "Admin Viewer")
  const plain = await den.newMember(owner, orgId, "Admin Plain")
  const research = await den.createTeam(owner, orgId, "Research", [plain.memberId])
  const viewers = await den.createTeam(owner, orgId, "Viewers", [viewer.memberId])
  const granted = await call("POST", "/v1/permissions/sets", { teamId: viewers, permissions: [{ key: "inference.view", status: "allow" }] })
  assert.equal(granted.status, 201, summary(granted))

  const initial = await call("GET", path)
  assert.equal(initial.status, 200, summary(initial))
  assert.equal(initial.headers.get("cache-control"), "no-store")
  assert.deepEqual(field(initial.body, "organization"), { model: luna, name: null, enabled: true })
  assert.equal(field(initial.body, "canEdit"), true)
  assert.deepEqual(list(field(initial.body, "teams")).map((entry) => entry.teamName), ["Research", "Viewers"])
  assert.deepEqual(team(initial, research), { teamId: research, teamName: "Research", memberCount: 1, model: inherit, name: inherit, enabled: inherit, conflictingMemberCount: 0 })

  // Each setting is saved on its own; one left out is kept.
  const named = await call("PUT", `${path}/${research}`, { name: own(" Scout ") })
  assert.deepEqual([team(named, research).model, team(named, research).name], [inherit, own("Scout")])
  const modelled = await call("PUT", `${path}/${research}`, { model: own(other) })
  assert.equal(modelled.headers.get("cache-control"), "no-store")
  assert.deepEqual([team(modelled, research).model, team(modelled, research).name], [own(other), own("Scout")])
  assert.deepEqual(team(await call("GET", path), research).model, own(other))
  // The deployment's default model is a choice of its own, not "use the organization's".
  const deploymentDefault = await call("PUT", `${path}/${research}`, { model: own(null), name: inherit })
  assert.deepEqual([team(deploymentDefault, research).model, team(deploymentDefault, research).name], [own(null), inherit])
  assert.equal((await storedRows(research)).length, 1)
  // Nothing left of its own: the team has no row.
  const cleared = await call("PUT", `${path}/${research}`, { model: inherit })
  assert.deepEqual([team(cleared, research).model, team(cleared, research).name], [inherit, inherit])
  assert.deepEqual(await storedRows(research), [])

  // Only the caller's own models are accepted, exactly as for the organization's default.
  for (const model of ["made-up-model", elsewhere.other]) {
    const unknown = await call("PUT", `${path}/${research}`, { model: own(model) })
    assert.equal(unknown.status, 400, summary(unknown))
    assert.equal(field(unknown.body, "error"), "unknown_model")
  }
  for (const body of [{ name: own("") }, { name: own("x".repeat(41)) }, { model: { inherit: true, value: other } }, { name: "Scout" }, { other: inherit }]) {
    const invalid = await call("PUT", `${path}/${research}`, body)
    assert.equal(invalid.status, 400, `${JSON.stringify(body)}: ${summary(invalid)}`)
  }
  assert.deepEqual(await storedRows(research), [])

  // The team must be one of this organization's.
  const elsewhereTeam = await den.createTeam(elsewhere.owner, elsewhere.orgId, "Elsewhere team", [])
  for (const teamId of [createDenTypeId("team"), elsewhereTeam]) {
    const missing = await call("PUT", `${path}/${teamId}`, { name: own("Scout") })
    assert.equal(missing.status, 404, summary(missing))
    assert.equal(field(missing.body, "error"), "team_not_found")
  }
  assert.deepEqual(await storedRows(elsewhereTeam), [])

  // View OpenWork Models settings reads; only Manage OpenWork Models writes; other members get nothing.
  await call("PUT", `${path}/${research}`, { name: own("Scout") })
  const asViewer = den.as(viewer, orgId)
  const viewed = await asViewer("GET", path)
  assert.equal(viewed.status, 200, summary(viewed))
  assert.equal(field(viewed.body, "canEdit"), false)
  assert.deepEqual(team(viewed, research).name, own("Scout"))
  for (const refused of [
    await asViewer("PUT", `${path}/${research}`, { name: own("Mine") }),
    await den.as(plain, orgId)("GET", path),
    await den.as(plain, orgId)("PUT", `${path}/${research}`, { name: own("Mine") }),
  ]) {
    assert.equal(refused.status, 403, summary(refused))
    assert.equal(refused.text.includes("Scout"), false)
  }
  for (const refused of [await den.as(elsewhere.owner, orgId)("GET", path), await den.as(elsewhere.owner, orgId)("PUT", `${path}/${research}`, { name: own("Mine") })]) {
    assert.equal(refused.status, 404, summary(refused))
    assert.equal(refused.text.includes("Scout"), false)
  }
  assert.equal((await den.request(null, "GET", path, { orgId })).status, 401)
  assert.deepEqual(team(await call("GET", path), research).name, own("Scout"))
})

test("a member gets their team's model and name, two teams that differ give the organization's, and a deleted team's row goes", { timeout: 120_000 }, async () => {
  const { orgId, owner, call, luna, other } = await workspace("Members")
  await setFeature(orgId, true)
  const ada = await den.newMember(owner, orgId, "Members Ada")
  const ben = await den.newMember(owner, orgId, "Members Ben")
  const cal = await den.newMember(owner, orgId, "Members Cal")
  const research = await den.createTeam(owner, orgId, "Research", [ada.memberId, ben.memberId])
  const design = await den.createTeam(owner, orgId, "Design", [ben.memberId])
  const { organizationCloudModelSelection } = await import("../../src/workbot/model.js")
  const selection = (member: Member) => organizationCloudModelSelection({ organizationId: orgId, userId: member.userId })

  assert.equal((await call("PUT", `${path}/${research}`, { model: own(other), name: own("Scout") })).status, 200)
  const saved = await call("PUT", `${path}/${design}`, { model: own(null), name: own("Helper") })
  // Ben is on both teams and they differ on the model and on the name.
  assert.equal(team(saved, research).conflictingMemberCount, 1)
  assert.equal(team(saved, design).conflictingMemberCount, 1)
  assert.equal(team(saved, research).memberCount, 2)

  assert.deepEqual(await workbotSession(ada, orgId), { model: other, name: "Scout" })
  assert.deepEqual(await workbotSession(ben, orgId), { model: luna, name: null })
  assert.deepEqual(await workbotSession(cal, orgId), { model: luna, name: null })
  // The Slack assistant, Automations and resumed turns select the same model for each member.
  assert.equal(await selection(ada), other)
  assert.equal(await selection(ben), luna)
  assert.equal(await selection(cal), luna)

  // Teams that agree on one setting and differ on the other: only the one they differ on goes back.
  assert.equal((await call("PUT", `${path}/${design}`, { model: own(other) })).status, 200)
  assert.deepEqual(await workbotSession(ben, orgId), { model: other, name: null })
  assert.equal((await call("PUT", `${path}/${design}`, { model: own(null) })).status, 200)

  const deleted = await call("DELETE", `/v1/teams/${design}`)
  assert.ok(deleted.status < 300, summary(deleted))
  assert.deepEqual(await storedRows(design), [])
  assert.equal((await storedRows(research)).length, 1)
  assert.deepEqual(await workbotSession(ben, orgId), { model: other, name: "Scout" })
  const after = await call("GET", path)
  assert.deepEqual(list(field(after.body, "teams")).map((entry) => entry.teamName), ["Research"])
  assert.equal(team(after, research).conflictingMemberCount, 0)
})

test("a team's step limit needs the step limit feature too; its members get it, a conflict gives the organization's", { timeout: 180_000 }, async () => {
  const { orgId, owner, call, luna } = await workspace("Steps")
  await setFeature(orgId, true)
  const ada = await den.newMember(owner, orgId, "Steps Ada")
  const ben = await den.newMember(owner, orgId, "Steps Ben")
  const cal = await den.newMember(owner, orgId, "Steps Cal")
  const short = await den.createTeam(owner, orgId, "Short", [ada.memberId, ben.memberId])
  const long = await den.createTeam(owner, orgId, "Long", [ben.memberId])
  const setStepLimitFeature = async (enabled: boolean) => {
    const changed = await den.setFeature(orgId, "workbotStepLimit", enabled)
    assert.equal(changed.status, 200, summary(changed))
  }
  const setEveryones = async (maxSteps: number | null) => {
    const saved = await call("PUT", "/v1/org/workbot-settings", { maxSteps })
    assert.equal(saved.status, 200, summary(saved))
  }
  /** What Workbot is told about one member's step limit; undefined when it is told nothing. */
  const stepLimit = async (member: Member) => {
    const result = await den.request(await den.mintMcpToken(member, orgId), "GET", "/v1/workbot/session")
    assert.equal(result.status, 200, summary(result))
    return field(result.body, "maxSteps")
  }

  // The step limit feature off: the write is refused whole, and the view has no step limit.
  for (const body of [{ maxSteps: own(100) }, { maxSteps: inherit }, { name: own("Scout"), maxSteps: own(100) }]) {
    const refused = await call("PUT", `${path}/${short}`, body)
    assert.equal(refused.status, 400, `${JSON.stringify(body)}: ${summary(refused)}`)
    assert.deepEqual(refused.body, { error: "invalid_request", message: "Workbot's step limit isn't on for this organization.", details: [] })
  }
  assert.deepEqual(await storedRows(short), [])
  const without = await call("GET", path)
  assert.deepEqual(field(without.body, "organization"), { model: luna, name: null, enabled: true })
  assert.deepEqual(team(without, short), { teamId: short, teamName: "Short", memberCount: 2, model: inherit, name: inherit, enabled: inherit, conflictingMemberCount: 0 })
  assert.equal(await stepLimit(ada), undefined)

  // Both features on: the view carries the organization's limit and each team's.
  await setStepLimitFeature(true)
  await setEveryones(500)
  const initial = await call("GET", path)
  assert.deepEqual(field(initial.body, "organization"), { model: luna, name: null, enabled: true, maxSteps: 500 })
  assert.deepEqual(team(initial, short).maxSteps, inherit)
  assert.deepEqual([await stepLimit(ada), await stepLimit(cal)], [500, 500])

  const saved = await call("PUT", `${path}/${short}`, { maxSteps: own(100) })
  assert.deepEqual(team(saved, short), { teamId: short, teamName: "Short", memberCount: 2, model: inherit, name: inherit, enabled: inherit, maxSteps: own(100), conflictingMemberCount: 0 })
  assert.deepEqual(team(saved, long).maxSteps, inherit)
  // Ben's other team follows the organization, so Short's limit is his too.
  assert.deepEqual([await stepLimit(ada), await stepLimit(ben), await stepLimit(cal)], [100, 100, 500])

  // Ben's teams differ: he gets the organization's. No limit is a value of its own.
  const differing = await call("PUT", `${path}/${long}`, { maxSteps: own(0) })
  assert.deepEqual(team(differing, long).maxSteps, own(0))
  assert.deepEqual([team(differing, short).conflictingMemberCount, team(differing, long).conflictingMemberCount], [1, 1])
  assert.deepEqual([await stepLimit(ada), await stepLimit(ben)], [100, 500])
  const agreeing = await call("PUT", `${path}/${long}`, { maxSteps: own(100) })
  assert.equal(team(agreeing, short).conflictingMemberCount, 0)
  assert.equal(await stepLimit(ben), 100)
  // The deployment's default is a team's choice too, not "use the organization's".
  assert.equal((await call("PUT", `${path}/${long}`, { maxSteps: inherit })).status, 200)
  assert.deepEqual(team(await call("PUT", `${path}/${short}`, { maxSteps: own(null) }), short).maxSteps, own(null))
  assert.deepEqual([await stepLimit(ada), await stepLimit(cal)], [null, 500])

  for (const body of [{ maxSteps: 250 }, { maxSteps: own(-1) }, { maxSteps: own(2.5) }, { maxSteps: own(100_001) }, { maxSteps: own("250") }, { maxSteps: { inherit: true, value: 250 } }]) {
    const invalid = await call("PUT", `${path}/${short}`, body)
    assert.equal(invalid.status, 400, `${JSON.stringify(body)}: ${summary(invalid)}`)
  }

  // "Use the organization's" removes the team's limit, and with it the team's row.
  const cleared = await call("PUT", `${path}/${short}`, { maxSteps: inherit })
  assert.deepEqual(team(cleared, short).maxSteps, inherit)
  assert.deepEqual(await storedRows(short), [])
  assert.equal(await stepLimit(ada), 500)

  // The step limit feature off with only team limits saved: kept, hidden, not counted, and cleared for the
  // members a team gave one to. A member no limit reached is told nothing.
  await setEveryones(null)
  assert.equal((await call("PUT", `${path}/${short}`, { maxSteps: own(100) })).status, 200)
  assert.equal((await call("PUT", `${path}/${long}`, { maxSteps: own(0) })).status, 200)
  await setStepLimitFeature(false)
  assert.deepEqual([await stepLimit(ada), await stepLimit(cal)], [null, undefined])
  const hidden = await call("PUT", `${path}/${short}`, { name: own("Scout") })
  assert.deepEqual(field(hidden.body, "organization"), { model: luna, name: null, enabled: true })
  assert.deepEqual(team(hidden, short), { teamId: short, teamName: "Short", memberCount: 2, model: inherit, name: own("Scout"), enabled: inherit, conflictingMemberCount: 0 })
  assert.equal(team(hidden, long).conflictingMemberCount, 0)
  assert.equal((await storedRows(long)).length, 1)

  // On again: the saved team limits are back, also after a save of another setting.
  await setStepLimitFeature(true)
  const back = await call("GET", path)
  assert.deepEqual([team(back, short).maxSteps, team(back, long).maxSteps], [own(100), own(0)])
  assert.equal(team(back, short).conflictingMemberCount, 1)
  assert.deepEqual([await stepLimit(ada), await stepLimit(ben), await stepLimit(cal)], [100, null, null])

  // Team settings off: everyone has the organization's limit and no team is read.
  await setEveryones(250)
  await setFeature(orgId, false)
  assert.deepEqual([await stepLimit(ada), await stepLimit(ben), await stepLimit(cal)], [250, 250, 250])
})

/** Every member-facing Workbot route but the session, with what it answers a member whose Workbot is off. */
const memberRoutes: { method: "GET" | "POST"; path: string; body?: unknown; status: number; error: string }[] = [
  { method: "GET", path: "/v1/workbot/model-recovery", status: 403, error: "workbot_not_enabled" },
  { method: "GET", path: "/v1/workbot/activation", status: 403, error: "workbot_not_enabled" },
  { method: "POST", path: "/v1/workbot/activation/events", body: { step: "dismiss" }, status: 403, error: "workbot_not_enabled" },
  { method: "GET", path: "/v1/workbot/connections", status: 403, error: "workbot_not_enabled" },
  { method: "POST", path: "/v1/workbot/connections/google-workspace/connect/start", body: { returnPath: "/", requestId: "3f0c0d6e-6c55-4d0a-9a53-0d9b3c1f2a11" }, status: 404, error: "feature_disabled" },
  { method: "GET", path: "/v1/workbot/calendar/v1/automations", status: 403, error: "workbot_calendar_not_enabled" },
  { method: "POST", path: "/v1/workbot/calendar/v1/cloud-automations", body: {}, status: 403, error: "workbot_calendar_not_enabled" },
  { method: "GET", path: "/v1/workbot/documents/v1/capabilities/google-workspace/drive-files", status: 403, error: "workbot_documents_not_enabled" },
  { method: "POST", path: "/v1/workbot/run-token", body: {}, status: 403, error: "workbot_not_enabled" },
]

/** What Workbot is told about whether it is on for one member, and what its other routes answer them. */
async function workbotAccess(member: Member, orgId: string) {
  const token = await den.mintMcpToken(member, orgId)
  const session = await den.request(token, "GET", "/v1/workbot/session")
  assert.equal(session.status, 200, summary(session))
  const refusals: string[] = []
  for (const route of memberRoutes) {
    const result = await den.request(token, route.method, route.path, route.body === undefined ? {} : { body: route.body })
    if (result.status === route.status && field(result.body, "error") === route.error) refusals.push(`${route.method} ${route.path}`)
  }
  return { enabled: field(session.body, "enabled"), calendar: field(session.body, "calendar"), sideChats: field(session.body, "sideChats"), refusals }
}
const on = { enabled: true, calendar: true, sideChats: true, refusals: [] }
const off = { enabled: false, calendar: false, sideChats: false, refusals: memberRoutes.map((route) => `${route.method} ${route.path}`) }

/** A workspace with the feature on. Documents is on too, so its route's refusal can only be Workbot being off. */
async function switchWorkspace(label: string) {
  const created = await workspace(label)
  await setFeature(created.orgId, true)
  assert.equal((await den.setFeature(created.orgId, "workbotDocuments", true)).status, 200)
  return created
}

async function readiness(member: Member, orgId: string) {
  const result = await den.as(member, orgId)("GET", "/v1/org/workbot-readiness")
  assert.equal(result.status, 200, summary(result))
  return field(result.body, "enabled")
}

test("Workbot off for everyone: the session says so, member routes are refused, and admins keep their settings", { timeout: 180_000 }, async () => {
  const { orgId, owner, call, luna } = await switchWorkspace("Switch")
  const elsewhere = await workspace("Switch elsewhere")
  const ada = await den.newMember(owner, orgId, "Switch Ada")
  const viewer = await den.newMember(owner, orgId, "Switch Viewer")
  const viewers = await den.createTeam(owner, orgId, "Viewers", [viewer.memberId])
  assert.equal((await call("POST", "/v1/permissions/sets", { teamId: viewers, permissions: [{ key: "inference.view", status: "allow" }] })).status, 201)

  // Nothing saved: Workbot is on for everyone and the readiness answer has no new field.
  assert.deepEqual(await workbotAccess(ada, orgId), on)
  assert.equal(await readiness(ada, orgId), undefined)

  // Only Manage OpenWork Models turns it off; nobody else and no other organization can.
  for (const [refused, status] of [
    [await den.as(viewer, orgId)("PUT", everyone, { enabled: false }), 403],
    [await den.as(ada, orgId)("PUT", everyone, { enabled: false }), 403],
    [await den.as(elsewhere.owner, orgId)("PUT", everyone, { enabled: false }), 404],
    [await den.request(null, "PUT", everyone, { orgId, body: { enabled: false } }), 401],
  ] as const) assert.equal(refused.status, status, summary(refused))
  for (const body of [{ enabled: "off" }, { enabled: null }, { enabled: inherit }, { enabled: false, model: null }]) {
    const invalid = await call("PUT", everyone, body)
    assert.equal(invalid.status, 400, `${JSON.stringify(body)}: ${summary(invalid)}`)
  }
  assert.deepEqual(await workbotAccess(ada, orgId), on)

  const saved = await call("PUT", everyone, { enabled: false })
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(saved.headers.get("cache-control"), "no-store")
  assert.deepEqual(field(saved.body, "organization"), { model: luna, name: null, enabled: false })
  assert.equal(field(saved.body, "canEdit"), true)
  assert.deepEqual(team(saved, viewers).enabled, inherit)
  // A change that names no setting keeps what is saved.
  assert.equal(field((await call("PUT", everyone, {})).body, "organization", "enabled"), false)

  assert.deepEqual(await workbotAccess(ada, orgId), off)
  assert.equal(await readiness(ada, orgId), false)
  // The owner lost Workbot too, and can still read and change the settings that bring it back.
  assert.deepEqual(await workbotAccess(owner, orgId), off)
  assert.equal(field((await call("GET", path)).body, "organization", "enabled"), false)
  assert.equal((await call("GET", "/v1/org/workbot-settings")).status, 200)
  assert.equal((await call("PUT", `${path}/${viewers}`, { name: own("Scout") })).status, 200)

  // The feature off: the saved switch is kept but ignored, and everyone has Workbot again.
  await setFeature(orgId, false)
  assert.deepEqual(await workbotAccess(ada, orgId), on)
  assert.equal(await readiness(ada, orgId), undefined)
  const { db } = await import("../../src/db.js")
  const [stored] = await db.$primary.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, normalizeDenTypeId("organization", orgId)))
  assert.equal(field(stored?.metadata, "workbot", "enabled"), false)
  assert.equal(field(stored?.metadata, "workbot", "model"), luna, "the default model is kept")
  await setFeature(orgId, true)
  assert.deepEqual(await workbotAccess(ada, orgId), off)

  // On again removes the key, so the organization is as it was before.
  const back = await call("PUT", everyone, { enabled: true })
  assert.equal(field(back.body, "organization", "enabled"), true)
  const [restored] = await db.$primary.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, normalizeDenTypeId("organization", orgId)))
  assert.equal(field(restored?.metadata, "workbot", "enabled"), undefined)
  assert.deepEqual(await workbotAccess(ada, orgId), on)
  assert.deepEqual(await workbotAccess(owner, orgId), on)
})

test("a team turns Workbot on or off for its members; two teams that differ give the organization's", { timeout: 180_000 }, async () => {
  const { orgId, owner, call } = await switchWorkspace("Teams switch")
  const ada = await den.newMember(owner, orgId, "Teams Ada")
  const ben = await den.newMember(owner, orgId, "Teams Ben")
  const cal = await den.newMember(owner, orgId, "Teams Cal")
  const pilot = await den.createTeam(owner, orgId, "Pilot", [ada.memberId, ben.memberId])
  const paused = await den.createTeam(owner, orgId, "Paused", [ben.memberId])

  // The organization is off and one team is on: only that team's members have Workbot.
  assert.equal((await call("PUT", everyone, { enabled: false })).status, 200)
  const piloted = await call("PUT", `${path}/${pilot}`, { enabled: { inherit: false, value: true } })
  assert.deepEqual(team(piloted, pilot).enabled, { inherit: false, value: true })
  assert.deepEqual(team(piloted, pilot).model, inherit, "the switch is saved on its own")
  assert.deepEqual(await workbotAccess(ada, orgId), on)
  assert.deepEqual(await workbotAccess(ben, orgId), on)
  assert.deepEqual(await workbotAccess(cal, orgId), off)
  assert.deepEqual([await readiness(ada, orgId), await readiness(cal, orgId)], [undefined, false])

  // Ben's teams differ: he gets the organization's value, whichever it is.
  const differing = await call("PUT", `${path}/${paused}`, { enabled: { inherit: false, value: false } })
  assert.equal(team(differing, pilot).conflictingMemberCount, 1)
  assert.equal(team(differing, paused).conflictingMemberCount, 1)
  assert.deepEqual(await workbotAccess(ben, orgId), off)
  assert.equal((await call("PUT", everyone, { enabled: true })).status, 200)
  assert.deepEqual(await workbotAccess(ben, orgId), on)
  assert.deepEqual(await workbotAccess(ada, orgId), on)
  assert.deepEqual(await workbotAccess(cal, orgId), on)

  // The organization is on and one team is off: only that team's members lose Workbot.
  assert.equal((await call("PUT", `${path}/${pilot}`, { enabled: inherit })).status, 200)
  assert.deepEqual(await storedRows(pilot), [])
  assert.deepEqual(await workbotAccess(ben, orgId), off)
  assert.deepEqual(await workbotAccess(ada, orgId), on)

  // Your agent follows Workbot: no page, no extra check and no wake for a member whose Workbot is off.
  assert.equal((await den.setFeature(orgId, "workbotProactive", true)).status, 200)
  const { proactiveAllowed } = await import("../../src/workbot-proactive/access.js")
  const { requestAgentCheck } = await import("../../src/mcp/agent-check-request.js")
  const mine = (member: Member) => den.as(member, orgId)("GET", "/v1/me/agent")
  assert.equal((await mine(ada)).status, 200)
  for (const route of [await mine(ben), await den.as(ben, orgId)("GET", "/v1/me/agent/checks"), await den.as(ben, orgId)("PUT", "/v1/me/agent", { on: true })]) {
    assert.equal(route.status, 404, summary(route))
    assert.deepEqual(route.body, { error: "feature_disabled", feature: "workbot" })
  }
  // The worker asks this before each wake and again before each message.
  assert.equal(await proactiveAllowed(orgId, ada.userId), true)
  assert.equal(await proactiveAllowed(orgId, ben.userId), false)
  assert.equal(await proactiveAllowed(orgId), true, "the organization still has agents")
  const refused = await requestAgentCheck({
    organizationId: normalizeDenTypeId("organization", orgId), memberId: normalizeDenTypeId("member", ben.memberId), userId: normalizeDenTypeId("user", ben.userId),
    at: "13:45", why: "before the 2 PM",
  })
  assert.deepEqual(refused, { ok: false, text: "Extra checks aren't on for this member." })

  // With the feature off nobody loses their agent to a saved switch.
  await setFeature(orgId, false)
  assert.equal(await proactiveAllowed(orgId, ben.userId), true)
  assert.equal((await mine(ben)).status, 200)
  assert.deepEqual(await workbotAccess(ben, orgId), on)
})
