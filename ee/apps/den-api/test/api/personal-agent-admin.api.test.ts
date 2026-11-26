import assert from "node:assert/strict"
import { after, test } from "node:test"
import { automationDetailSchema } from "@openwork/types/automations"
import {
  personalAgentAdminItemSchema,
  personalAgentAdminListSchema,
  personalAgentDetailSchema,
  personalAgentEventListSchema,
  personalAgentListSchema,
  personalAgentOrgPolicySchema,
  personalAgentRunListSchema,
} from "@openwork/types/den/personal-agents"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"
import { bootDen, field, startFakeHttpServer, startFakeMcpServer, summary, text } from "./harness.js"

const restoreCatalog = stubPublicModelCatalog()
const runner = await startFakeHttpServer((_request, _raw, response) => response.writeHead(404).end())
const tracker = await startFakeMcpServer({ tools: [{ name: "create_issue", description: "File an issue", text: "Issue filed" }] })
const den = await bootDen({ env: {
  ...gatewayFixtureEnv,
  DEN_DEPLOYMENT: "cloud",
  DEN_HEADLESS_RUNNER_URL: runner.url,
  DEN_HEADLESS_RUNNER_TOKEN: "fixture-runner-token-at-least-thirty-two-characters",
} })
after(async () => { await runner.close(); await tracker.close(); await den.close(); restoreCatalog() })

const { orgId, owner: dana } = await den.createOrg(await den.signUp("Dana Reyes", "dana-reyes@acme.test"), "Personal agents admin fixture")
const lee = await den.newMember(dana, orgId, "Lee Park", "admin")
const sam = await den.newMember(dana, orgId, "Sam Okafor")
const asDana = den.as(dana, orgId)
const asLee = den.as(lee, orgId)
const asSam = den.as(sam, orgId)
const agents = "/v1/org/personal-agents"
const policyPath = "/v1/org/personal-agent-policy"
const eventsPath = "/v1/org/personal-agent-events"
const brief = "Private instructions to collect the morning bug reports."
const emptyPolicy = { toolPolicy: { connections: {}, tools: {} }, monthlyBudgetMicros: null, shareMode: "everyone", sharedLogins: false, rules: "" }

function agentRoutes(id: string) {
  return [
    ["POST", `${agents}/${id}/pause`, undefined],
    ["POST", `${agents}/${id}/resume`, undefined],
    ["PUT", `${agents}/${id}/budget`, { monthlyBudgetMicros: 1 }],
    ["PUT", `${agents}/${id}/audience`, { organization: true, teams: [] }],
    ["POST", `${agents}/${id}/transfer`, { memberId: sam.memberId }],
    ["POST", `${agents}/${id}/archive`, undefined],
  ] as const
}

const routes = [
  ["GET", agents, undefined],
  ...agentRoutes(createDenTypeId("personalAgent")),
  ["GET", policyPath, undefined],
  ["PUT", policyPath, { monthlyBudgetMicros: 1 }],
  ["GET", eventsPath, undefined],
] as const

test("all ten admin routes honor the feature flag and require admin access", async () => {
  for (const [method, path, body] of routes) {
    const result = await asLee(method, path, body)
    assert.equal(result.status, 404, summary(result))
    assert.deepEqual(result.body, { error: "feature_disabled", feature: "personalAgents" })
  }
  assert.equal((await den.setFeature(orgId, "personalAgents", true)).status, 200)
  for (const [method, path, body] of routes) {
    const result = await asSam(method, path, body)
    assert.equal(result.status, 403, `${method} ${path}: ${summary(result)}`)
  }
  const ownerRead = await asDana("GET", policyPath)
  assert.equal(ownerRead.status, 200, summary(ownerRead))
  assert.deepEqual(ownerRead.body, emptyPolicy)
})

test("admins can manage agents across owners without getting their briefs", async () => {
  await grantGatewayModels(den, dana, orgId, [dana, sam])
  const connected = await asDana("POST", "/v1/mcp-connections", {
    name: "Bug tracker", url: `${tracker.url}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  assert.equal(connected.status, 200, summary(connected))
  const connectionId = text(field(connected.body, "id"), "connection id")
  const created = await asDana("POST", "/v1/personal-agents", {
    name: "Bug watcher", brief,
    toolPolicy: { tools: { [connectionId]: { create_issue: "allow", update_issue: "ask", delete_issue: "block" } } },
  })
  assert.equal(created.status, 201, summary(created))
  const { agent: { id } } = personalAgentDetailSchema.parse(created.body)
  const adminAgent = `${agents}/${id}`
  const memberAgent = `/v1/personal-agents/${id}`
  const samAgentCreated = await asSam("POST", "/v1/personal-agents", {
    name: "Bug reporter", brief: "Private instructions for Sam's agent.", toolPolicy: { connections: { [connectionId]: "block" } },
  })
  assert.equal(samAgentCreated.status, 201, summary(samAgentCreated))
  const samAgent = personalAgentDetailSchema.parse(samAgentCreated.body).agent
  const share = await asDana("PUT", `${memberAgent}/shares/${sam.memberId}`, { role: "manager" })
  assert.equal(share.status, 200, summary(share))
  const routineCreated = await asDana("POST", `${memberAgent}/routines`, {
    name: "Morning bugs", instructions: "Collect yesterday's reports.", schedule: { kind: "daily", hour: 8, minute: 0, timezone: "UTC" },
  })
  assert.equal(routineCreated.status, 201, summary(routineCreated))
  const routine = automationDetailSchema.parse(routineCreated.body).automation
  const adminList = await asLee("GET", agents)
  assert.equal(adminList.status, 200, summary(adminList))
  assert.doesNotMatch(adminList.text, /"brief"|Private instructions/)
  const listed = personalAgentAdminListSchema.parse(adminList.body)
  assert.deepEqual(listed.policy, emptyPolicy)
  assert.deepEqual(listed.items.map((entry) => [entry.agent.id, entry.owner.name]), [[samAgent.id, sam.name], [id, dana.name]])
  const danaItem = listed.items.find((item) => item.agent.id === id)
  assert.ok(danaItem)
  assert.deepEqual(danaItem.sharedWith.map((person) => [person.name, person.role]), [[sam.name, "manager"]])
  assert.deepEqual(danaItem.writeAccess, { allowed: 1, ask: 1, blocked: 1 })
  assert.deepEqual(listed.items[0]?.writeAccess, { allowed: 0, ask: 0, blocked: 1 })
  assert.deepEqual(danaItem.routines.map((entry) => entry.id), [routine.id])
  assert.equal(listed.monthMicros, listed.items.reduce((total, item) => total + item.spend.monthMicros, 0))

  const unshared = await asLee("PUT", `${agents}/${samAgent.id}/audience`, { organization: true, teams: [] })
  assert.equal(unshared.status, 409, summary(unshared))
  assert.equal(field(unshared.body, "error"), "personal_agent_not_shared")
  assert.equal((await asLee("GET", memberAgent)).status, 404)
  const teamId = await den.createTeam(dana, orgId, "Support", [sam.memberId])
  const broadened = await asLee("PUT", `${adminAgent}/audience`, { organization: false, teams: [{ teamId, autoAdd: true }] })
  assert.equal(broadened.status, 200, summary(broadened))
  assert.doesNotMatch(broadened.text, /"brief"|Private instructions|"chat"/)
  const adminAudience = personalAgentAdminItemSchema.parse(broadened.body).audience
  assert.deepEqual(adminAudience, { organization: false, autoAddOrganization: false, teams: [{ teamId, name: "Support", autoAdd: true }] })
  const listWithAudience = await asLee("GET", agents)
  assert.equal(listWithAudience.status, 200, summary(listWithAudience))
  assert.deepEqual(personalAgentAdminListSchema.parse(listWithAudience.body).items.find((item) => item.agent.id === id)?.audience, adminAudience)
  const cleared = await asLee("PUT", `${adminAgent}/audience`, { organization: false, teams: [] })
  assert.equal(cleared.status, 200, summary(cleared))
  assert.deepEqual(personalAgentAdminItemSchema.parse(cleared.body).audience, { organization: false, autoAddOrganization: false, teams: [] })

  const paused = await asLee("POST", `${adminAgent}/pause`)
  assert.equal(paused.status, 200, summary(paused))
  const pausedAt = personalAgentAdminItemSchema.parse(paused.body).agent.pausedAt
  assert.ok(pausedAt)
  const whilePaused = await asDana("GET", memberAgent)
  assert.equal(whilePaused.status, 200, summary(whilePaused))
  assert.equal(personalAgentDetailSchema.parse(whilePaused.body).agent.pausedAt, pausedAt)
  const pausedAgain = await asLee("POST", `${adminAgent}/pause`)
  assert.equal(pausedAgain.status, 200, summary(pausedAgain))
  assert.deepEqual(pausedAgain.body, paused.body)
  const resumed = await asLee("POST", `${adminAgent}/resume`)
  assert.equal(resumed.status, 200, summary(resumed))
  assert.equal(personalAgentAdminItemSchema.parse(resumed.body).agent.pausedAt, null)
  const whileResumed = await asDana("GET", memberAgent)
  assert.equal(whileResumed.status, 200, summary(whileResumed))
  assert.equal(personalAgentDetailSchema.parse(whileResumed.body).agent.pausedAt, null)
  const resumedAgain = await asLee("POST", `${adminAgent}/resume`)
  assert.equal(resumedAgain.status, 200, summary(resumedAgain))
  assert.deepEqual(resumedAgain.body, resumed.body)

  const budget = await asLee("PUT", `${adminAgent}/budget`, { monthlyBudgetMicros: 100_000 })
  assert.equal(budget.status, 200, summary(budget))
  assert.equal(personalAgentAdminItemSchema.parse(budget.body).spend.adminBudgetMicros, 100_000)

  const { orgId: otherOrgId, owner: priya } = await den.createOrg(await den.signUp("Priya Nair", "priya-nair@acme.test"), "Other organization admin fixture")
  const otherLee = await den.join(priya, otherOrgId, lee, "admin")
  const asOtherAdmin = den.as(otherLee, otherOrgId)
  assert.equal((await den.setFeature(otherOrgId, "personalAgents", true)).status, 200)
  for (const [invoke, invalidId] of [[asLee, "malformed"], [asOtherAdmin, id]] as const) {
    for (const [method, path, body] of [...agentRoutes(invalidId), ["GET", `${eventsPath}?agentId=${invalidId}`, undefined]] as const) {
      const hidden = await invoke(method, path, body)
      assert.equal(hidden.status, 404, summary(hidden))
      assert.deepEqual(hidden.body, { error: "personal_agent_not_found" })
    }
  }
  const foreignOwner = await asLee("POST", `${adminAgent}/transfer`, { memberId: otherLee.memberId })
  assert.equal(foreignOwner.status, 400, summary(foreignOwner))
  const { automationRepository } = await import("../../src/automations/repository.js")
  const { db } = await import("../../src/db.js")
  const { AutomationRunTable } = await import("@openwork-ee/den-db/schema")
  const { eq } = await import("@openwork-ee/den-db/drizzle")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
  const revision = automationDetailSchema.parse(routineCreated.body).revision
  const now = Date.now()
  const queued = await automationRepository.claim({ automation: routine, revision, trigger: "scheduled", scheduledFor: now, leaseOwner: "fixture", leaseMs: 60_000, now })
  const legacy = await automationRepository.claim({ automation: routine, revision, trigger: "manual", scheduledFor: null, nonce: "legacy", leaseOwner: "fixture", leaseMs: 60_000, now })
  const actorFor = async (id: string) => (await db.$primary.select({ actor: AutomationRunTable.acting_member_id }).from(AutomationRunTable)
    .where(eq(AutomationRunTable.id, normalizeDenTypeId("automationRun", id))).limit(1))[0]?.actor
  assert.equal(await actorFor(queued.run.id), dana.memberId)
  await db.update(AutomationRunTable).set({ acting_member_id: null }).where(eq(AutomationRunTable.id, normalizeDenTypeId("automationRun", legacy.run.id)))
  assert.equal((await asDana("GET", `${memberAgent}/runs/${legacy.run.id}`)).status, 200)
  const dueBeforeTransfer = automationDetailSchema.parse((await asDana("GET", `/v1/automations/${routine.id}`)).body).automation.nextDueAt
  const transferred = await asLee("POST", `${adminAgent}/transfer`, { memberId: sam.memberId })
  assert.equal(transferred.status, 200, summary(transferred))
  const moved = personalAgentAdminItemSchema.parse(transferred.body)
  assert.equal(moved.owner.name, sam.name)
  assert.deepEqual(moved.sharedWith, [])
  const samList = await asSam("GET", "/v1/personal-agents")
  assert.equal(samList.status, 200, summary(samList))
  assert.equal(personalAgentListSchema.parse(samList.body).items.find((item) => item.agent.id === id)?.role, "owner")
  assert.equal((await asDana("GET", memberAgent)).status, 404)
  const samRoutine = await asSam("GET", `/v1/automations/${routine.id}`)
  assert.equal(samRoutine.status, 200, summary(samRoutine))
  const movedRoutine = automationDetailSchema.parse(samRoutine.body).automation
  assert.equal(movedRoutine.ownerMemberId, sam.memberId)
  assert.equal(movedRoutine.nextDueAt, dueBeforeTransfer)
  assert.equal(await actorFor(queued.run.id), dana.memberId)
  assert.equal(await actorFor(legacy.run.id), dana.memberId)
  assert.equal((await asSam("GET", `${memberAgent}/runs/${legacy.run.id}`)).status, 404)
  const samRuns = await asSam("GET", `${memberAgent}/runs`)
  const [scheduledSummary, ...otherRuns] = personalAgentRunListSchema.parse(samRuns.body).items
  assert.deepEqual(otherRuns, [])
  assert.equal(scheduledSummary?.id, queued.run.id)
  assert.equal(scheduledSummary?.executionThread, null)
  assert.equal(scheduledSummary?.validatedResult, null)
  assert.equal(personalAgentDetailSchema.parse((await asSam("GET", memberAgent)).body).routines[0]?.latestRun?.id, queued.run.id)

  const archived = await asLee("POST", `${adminAgent}/archive`)
  assert.equal(archived.status, 200, summary(archived))
  assert.doesNotMatch(archived.text, /"brief"|Private instructions/)
  assert.equal(personalAgentAdminItemSchema.parse(archived.body).agent.state, "archived")
  const archivedRoutine = await asSam("GET", `/v1/automations/${routine.id}`)
  assert.equal(archivedRoutine.status, 200, summary(archivedRoutine))
  assert.equal(automationDetailSchema.parse(archivedRoutine.body).automation.state, "archived")
  const remaining = await asLee("GET", agents)
  assert.equal(remaining.status, 200, summary(remaining))
  assert.deepEqual(personalAgentAdminListSchema.parse(remaining.body).items.map((item) => item.agent.id), [samAgent.id])

  for (const access of ["allow", "ask"] as const) {
    const refused = await asLee("PUT", policyPath, { toolPolicy: { connections: { [connectionId]: access } } })
    assert.equal(refused.status, 400, summary(refused))
    assert.match(text(field(refused.body, "message"), "error message"), /A whole connection can only be blocked/)
  }
  const unknown = await asLee("PUT", policyPath, { toolPolicy: { connections: { [createDenTypeId("externalMcpConnection")]: "block" } } })
  assert.equal(unknown.status, 400, summary(unknown))
  const rules = "Summarize decisions without quoting internal messages."
  const policy = {
    toolPolicy: { connections: {}, tools: { [connectionId]: { create_issue: "block", update_issue: "ask", list_issues: "allow" } } },
    monthlyBudgetMicros: 200_000, shareMode: "admins", sharedLogins: true, rules,
  }
  const stored = await asLee("PUT", policyPath, { ...policy, rules: `  ${rules}  ` })
  assert.equal(stored.status, 200, summary(stored))
  assert.deepEqual(personalAgentOrgPolicySchema.parse(stored.body), policy)
  const lowered = await asLee("PUT", policyPath, { monthlyBudgetMicros: 150_000 })
  assert.equal(lowered.status, 200, summary(lowered))
  const read = await asLee("GET", policyPath)
  assert.equal(read.status, 200, summary(read))
  assert.deepEqual(read.body, { ...policy, monthlyBudgetMicros: 150_000 })

  const allEvents = await asLee("GET", eventsPath)
  assert.equal(allEvents.status, 200, summary(allEvents))
  const events = personalAgentEventListSchema.parse(allEvents.body).items
  const orgEvents = events.filter((entry) => entry.agentId === null)
  assert.equal(orgEvents.every((entry) => entry.actor.name === lee.name), true)
  assert.deepEqual(orgEvents.find((entry) => entry.action === "organization.tools_changed")?.detail, { blockedTools: 1, blockedConnections: 0 })
  assert.deepEqual(orgEvents.find((entry) => entry.action === "organization.sharing_changed")?.detail, { shareMode: "admins" })
  assert.deepEqual(orgEvents.find((entry) => entry.action === "organization.shared_logins_changed")?.detail, { on: true })
  assert.deepEqual(orgEvents.find((entry) => entry.action === "organization.rules_changed")?.detail, {})
  assert.equal(allEvents.text.includes(rules), false)
  assert.deepEqual(orgEvents.filter((entry) => entry.action === "organization.budget_set").map((entry) => entry.detail.monthlyBudgetMicros), [150_000, 200_000])
  assert.ok(events.some((entry) => entry.agentId === id && entry.action === "share.changed" && entry.detail.teams === 1 && entry.detail.organization === false))
  const agentEvents = await asLee("GET", `${eventsPath}?agentId=${id}&limit=5`)
  assert.equal(agentEvents.status, 200, summary(agentEvents))
  assert.deepEqual(personalAgentEventListSchema.parse(agentEvents.body).items.map((entry) => [entry.action, entry.actor.name, entry.detail]), [
    ["agent.archived", lee.name, { byAdmin: true }], ["agent.transferred", lee.name, { from: dana.name, to: sam.name }],
    ["agent.budget_set", lee.name, { monthlyBudgetMicros: 100_000 }], ["agent.resumed", lee.name, {}], ["agent.paused", lee.name, {}],
  ])
})
