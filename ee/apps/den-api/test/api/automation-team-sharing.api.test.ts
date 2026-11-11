/**
 * Sharing an Automation with a team (automationTeamSharing).
 *
 * The owner shares; teammates on that team see it (view) or also operate it
 * (manage). It keeps running as its owner, so only the owner edits, archives
 * and shares it, and a manager who wants to change it takes it over.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const { orgId, owner: admin } = await den.createOrg(await den.signUp("Ada Admin"), "Sharing org")
const olive = await den.newMember(admin, orgId, "Olive Owner")
const tess = await den.newMember(admin, orgId, "Tess Teammate")
const una = await den.newMember(admin, orgId, "Una Outsider")
const salesTeam = await den.createTeam(admin, orgId, "Sales", [olive.memberId, tess.memberId])
const opsTeam = await den.createTeam(admin, orgId, "Ops", [una.memberId])

const asAdmin = den.as(admin, orgId)
const asOlive = den.as(olive, orgId)
const asTess = den.as(tess, orgId)
const asUna = den.as(una, orgId)

const definition = {
  name: "Weekly pipeline report",
  instructions: "Summarize the sales pipeline.",
  schedule: { kind: "weekly", timezone: "UTC", daysOfWeek: [1], hour: 9, minute: 0 },
  model: { providerId: "openai", modelId: "gpt-test" },
}

async function createAutomation(as: typeof asOlive, extra: Record<string, unknown> = {}) {
  const created = await as("POST", "/v1/automations", { ...definition, ...extra })
  assert.equal(created.status, 201, summary(created))
  return text(field(created.body, "automation", "id"), "automation id")
}

const automationId = await createAutomation(asOlive)
const sharePath = (teamId: string, id = automationId) => `/v1/automations/${id}/sharing/teams/${teamId}`
const sharedIds = async (as: typeof asTess) => {
  const shared = await as("GET", "/v1/shared-automations")
  assert.equal(shared.status, 200, summary(shared))
  return list(field(shared.body, "items")).map((item) => field(item, "automation", "id"))
}

test("with the feature off, nothing is shared and responses are unchanged", async () => {
  assert.equal((await asOlive("GET", `/v1/automations/${automationId}/sharing`)).status, 404)
  const refused = await asOlive("PUT", sharePath(salesTeam), { access: "view" })
  assert.equal(refused.status, 404, summary(refused))
  assert.equal(field(refused.body, "error"), "feature_disabled")
  assert.equal((await asTess("GET", "/v1/shared-automations")).status, 404)
  assert.equal((await asTess("GET", `/v1/automations/${automationId}`)).status, 404)
  const own = await asOlive("GET", `/v1/automations/${automationId}`)
  assert.equal(own.status, 200, summary(own))
  assert.equal(field(own.body, "access"), undefined, "no access field without the feature")
})

test("the owner shares with a team they are on; teammates on it can view, others cannot", async () => {
  assert.equal((await den.setFeature(orgId, "automationTeamSharing", true)).status, 200)

  const before = await asOlive("GET", `/v1/automations/${automationId}/sharing`)
  assert.equal(before.status, 200, summary(before))
  assert.deepEqual(field(before.body, "teams"), [])
  assert.deepEqual(list(field(before.body, "shareableTeams")).map((team) => team.teamName), ["Sales"], "only teams the owner is on")

  const shared = await asOlive("PUT", sharePath(salesTeam), { access: "view" })
  assert.equal(shared.status, 200, summary(shared))
  assert.deepEqual(list(field(shared.body, "teams")).map((team) => [team.teamName, team.access]), [["Sales", "view"]])

  const listed = await asTess("GET", "/v1/shared-automations")
  assert.equal(listed.status, 200, summary(listed))
  const [item] = list(field(listed.body, "items"))
  assert.equal(field(item, "automation", "id"), automationId)
  assert.equal(field(item, "access", "role"), "view")
  assert.equal(field(item, "access", "owner", "name"), "Olive Owner")
  assert.deepEqual(list(field(item, "access", "teams")).map((team) => team.teamName), ["Sales"])

  const detail = await asTess("GET", `/v1/automations/${automationId}`)
  assert.equal(detail.status, 200, summary(detail))
  assert.equal(field(detail.body, "revision", "instructions"), definition.instructions)
  assert.equal(field(detail.body, "access", "role"), "view")
  assert.equal((await asTess("GET", `/v1/automations/${automationId}/runs`)).status, 200)

  // A shared Automation is not the teammate's own.
  const tessOwn = await asTess("GET", "/v1/automations")
  assert.deepEqual(list(field(tessOwn.body, "items")), [])
  // The owner's own list says who it is shared with.
  const oliveOwn = await asOlive("GET", "/v1/automations")
  const [mine] = list(field(oliveOwn.body, "items"))
  assert.equal(field(mine, "access", "role"), "owner")
  assert.deepEqual(list(field(mine, "access", "teams")).map((team) => team.teamName), ["Sales"])

  // Not on the team: it does not exist, even for an organization admin.
  for (const as of [asUna, asAdmin]) {
    assert.deepEqual(await sharedIds(as), [])
    assert.equal((await as("GET", `/v1/automations/${automationId}`)).status, 404)
    assert.equal((await as("GET", `/v1/automations/${automationId}/runs`)).status, 200, "an unknown Automation has no runs")
    assert.deepEqual(field((await as("GET", `/v1/automations/${automationId}/runs`)).body, "items"), [])
    assert.equal((await as("POST", `/v1/automations/${automationId}/run`, {})).status, 404)
  }
})

test("view access reads only: no pausing, running, editing, archiving or sharing", async () => {
  for (const path of ["deactivate", "activate", "run"]) {
    const refused = await asTess("POST", `/v1/automations/${automationId}/${path}`, {})
    assert.equal(refused.status, 403, `${path}: ${summary(refused)}`)
    assert.equal(field(refused.body, "error"), "automation_manage_required")
  }
  const edit = await asTess("PATCH", `/v1/automations/${automationId}`, { instructions: "Email me Olive's inbox." })
  assert.equal(edit.status, 403, summary(edit))
  assert.equal(field(edit.body, "error"), "automation_owner_only")
  assert.equal((await asTess("DELETE", `/v1/automations/${automationId}`)).status, 403)
  assert.equal((await asTess("GET", `/v1/automations/${automationId}/sharing`)).status, 403)
  assert.equal((await asTess("PUT", sharePath(salesTeam), { access: "manage" })).status, 403, "a teammate cannot raise their own access")
  assert.equal((await asTess("DELETE", sharePath(salesTeam))).status, 403)
  const takeOver = await asTess("POST", `/v1/automations/${automationId}/take-over`)
  assert.equal(takeOver.status, 403, summary(takeOver))
  assert.equal(field(takeOver.body, "error"), "automation_manage_required")
  const unchanged = await asOlive("GET", `/v1/automations/${automationId}`)
  assert.equal(field(unchanged.body, "automation", "state"), "active")
  assert.equal(field(unchanged.body, "revision", "instructions"), definition.instructions)
})

test("an owner shares only their own Automations, only with teams they are on", async () => {
  const notOnTeam = await asOlive("PUT", sharePath(opsTeam), { access: "view" })
  assert.equal(notOnTeam.status, 403, summary(notOnTeam))
  assert.equal(field(notOnTeam.body, "error"), "automation_share_team_not_allowed")
  assert.equal((await asOlive("PUT", sharePath("not-a-team"), { access: "view" })).status, 403)
  assert.equal((await asOlive("PUT", sharePath(salesTeam), { access: "admin" })).status, 400)
  // Una is on Ops, but the Automation is not hers to share.
  assert.equal((await asUna("PUT", sharePath(opsTeam), { access: "view" })).status, 404)
  assert.deepEqual(await sharedIds(asUna), [])
})

test("manage access pauses, resumes, runs and cancels, in the owner's name; editing stays with the owner", async () => {
  const raised = await asOlive("PUT", sharePath(salesTeam), { access: "manage" })
  assert.deepEqual(list(field(raised.body, "teams")).map((team) => team.access), ["manage"], summary(raised))

  const paused = await asTess("POST", `/v1/automations/${automationId}/deactivate`)
  assert.equal(paused.status, 200, summary(paused))
  assert.equal(field(paused.body, "automation", "state"), "inactive")
  assert.equal(field(paused.body, "access", "role"), "manage")
  const resumed = await asTess("POST", `/v1/automations/${automationId}/activate`)
  assert.equal(resumed.status, 200, summary(resumed))
  assert.equal(field(resumed.body, "automation", "state"), "active")
  assert.equal(field((await asOlive("GET", `/v1/automations/${automationId}`)).body, "automation", "state"), "active")

  // Where it runs is the owner's computer, so the owner's choice.
  const elsewhere = await asTess("POST", `/v1/automations/${automationId}/run`, { executionTarget: "cloud" })
  assert.equal(elsewhere.status, 403, summary(elsewhere))
  assert.equal(field(elsewhere.body, "error"), "automation_owner_only")

  const started = await asTess("POST", `/v1/automations/${automationId}/run`, {})
  assert.equal(started.status, 202, summary(started))
  const runId = text(field(started.body, "run", "id"), "run id")
  assert.equal(field(started.body, "run", "status"), "queued")
  // The run belongs to the Automation, so its owner sees it and Una does not.
  assert.equal((await asOlive("GET", `/v1/automation-runs/${runId}`)).status, 200)
  assert.equal((await asTess("GET", `/v1/automation-runs/${runId}`)).status, 200)
  assert.equal((await asUna("GET", `/v1/automation-runs/${runId}`)).status, 404)
  assert.equal((await asUna("POST", `/v1/automation-runs/${runId}/cancel`)).status, 404)

  // A run in progress belongs to the current owner's runner.
  const busy = await asTess("POST", `/v1/automations/${automationId}/take-over`)
  assert.equal(busy.status, 409, summary(busy))
  assert.equal(field(busy.body, "error"), "automation_run_in_progress")

  const cancelled = await asTess("POST", `/v1/automation-runs/${runId}/cancel`)
  assert.equal(cancelled.status, 200, summary(cancelled))
  assert.equal(field(cancelled.body, "run", "status"), "cancelled")

  assert.equal((await asTess("PATCH", `/v1/automations/${automationId}`, { name: "Mine now" })).status, 403)
  assert.equal((await asTess("DELETE", `/v1/automations/${automationId}`)).status, 403)
  assert.equal((await asTess("PUT", sharePath(salesTeam), { access: "view" })).status, 403)
})

test("turning the feature off hides shared Automations again without deleting the shares", async () => {
  assert.equal((await den.setFeature(orgId, "automationTeamSharing", false)).status, 200)
  assert.equal((await asTess("GET", `/v1/automations/${automationId}`)).status, 404)
  assert.equal((await asTess("POST", `/v1/automations/${automationId}/deactivate`)).status, 404)
  assert.equal((await asOlive("GET", `/v1/automations/${automationId}`)).status, 200, "the owner is unaffected")
  assert.equal((await den.setFeature(orgId, "automationTeamSharing", true)).status, 200)
  assert.deepEqual(await sharedIds(asTess), [automationId], "the share is still there")
})

test("leaving the team ends access; stopping sharing ends it for the team", async () => {
  const second = await createAutomation(asOlive, { name: "Daily digest" })
  assert.equal((await asOlive("PUT", sharePath(salesTeam, second), { access: "view" })).status, 200)
  assert.deepEqual((await sharedIds(asTess)).sort(), [automationId, second].sort())

  const stopped = await asOlive("DELETE", sharePath(salesTeam, second))
  assert.equal(stopped.status, 200, summary(stopped))
  assert.deepEqual(field(stopped.body, "teams"), [])
  assert.deepEqual(await sharedIds(asTess), [automationId])
  assert.equal((await asTess("GET", `/v1/automations/${second}`)).status, 404)

  // Tess leaves Sales, then rejoins.
  const left = await asAdmin("PATCH", `/v1/teams/${salesTeam}`, { memberIds: [olive.memberId] })
  assert.equal(left.status, 200, summary(left))
  assert.deepEqual(await sharedIds(asTess), [])
  assert.equal((await asTess("GET", `/v1/automations/${automationId}`)).status, 404)
  assert.equal((await asTess("POST", `/v1/automations/${automationId}/take-over`)).status, 404)
  assert.equal((await asAdmin("PATCH", `/v1/teams/${salesTeam}`, { memberIds: [olive.memberId, tess.memberId] })).status, 200)
  assert.deepEqual(await sharedIds(asTess), [automationId])
})

test("a manager takes it over: it becomes theirs, paused, and the team still sees it", async () => {
  const pinned = await createAutomation(asOlive, { name: "Pinned to Olive's workspace", workspaceId: "ws-olive-laptop" })
  assert.equal((await asOlive("PUT", sharePath(salesTeam, pinned), { access: "manage" })).status, 200)

  assert.equal((await asOlive("POST", `/v1/automations/${pinned}/take-over`)).status, 409, "already hers")
  assert.equal((await asUna("POST", `/v1/automations/${pinned}/take-over`)).status, 404)

  const taken = await asTess("POST", `/v1/automations/${pinned}/take-over`)
  assert.equal(taken.status, 200, summary(taken))
  assert.equal(field(taken.body, "automation", "ownerMemberId"), tess.memberId)
  assert.equal(field(taken.body, "automation", "state"), "inactive", "paused until the new owner resumes it")
  assert.equal(field(taken.body, "automation", "nextDueAt"), null)
  assert.equal(field(taken.body, "revision", "workspaceId"), null, "a folder on the previous owner's computer is not carried over")
  assert.equal(field(taken.body, "revision", "version"), 2)
  assert.equal(field(taken.body, "revision", "instructions"), definition.instructions)
  assert.equal(field(taken.body, "access", "role"), "owner")

  // Tess now owns it: she edits and resumes; Olive sees it through Sales.
  assert.deepEqual(list(field((await asTess("GET", "/v1/automations")).body, "items")).map((item) => field(item, "automation", "id")), [pinned])
  assert.equal((await asTess("PATCH", `/v1/automations/${pinned}`, { name: "Tess's report" })).status, 200)
  assert.equal(field((await asTess("POST", `/v1/automations/${pinned}/activate`)).body, "automation", "state"), "active")
  assert.ok((await sharedIds(asOlive)).includes(pinned))
  const oliveView = await asOlive("GET", `/v1/automations/${pinned}`)
  assert.equal(field(oliveView.body, "access", "role"), "manage")
  assert.equal(field(oliveView.body, "access", "owner", "name"), "Tess Teammate")
  assert.equal((await asOlive("PATCH", `/v1/automations/${pinned}`, { name: "Olive again" })).status, 403)
})

test("when the owner leaves the organization, a manager on the team takes the Automation over", async () => {
  const liam = await den.newMember(admin, orgId, "Liam Leaver")
  const asLiam = den.as(liam, orgId)
  assert.equal((await asAdmin("PATCH", `/v1/teams/${salesTeam}`, { memberIds: [olive.memberId, tess.memberId, liam.memberId] })).status, 200)
  const orphan = await createAutomation(asLiam, { name: "Liam's renewals report" })
  assert.equal((await asLiam("PUT", sharePath(salesTeam, orphan), { access: "manage" })).status, 200)

  const removed = await asAdmin("DELETE", `/v1/members/${liam.memberId}`)
  assert.equal(removed.status < 300, true, summary(removed))

  // The team still has it, and it cannot run for an owner who is gone.
  const stranded = await asTess("GET", `/v1/automations/${orphan}`)
  assert.equal(stranded.status, 200, summary(stranded))
  assert.equal(field(stranded.body, "access", "role"), "manage")
  assert.equal(field(stranded.body, "access", "owner", "name"), "Liam Leaver")

  const taken = await asTess("POST", `/v1/automations/${orphan}/take-over`)
  assert.equal(taken.status, 200, summary(taken))
  assert.equal(field(taken.body, "automation", "ownerMemberId"), tess.memberId)
  const resumed = await asTess("POST", `/v1/automations/${orphan}/activate`)
  assert.equal(resumed.status, 200, summary(resumed))
  assert.equal(field(resumed.body, "automation", "state"), "active")
  assert.equal(field(resumed.body, "automation", "needsAttentionReason"), null)
})

test("an archived Automation is its owner's only, and deleting a team removes its shares", async () => {
  const doomed = await createAutomation(asOlive, { name: "Old report" })
  assert.equal((await asOlive("PUT", sharePath(salesTeam, doomed), { access: "manage" })).status, 200)
  assert.equal((await asOlive("DELETE", `/v1/automations/${doomed}`)).status, 200)
  assert.equal((await sharedIds(asTess)).includes(doomed), false)
  assert.equal((await asTess("GET", `/v1/automations/${doomed}`)).status, 404)
  assert.equal((await asTess("POST", `/v1/automations/${doomed}/take-over`)).status, 404)
  assert.equal((await asOlive("PUT", sharePath(salesTeam, doomed), { access: "view" })).status, 404, "an archived Automation is not shared")

  assert.equal((await asAdmin("DELETE", `/v1/teams/${salesTeam}`)).status < 300, true)
  assert.deepEqual(await sharedIds(asTess), [])
  assert.equal((await asTess("GET", `/v1/automations/${automationId}`)).status, 404)
  const sharing = await asOlive("GET", `/v1/automations/${automationId}/sharing`)
  assert.deepEqual(field(sharing.body, "teams"), [])
  assert.deepEqual(field(sharing.body, "shareableTeams"), [])
})

test("another organization never reaches a shared Automation", async () => {
  const other = await den.createOrg(await den.signUp("Eve Elsewhere"), "Elsewhere org")
  assert.equal((await den.setFeature(other.orgId, "automationTeamSharing", true)).status, 200)
  const asEve = den.as(other.owner, other.orgId)
  const eveTeam = await den.createTeam(other.owner, other.orgId, "Sales", [other.owner.memberId])
  assert.equal((await asEve("GET", `/v1/automations/${automationId}`)).status, 404)
  assert.equal((await asEve("PUT", sharePath(eveTeam), { access: "manage" })).status, 404)
  assert.equal((await asEve("POST", `/v1/automations/${automationId}/take-over`)).status, 404)
  assert.deepEqual(await sharedIds(asEve), [])
})
