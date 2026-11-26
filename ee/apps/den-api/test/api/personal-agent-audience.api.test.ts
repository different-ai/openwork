import assert from "node:assert/strict"
import { after, test } from "node:test"
import { personalAgentDetailSchema, personalAgentListSchema } from "@openwork/types/den/personal-agents"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud" } })
after(async () => { await den.close() })
const { orgId, owner: dana } = await den.createOrg(await den.signUp("Dana Reyes", "dana-reyes@acme.test"), "Personal agents audience fixture")
const sam = await den.newMember(dana, orgId, "Sam Okafor")
const priya = await den.newMember(dana, orgId, "Priya Nair")
const lee = await den.newMember(dana, orgId, "Lee Park", "admin")
const asDana = den.as(dana, orgId)
const asSam = den.as(sam, orgId)
const asPriya = den.as(priya, orgId)
const asLee = den.as(lee, orgId)
const agents = "/v1/personal-agents"
const policy = "/v1/org/personal-agent-policy"
const adminsOnly = { error: "personal_agent_sharing_admins_only", message: "Only admins can share agents in this organization." }

test("the audience route honors the personal agents flag", async () => {
  const refused = await asSam("PUT", `${agents}/${createDenTypeId("personalAgent")}/audience`, { organization: true, teams: [] })
  assert.equal(refused.status, 404, summary(refused))
  assert.deepEqual(refused.body, { error: "feature_disabled", feature: "personalAgents" })
  assert.equal((await den.setFeature(orgId, "personalAgents", true)).status, 200)
})

test("team and organization audiences give collaborator access, with listing based on auto-add or a saved chat", async () => {
  const created = await asDana("POST", agents, { name: "Morning digest", brief: "Summarize new reports." })
  assert.equal(created.status, 201, summary(created))
  const ownerDetail = personalAgentDetailSchema.parse(created.body)
  assert.equal(ownerDetail.listed, true)
  assert.equal(ownerDetail.canShare, true)
  const path = `${agents}/${ownerDetail.agent.id}`
  const teamName = "Support"
  const teamId = await den.createTeam(dana, orgId, teamName, [priya.memberId])
  const otherOrg = await den.createOrg(lee, "Other workspace")
  const outsideTeam = await den.createTeam(otherOrg.owner, otherOrg.orgId, "Operations", [otherOrg.owner.memberId])
  const rejected = await asDana("PUT", `${path}/audience`, { organization: true, teams: [{ teamId: outsideTeam }] })
  assert.equal(rejected.status, 400, summary(rejected))
  const teamOnly = await asDana("PUT", `${path}/audience`, { organization: false, teams: [{ teamId }] })
  assert.equal(teamOnly.status, 200, summary(teamOnly))
  assert.deepEqual(personalAgentDetailSchema.parse(teamOnly.body).audience, { organization: false, autoAddOrganization: false, teams: [{ teamId, name: teamName, autoAdd: false }] })
  for (const outsider of [asSam, asLee]) {
    assert.equal((await outsider("GET", path)).status, 404)
    assert.deepEqual(personalAgentListSchema.parse((await outsider("GET", agents)).body).items, [])
  }
  const priyaDetail = await asPriya("GET", path)
  assert.equal(priyaDetail.status, 200, summary(priyaDetail))
  const detail = personalAgentDetailSchema.parse(priyaDetail.body)
  assert.equal(detail.role, "collaborator")
  assert.equal(detail.canShare, false)
  assert.equal(detail.listed, false)
  assert.deepEqual(detail.sharedWith, [])
  assert.equal(personalAgentListSchema.parse((await asPriya("GET", agents)).body).items[0]?.listed, false)
  assert.equal((await asPriya("PUT", `${path}/audience`, { organization: true, teams: [] })).status, 403)
  const autoAddTeam = await asDana("PUT", `${path}/audience`, { organization: true, teams: [{ teamId, autoAdd: true }] })
  assert.equal(autoAddTeam.status, 200, summary(autoAddTeam))
  assert.equal(personalAgentDetailSchema.parse(autoAddTeam.body).audience.organization, true)
  assert.equal(personalAgentListSchema.parse((await asPriya("GET", agents)).body).items[0]?.listed, true)
  for (const member of [asSam, asLee]) {
    const visible = personalAgentDetailSchema.parse((await member("GET", path)).body)
    assert.equal(visible.role, "collaborator")
    assert.equal(visible.listed, false)
  }
  const pointer = await asSam("PUT", `${path}/chat`, { workspaceId: "workspace", sessionId: "morning-digest" })
  assert.equal(pointer.status, 200, summary(pointer))
  assert.equal(personalAgentListSchema.parse((await asSam("GET", agents)).body).items[0]?.listed, true)
  const autoAddOrg = await asDana("PUT", `${path}/audience`, { organization: true, autoAddOrganization: true, teams: [] })
  assert.equal(autoAddOrg.status, 200, summary(autoAddOrg))
  assert.equal(personalAgentDetailSchema.parse((await asLee("GET", path)).body).listed, true)
})

test("admins-only sharing preserves existing shares and lets direct recipients remove themselves", async () => {
  const created = await asSam("POST", agents, { name: "Triage digest", brief: "Summarize triage." })
  assert.equal(created.status, 201, summary(created))
  const { agent } = personalAgentDetailSchema.parse(created.body)
  const path = `${agents}/${agent.id}`
  const sharePriya = `${path}/shares/${priya.memberId}`
  const shareLee = `${path}/shares/${lee.memberId}`
  assert.equal((await asSam("PUT", sharePriya, { role: "collaborator" })).status, 200)
  const updatedPolicy = await asLee("PUT", policy, { shareMode: "admins" })
  assert.equal(updatedPolicy.status, 200, summary(updatedPolicy))
  assert.equal(personalAgentDetailSchema.parse((await asSam("GET", path)).body).canShare, false)
  for (const [target, body] of [
    [sharePriya, { role: "manager" }],
    [shareLee, { role: "collaborator" }],
    [`${path}/audience`, { organization: true, teams: [] }],
  ] as const) {
    const result = await asSam("PUT", target, body)
    assert.equal(result.status, 403, summary(result))
    assert.deepEqual(result.body, adminsOnly)
  }
  const existing = personalAgentDetailSchema.parse((await asPriya("GET", path)).body)
  assert.equal(existing.role, "collaborator")
  assert.equal(existing.listed, true)
  const leave = await asPriya("DELETE", sharePriya)
  assert.equal(leave.status, 200, summary(leave))
  assert.equal((await asPriya("GET", path)).status, 404)
  const adminAgent = await asLee("POST", agents, { name: "Release digest", brief: "Summarize releases." })
  assert.equal(adminAgent.status, 201, summary(adminAgent))
  const adminDetail = personalAgentDetailSchema.parse(adminAgent.body)
  assert.equal(adminDetail.canShare, true)
  const adminPath = `${agents}/${adminDetail.agent.id}`
  const adminShare = await asLee("PUT", `${adminPath}/shares/${sam.memberId}`, { role: "manager" })
  assert.equal(adminShare.status, 200, summary(adminShare))
  const adminAudience = await asLee("PUT", `${adminPath}/audience`, { organization: true, teams: [] })
  assert.equal(adminAudience.status, 200, summary(adminAudience))
  const manager = personalAgentDetailSchema.parse((await asSam("GET", adminPath)).body)
  assert.equal(manager.role, "manager")
  assert.equal(manager.canShare, false)
})


test("Lee cannot expand an audience if the only member or team was removed", async () => {
  async function create(name: string) {
    const response = await asDana("POST", agents, { name, brief: "Summarize reports." })
    assert.equal(response.status, 201, summary(response))
    return personalAgentDetailSchema.parse(response.body).agent.id
  }
  const direct = await create("Direct reports")
  assert.equal((await asDana("PUT", `${agents}/${direct}/shares/${priya.memberId}`, { role: "collaborator" })).status, 200)
  assert.equal((await asDana("DELETE", `/v1/members/${priya.memberId}`)).status, 204)
  const teamId = await den.createTeam(dana, orgId, "Removed team", [sam.memberId])
  const team = await create("Team reports")
  assert.equal((await asDana("PUT", `${agents}/${team}/audience`, { organization: false, teams: [{ teamId }] })).status, 200)
  assert.equal((await asDana("DELETE", `/v1/teams/${teamId}`)).status, 204)
  for (const id of [direct, team]) {
    const response = await asLee("PUT", `/v1/org/personal-agents/${id}/audience`, { organization: true, teams: [] })
    assert.equal(response.status, 409, summary(response))
    assert.deepEqual(response.body, { error: "personal_agent_not_shared", message: "The owner must share this agent before you can change who can use it." })
  }
})
