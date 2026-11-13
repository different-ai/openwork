/**
 * Workbot settings per team (workbotTeamSettings): GET /v1/org/workbot-settings/teams and
 * PUT /v1/org/workbot-settings/teams/:teamId, and what GET /v1/workbot/session then tells each member.
 * - off: the routes answer 404 feature_disabled and a saved team row is ignored;
 * - on: admins save, read and remove a team's model and name; members of that team get them, members of two
 *   teams that differ get the organization's, and deleting the team removes its row.
 * Workbot on or off (PUT /v1/org/workbot-settings/everyone and a team's `enabled`): a member whose Workbot is off
 * gets `enabled: false` from the session and a refusal from every other /v1/workbot route, from My agent and from
 * their agent's checks; admins keep their settings routes.
 * A step limit is no longer a setting: a write that carries one is refused, and a limit saved before (for the
 * organization or in a team's row) is shown nowhere, reaches no member and is dropped on the team's next change.
 * A team's own policy for its members' agents (GET / PUT /v1/org/workbot-settings/teams/:teamId/agent) needs
 * workbotProactive as well: a team follows Everyone's until its first save copies it, its members' agents then
 * follow the team's (My agent, discovery and each wake), and `agent: { inherit: true }` removes it.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable, WorkbotTeamSettingTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { DEFAULT_AGENT_TEMPLATE, DEFAULT_WORKBOT_PROACTIVE_SETTINGS } from "@openwork/types/den/workbot-proactive"
import { bootDen, field, isRecord, list, startFakeMcpServer, summary, text, type Call, type Member } from "./harness.js"
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


test("admins save, read and remove a team's settings; other members and other organizations are refused", { timeout: 120_000 }, async () => {
  const { orgId, owner, call, luna, other } = await workspace("Admin")
  const elsewhere = await workspace("Elsewhere")
  const viewer = await den.newMember(owner, orgId, "Admin Viewer")
  const plain = await den.newMember(owner, orgId, "Admin Plain")
  const research = await den.createTeam(owner, orgId, "Research", [plain.memberId])
  const viewers = await den.createTeam(owner, orgId, "Viewers", [viewer.memberId])
  const granted = await call("POST", "/v1/permissions/sets", { teamId: viewers, permissions: [{ key: "inference.view", status: "allow" }] })
  assert.equal(granted.status, 201, summary(granted))

  const initial = await call("GET", path)
  assert.equal(initial.status, 200, summary(initial))
  assert.equal(initial.headers.get("cache-control"), "no-store")
  assert.deepEqual(field(initial.body, "organization"), { model: luna, name: null, enabled: true, agentEnabled: false, agentCalendar: "everyone" })
  assert.equal(field(initial.body, "canEdit"), true)
  assert.deepEqual(list(field(initial.body, "teams")).map((entry) => entry.teamName), ["Research", "Viewers"])
  assert.deepEqual(team(initial, research), { teamId: research, teamName: "Research", memberCount: 1, model: inherit, name: inherit, enabled: inherit, agent: { inherit: true, enabled: false, calendar: "everyone" }, conflictingMemberCount: 0 })

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

test("a step limit is not a setting any more: a write with one is refused, and one saved before is shown nowhere and reaches no member", { timeout: 180_000 }, async () => {
  const { orgId, owner, call, luna } = await workspace("Steps")
  const ada = await den.newMember(owner, orgId, "Steps Ada")
  const ben = await den.newMember(owner, orgId, "Steps Ben")
  const short = await den.createTeam(owner, orgId, "Short", [ada.memberId, ben.memberId])
  const long = await den.createTeam(owner, orgId, "Long", [ben.memberId])
  /** What Workbot is told about one member's step limit; undefined when it is told nothing. */
  const stepLimit = async (member: Member) => {
    const result = await den.request(await den.mintMcpToken(member, orgId), "GET", "/v1/workbot/session")
    assert.equal(result.status, 200, summary(result))
    return field(result.body, "maxSteps")
  }

  // The write is refused whole: nothing else in it is saved either.
  for (const body of [{ maxSteps: own(100) }, { maxSteps: inherit }, { maxSteps: 250 }, { name: own("Scout"), maxSteps: own(100) }]) {
    const refused = await call("PUT", `${path}/${short}`, body)
    assert.equal(refused.status, 400, `${JSON.stringify(body)}: ${summary(refused)}`)
  }
  assert.deepEqual(await storedRows(short), [])

  // Limits saved while Workbot had a step limit: 500 for the organization, 100 for Short and none for Long.
  assert.equal((await call("PUT", `${path}/${short}`, { name: own("Scout") })).status, 200)
  const { db } = await import("../../src/db.js")
  const organizationId = normalizeDenTypeId("organization", orgId)
  const [organization] = await db.$primary.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
  const metadata = isRecord(organization?.metadata) ? organization.metadata : {}
  await db.update(OrganizationTable).set({ metadata: { ...metadata, workbot: { ...(isRecord(metadata.workbot) ? metadata.workbot : {}), maxSteps: 500 } } }).where(eq(OrganizationTable.id, organizationId))
  await db.update(WorkbotTeamSettingTable).set({ settings: { name: "Scout", maxSteps: 100 } }).where(eq(WorkbotTeamSettingTable.teamId, normalizeDenTypeId("team", short)))
  await db.insert(WorkbotTeamSettingTable).values({ id: createDenTypeId("workbotTeamSetting"), organizationId, teamId: normalizeDenTypeId("team", long), settings: { maxSteps: 0 } })

  // Shown nowhere, no conflict for Ben (on both teams), and told to no member.
  const view = await call("GET", path)
  assert.deepEqual(field(view.body, "organization"), { model: luna, name: null, enabled: true, agentEnabled: false, agentCalendar: "everyone" })
  assert.deepEqual(team(view, short), { teamId: short, teamName: "Short", memberCount: 2, model: inherit, name: own("Scout"), enabled: inherit, agent: { inherit: true, enabled: false, calendar: "everyone" }, conflictingMemberCount: 0 })
  assert.deepEqual(team(view, long), { teamId: long, teamName: "Long", memberCount: 1, model: inherit, name: inherit, enabled: inherit, agent: { inherit: true, enabled: false, calendar: "everyone" }, conflictingMemberCount: 0 })
  assert.equal(field(await call("GET", "/v1/org/workbot-settings").then((read) => read.body), "maxSteps"), undefined)
  assert.deepEqual([await stepLimit(ada), await stepLimit(ben)], [undefined, undefined])
  assert.deepEqual(await workbotSession(ada, orgId), { model: luna, name: "Scout" })

  // The team's next change drops the retired key from its row; a row left with nothing goes.
  assert.equal((await call("PUT", `${path}/${short}`, { enabled: own(true) })).status, 200)
  const [kept] = await db.$primary.select({ settings: WorkbotTeamSettingTable.settings }).from(WorkbotTeamSettingTable).where(eq(WorkbotTeamSettingTable.teamId, normalizeDenTypeId("team", short)))
  assert.deepEqual(kept?.settings, { name: "Scout", enabled: true })
  assert.equal((await call("PUT", `${path}/${long}`, { name: inherit })).status, 200)
  assert.deepEqual(await storedRows(long), [])
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
  assert.deepEqual(field(saved.body, "organization"), { model: luna, name: null, enabled: false, agentEnabled: false, agentCalendar: "everyone" })
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

  const { db } = await import("../../src/db.js")
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


})

// ---- Members' agents per team -------------------------------------------------------------------------------------

const proactive = "/v1/org/workbot-settings/proactive"
const agentOf = (teamId: string) => `${path}/${teamId}/agent`

/** An organization with members' agents available; team settings are turned on by each test. */
async function agentWorkspace(label: string) {
  const { orgId, owner } = await den.createOrg(await den.signUp(`${label} Owner`), `${label} workspace`)

  return { orgId, owner, call: den.as(owner, orgId) }
}

async function storedSettings(teamId: string) {
  const { db } = await import("../../src/db.js")
  const [row] = await db.$primary.select({ settings: WorkbotTeamSettingTable.settings }).from(WorkbotTeamSettingTable).where(eq(WorkbotTeamSettingTable.teamId, normalizeDenTypeId("team", teamId)))
  return row?.settings ?? null
}


test("a team follows Everyone's agent settings until its first save copies them; inherit removes its own", { timeout: 180_000 }, async () => {
  const { orgId, owner, call } = await agentWorkspace("Agent team")
  const research = await den.createTeam(owner, orgId, "Research", [])
  const design = await den.createTeam(owner, orgId, "Design", [])
  const everyones = await call("PUT", proactive, { enabled: true, dailyCap: 5, instructions: "Ignore newsletters." })
  assert.equal(everyones.status, 200, summary(everyones))

  // Following Everyone: the same view as the organization's, marked inherit, so the controls can show its values.
  const following = await call("GET", agentOf(research))
  assert.equal(following.status, 200, summary(following))
  assert.equal(following.headers.get("cache-control"), "no-store")
  assert.equal(field(following.body, "inherit"), true)
  const everyonesView = (await call("GET", proactive)).body
  assert.ok(isRecord(everyonesView))
  assert.deepEqual(following.body, { ...everyonesView, inherit: true })
  assert.deepEqual(await storedRows(research), [])

  // The first save is the override: Everyone's policy and template as they are now, with the change on top.
  const saved = await call("PUT", agentOf(research), { startHour: 10, sources: { calendar: "off" } })
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(saved.headers.get("cache-control"), "no-store")
  assert.equal(field(saved.body, "inherit"), false)
  const expected = { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true, dailyCap: 5, startHour: 10, sources: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS.sources, calendar: "off" } }
  assert.deepEqual(field(saved.body, "settings"), expected)
  assert.equal(field(saved.body, "template", "instructions"), "Ignore newsletters.", "Everyone's template is copied with the policy")
  assert.deepEqual(field(saved.body, "template", "responsibilities"), DEFAULT_AGENT_TEMPLATE.responsibilities)
  assert.equal(field(saved.body, "template", "version"), 1, "the team's own first version")
  const firstVersion = field(saved.body, "template", "versionId")
  assert.equal(typeof firstVersion, "string")
  assert.deepEqual(field(await storedSettings(research), "agent", "settings"), expected, "kept in the team's row")
  const read = await call("GET", agentOf(research))
  assert.deepEqual(read.body, saved.body)

  // From then on the team no longer follows Everyone's changes, and Everyone's is untouched by the team's.
  assert.equal((await call("PUT", proactive, { dailyCap: 2, instructions: "Everyone only." })).status, 200)
  assert.equal(field((await call("GET", agentOf(research))).body, "settings", "dailyCap"), 5)
  assert.equal(field((await call("GET", agentOf(research))).body, "template", "instructions"), "Ignore newsletters.")
  assert.equal(field((await call("GET", proactive)).body, "settings", "startHour"), DEFAULT_WORKBOT_PROACTIVE_SETTINGS.startHour)
  assert.equal(field((await call("GET", agentOf(design))).body, "settings", "dailyCap"), 2, "a team without its own shows Everyone's now")

  // A partial change merges onto the team's own; a policy change keeps the template version, a template change adds one.
  const off = await call("PUT", agentOf(research), { enabled: false })
  assert.deepEqual(field(off.body, "settings"), { ...expected, enabled: false })
  assert.deepEqual([field(off.body, "template", "version"), field(off.body, "template", "versionId")], [1, firstVersion])
  const edited = await call("PUT", agentOf(research), { responsibilities: { meeting_prep: false } })
  assert.equal(field(edited.body, "template", "version"), 2)
  assert.notEqual(field(edited.body, "template", "versionId"), firstVersion)
  assert.equal(field(edited.body, "template", "responsibilities", "meeting_prep"), false)
  assert.equal(field(edited.body, "template", "instructions"), "Ignore newsletters.")
  const { db } = await import("../../src/db.js")
  const { ConfigObjectTable } = await import("@openwork-ee/den-db/schema")
  const objects = await db.$primary.select({ id: ConfigObjectTable.id }).from(ConfigObjectTable).where(eq(ConfigObjectTable.organizationId, normalizeDenTypeId("organization", orgId)))
  assert.equal(objects.length, 1, "only Everyone's Your agent config object; a team's template lives in its row")

  // The list says which teams have their own and whether agents are on under the policy each has now.
  const listed = await call("GET", path)
  assert.equal(field(listed.body, "organization", "agentEnabled"), true)
  // The team's own Calendar choice, next to Everyone's: what the Calendar row's chip compares.
  assert.deepEqual(team(listed, research).agent, { inherit: false, enabled: false, calendar: "off" })
  assert.equal(field(listed.body, "organization", "agentCalendar"), "everyone")
  assert.deepEqual(team(listed, design).agent, { inherit: true, enabled: true, calendar: "everyone" })

  // The team's other settings and its agent policy are saved apart and kept apart.
  assert.equal((await call("PUT", `${path}/${research}`, { name: own("Scout") })).status, 200)
  assert.equal(field((await call("GET", agentOf(research))).body, "inherit"), false)
  const value = await call("PUT", `${path}/${research}`, { agent: { inherit: false, value: { settings: expected } } })
  assert.equal(value.status, 400, `the policy itself is saved through the agent route: ${summary(value)}`)

  // Back to Everyone's: the policy goes, the name stays; with nothing left the row goes too.
  const back = await call("PUT", `${path}/${research}`, { agent: inherit })
  assert.deepEqual(team(back, research).agent, { inherit: true, enabled: true, calendar: "everyone" })
  assert.deepEqual(team(back, research).name, own("Scout"))
  assert.equal(field(await storedSettings(research), "agent"), undefined)
  const again = await call("GET", agentOf(research))
  assert.deepEqual([field(again.body, "inherit"), field(again.body, "settings", "dailyCap"), field(again.body, "template", "instructions")], [true, 2, "Everyone only."])
  assert.equal((await call("PUT", `${path}/${research}`, { name: inherit })).status, 200)
  assert.deepEqual(await storedRows(research), [])
  // A new override starts from Everyone's as it is now, at version 1 again.
  const restarted = await call("PUT", agentOf(research), { leadMinutes: 30 })
  assert.deepEqual([field(restarted.body, "settings", "dailyCap"), field(restarted.body, "settings", "leadMinutes"), field(restarted.body, "template", "version")], [2, 30, 1])

  // Deleting the team removes its policy with its row.
  assert.ok((await call("DELETE", `/v1/teams/${research}`)).status < 300)
  assert.deepEqual(await storedRows(research), [])
})

test("a team's agent change is checked exactly like the organization's, and only admins of this organization reach it", { timeout: 180_000 }, async () => {
  const { orgId, owner, call } = await agentWorkspace("Agent checks")
  const elsewhere = await agentWorkspace("Agent checks elsewhere")
  const viewer = await den.newMember(owner, orgId, "Agent Viewer")
  const plain = await den.newMember(owner, orgId, "Agent Plain")
  const research = await den.createTeam(owner, orgId, "Research", [plain.memberId])
  const viewers = await den.createTeam(owner, orgId, "Viewers", [viewer.memberId])
  assert.equal((await call("POST", "/v1/permissions/sets", { teamId: viewers, permissions: [{ key: "inference.view", status: "allow" }] })).status, 201)
  const elsewhereTeam = await den.createTeam(elsewhere.owner, elsewhere.orgId, "Elsewhere team", [])
  // A connection of another organization: never a source here, for the organization or for a team.
  const service = await startFakeMcpServer({ tools: [{ name: "list_tickets", description: "List open tickets", text: "none" }] })
  const foreign = await elsewhere.call("POST", "/v1/mcp-connections", { name: "Support desk", url: `${service.url}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] } })
  await service.close()
  assert.equal(foreign.status, 200, summary(foreign))
  const foreignId = text(field(foreign.body, "id"), "connection id")

  // The same refusal, word for word, from both routes; nothing is saved by either.
  for (const body of [
    { sources: { connections: { [foreignId]: "everyone" } } },
    { sources: { connections: { emc_01k0000000000000000000000: "off" } } },
    { sources: { otherConnections: [foreignId] } },
    // No longer settings: the calendar's app isn't picked, and mail and chat are read through their connections.
    { sources: { coreConnections: { calendar: [foreignId] } } },
    { sources: { coreDefaults: { calendar: foreignId } } },
    { sources: { email: "off" } },
    { sources: { chat: "members" } },
    { sources: { toolOverrides: { [foreignId]: { list_issues: "allow" } } } },
    { brief: { text: "Only deadlines." } },
    { startHour: 18, endHour: 9 },
    { leadMinutes: 7 },
    { dailyCap: 50 },
    { sources: { calendar: "sometimes" } },
    { unknown: true },
    { instructions: "x".repeat(601) },
    { destination: { kind: "slack_channel", connectionId: "emc_01k0000000000000000000000", channel: "C0SHARED" } },
  ]) {
    const [forEveryone, forTeam] = [await call("PUT", proactive, body), await call("PUT", agentOf(research), body)]
    assert.equal(forEveryone.status, 400, `${JSON.stringify(body)}: ${summary(forEveryone)}`)
    assert.equal(forTeam.status, 400, `${JSON.stringify(body)}: ${summary(forTeam)}`)
    assert.deepEqual(forTeam.body, forEveryone.body, JSON.stringify(body))
  }
  assert.deepEqual(await storedRows(research), [], "a refused first save creates no override")
  assert.equal(field((await call("GET", agentOf(research))).body, "inherit"), true)
  // A refused change to a team that has its own keeps what it had.
  assert.equal((await call("PUT", agentOf(research), { dailyCap: 5 })).status, 200)
  assert.equal((await call("PUT", agentOf(research), { dailyCap: 4, startHour: 18, endHour: 9 })).status, 400)
  assert.equal(field((await call("GET", agentOf(research))).body, "settings", "dailyCap"), 5)

  // The team must be one of this organization's, for every route.
  for (const teamId of [createDenTypeId("team"), elsewhereTeam]) {
    for (const missing of [await call("GET", agentOf(teamId)), await call("PUT", agentOf(teamId), { enabled: true })]) {
      assert.equal(missing.status, 404, summary(missing))
      assert.deepEqual(missing.body, { error: "team_not_found" })
    }
  }
  assert.deepEqual(await storedRows(elsewhereTeam), [])
  assert.equal(field((await elsewhere.call("GET", agentOf(elsewhereTeam))).body, "inherit"), true)

  // View OpenWork Models settings reads; only Manage OpenWork Models writes; other members and organizations get nothing.
  const asViewer = den.as(viewer, orgId)
  const viewed = await asViewer("GET", agentOf(research))
  assert.equal(viewed.status, 200, summary(viewed))
  assert.deepEqual([field(viewed.body, "inherit"), field(viewed.body, "settings", "dailyCap")], [false, 5])
  assert.equal(field(viewed.body, "sourceConnections"), null, "connection names only with View connections, as for the organization")
  for (const refused of [
    await asViewer("PUT", agentOf(research), { dailyCap: 1 }),
    await asViewer("PUT", `${path}/${research}`, { agent: inherit }),
    await den.as(plain, orgId)("GET", agentOf(research)),
    await den.as(plain, orgId)("PUT", agentOf(research), { dailyCap: 1 }),
    await den.as(plain, orgId)("GET", `${agentOf(research)}/sources/${foreignId}/tools`),
  ]) assert.equal(refused.status, 403, summary(refused))
  for (const refused of [await den.as(elsewhere.owner, orgId)("GET", agentOf(research)), await den.as(elsewhere.owner, orgId)("PUT", agentOf(research), { dailyCap: 1 })]) {
    assert.equal(refused.status, 404, summary(refused))
  }
  assert.equal((await den.request(null, "GET", agentOf(research), { orgId })).status, 401)
  assert.equal((await den.request(null, "PUT", agentOf(research), { orgId, body: { dailyCap: 1 } })).status, 401)
  assert.equal(field((await call("GET", agentOf(research))).body, "settings", "dailyCap"), 5)
})

test("a member's agent follows their team's policy; two teams that differ give Everyone's; discovery and the wake follow each member's own", { timeout: 180_000 }, async () => {
  const { orgId, owner, call } = await agentWorkspace("Agent members")
  const ada = await den.newMember(owner, orgId, "Agent Ada")
  const ben = await den.newMember(owner, orgId, "Agent Ben")
  const cal = await den.newMember(owner, orgId, "Agent Cal")
  const research = await den.createTeam(owner, orgId, "Research", [ada.memberId, ben.memberId])
  const design = await den.createTeam(owner, orgId, "Design", [ben.memberId])
  const organizationId = normalizeDenTypeId("organization", orgId)
  const { listAgentCandidates } = await import("../../src/workbot-proactive/access.js")
  const { defaultAgentWakeDeps, wakeMemberAgent } = await import("../../src/workbot-proactive/worker.js")
  const { ensureAgentInstances, readAgentInstance } = await import("../../src/workbot-proactive/repository.js")
  const { requestAgentCheck } = await import("../../src/mcp/agent-check-request.js")
  const discovered = async () => (await listAgentCandidates()).find((candidate) => candidate.organizationId === organizationId)?.memberIds ?? null
  /** What My agent tells one member about the policy they are under: on at all, and the limits it follows. */
  const mine = async (member: Member) => {
    const view = await den.as(member, orgId)("GET", "/v1/me/agent")
    assert.equal(view.status, 200, summary(view))
    const hours = field(view.body, "workingHours")
    return { available: field(view.body, "available"), ...(isRecord(hours) ? hours : {}) }
  }
  /** One wake of one member's agent with the worker's own wiring; nothing is settled or recorded. */
  const wake = async (member: Member) => {
    const memberId = normalizeDenTypeId("member", member.memberId)
    await ensureAgentInstances(organizationId, [memberId])
    const row = await readAgentInstance(memberId)
    assert.ok(row, "the member has an agent")
    const outcome = await wakeMemberAgent(row, { ...defaultAgentWakeDeps(), settle: async () => true, recordCheck: async () => {} })
    return outcome.status === "skipped" ? outcome.reason : outcome.status
  }
  const everyone = { workingDays: "weekdays", startHour: 8, endHour: 19, dailyCap: 3 }

  // Agents are off for everyone and no team has its own: nobody is a candidate and nobody is woken.
  assert.equal(await discovered(), null)
  assert.deepEqual(await mine(ada), { available: false, ...everyone })
  assert.equal(await wake(ada), "off")

  // Research turns agents on for its members only, with its own hours and limit.
  assert.equal((await call("PUT", agentOf(research), { enabled: true, startHour: 10, dailyCap: 5 })).status, 200)
  const teams = { workingDays: "weekdays", startHour: 10, endHour: 19, dailyCap: 5 }
  assert.deepEqual(await mine(ada), { available: true, ...teams })
  assert.deepEqual(await mine(ben), { available: true, ...teams }, "Ben's other team follows Everyone, so Research's applies")
  assert.deepEqual(await mine(cal), { available: false, ...everyone }, "a member outside the team never gets its policy")
  // Discovery finds the organization through the team's row, though Everyone's is off; every active member is a
  // candidate and each one's own policy decides the wake.
  const candidates = await discovered()
  assert.ok(candidates)
  for (const member of [ada, ben, cal]) assert.ok(candidates.includes(normalizeDenTypeId("member", member.memberId)), member.name)
  // Past "off", the next gate in this workspace is the missing Slack app: the wake got as far as delivery.
  assert.equal(await wake(ada), "slack_app_not_installed")
  assert.equal(await wake(cal), "off")

  // Ben's teams differ: he is back on Everyone's (off); the list counts him in both teams.
  const differing = await call("PUT", agentOf(design), { enabled: true, dailyCap: 1 })
  assert.equal(differing.status, 200, summary(differing))
  const listed = await call("GET", path)
  assert.deepEqual([team(listed, research).conflictingMemberCount, team(listed, design).conflictingMemberCount], [1, 1])
  assert.deepEqual(await mine(ben), { available: false, ...everyone })
  assert.equal(await wake(ben), "off")
  assert.deepEqual(await mine(ada), { available: true, ...teams })
  // Teams that hold the same policy agree, however each got there.
  assert.equal((await call("PUT", agentOf(design), { startHour: 10, dailyCap: 5 })).status, 200)
  assert.equal(team(await call("GET", path), research).conflictingMemberCount, 0)
  assert.deepEqual(await mine(ben), { available: true, ...teams })
  assert.equal((await call("PUT", `${path}/${design}`, { agent: inherit })).status, 200)

  // Everyone's on, the team's off: the team's members get no wake, everyone else does.
  assert.equal((await call("PUT", proactive, { enabled: true })).status, 200)
  assert.equal((await call("PUT", agentOf(research), { enabled: false })).status, 200)
  assert.deepEqual(await mine(ada), { available: false, ...teams })
  assert.equal(await wake(ada), "off")
  assert.equal(await wake(cal), "slack_app_not_installed")
  assert.deepEqual(await mine(cal), { available: true, ...everyone })

  // The agent's extra checks follow the member's own policy too: the team's brief allows none.
  assert.equal((await den.setFeature(orgId, "workbotAgentBrief", true)).status, 200)
  assert.equal((await call("PUT", agentOf(research), { enabled: true, brief: { extraChecksPerDay: 0 } })).status, 200)
  // Tuesday 2026-10-20, 14:05 UTC (a new agent's zone), inside both policies' hours and between two checks.
  const ask = (member: Member) => requestAgentCheck({ organizationId, memberId: normalizeDenTypeId("member", member.memberId), userId: normalizeDenTypeId("user", member.userId), at: "2026-10-20T14:45:00Z", why: "before the 3 PM", now: Date.parse("2026-10-20T14:05:00Z") })
  assert.deepEqual(await ask(ada), { ok: false, text: "No extra checks left for that day (0 a day). The scheduled checks still run." })
  const asked = await ask(cal)
  assert.deepEqual([asked.ok, asked.text.startsWith("Extra check set for")], [true, true], asked.text)
  assert.equal((await den.setFeature(orgId, "workbotAgentBrief", false)).status, 200)

  // The team's explicit policy still applies when agents are off for everyone.
  assert.equal((await call("PUT", proactive, { enabled: false })).status, 200)
  assert.equal(await wake(ada), "slack_app_not_installed")
  assert.deepEqual(await mine(ada), { available: true, ...teams })
  assert.ok((await discovered())?.includes(normalizeDenTypeId("member", ada.memberId)))

})
