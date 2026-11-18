import assert from "node:assert/strict"
import { after, test } from "node:test"
import { automationDetailSchema, sharedAutomationListSchema } from "@openwork/types/automations"
import { bootDen, field, list, summary, text, type Call } from "./harness.js"

const den = await bootDen()
after(() => den.close())

function status(call: Call, expected: number) {
  assert.equal(call.status, expected, summary(call))
  return call
}

function error(call: Call, expected: number, code: string) {
  status(call, expected)
  assert.equal(field(call.body, "error"), code)
}

test("sharing definitions isolates owners, audiences, copies and lifecycle cleanup over HTTP", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Sharing Admin"), "Automation sharing")
  const creator = await den.newMember(owner, orgId, "Automation Creator")
  const recipient = await den.newMember(owner, orgId, "Automation Recipient")
  const outsider = await den.newMember(owner, orgId, "Automation Observer")
  const foreign = await den.createOrg(await den.signUp("Foreign Admin"), "Other sharing organization")
  const admin = den.as(owner, orgId)
  const create = den.as(creator, orgId)
  const receive = den.as(recipient, orgId)
  const other = den.as(outsider, orgId)
  const provider = status(await admin("POST", "/v1/llm-providers", {
    name: "Sharing provider", source: "custom", allMembers: true, memberIds: [], teamIds: [],
    apiKey: "synthetic-sharing-key",
    customConfig: {
      id: "sharing-provider", name: "Sharing provider", npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:9/v1" }, env: ["AUTOMATION_SHARING_FIXTURE_KEY"],
      models: [{ id: "sharing-model", name: "Sharing model", tool_call: true }],
    },
  }), 201)
  const model = { providerId: text(field(provider.body, "llmProvider", "id"), "provider"), modelId: "sharing-model", variant: null }
  const definition = {
    name: "Definition to share", instructions: "Review the shared definition before activating.",
    schedule: { kind: "daily", timezone: "UTC", hour: 23, minute: 59 }, model, workspaceId: "source-private-workspace",
  }
  const created = status(await create("POST", "/v1/automations", definition), 201)
  const source = automationDetailSchema.parse(created.body)
  const id = source.automation.id
  for (const response of [
    await create("GET", `/v1/automations/${id}/sharing`),
    await create("PUT", `/v1/automations/${id}/sharing`, {}),
    await receive("GET", "/v1/shared-automations"),
    await receive("POST", `/v1/shared-automations/${id}/copy`, {}),
  ]) error(response, 404, "feature_disabled")
  status(await den.setFeature(orgId, "automationSharing", true), 200)

  const shared = status(await create("PUT", `/v1/automations/${id}/sharing`, { memberIds: [creator.memberId, recipient.memberId, recipient.memberId] }), 200)
  assert.deepEqual(shared.body, { orgWide: false, memberIds: [recipient.memberId], teamIds: [] })
  assert.deepEqual(status(await create("GET", `/v1/automations/${id}/sharing`), 200).body, shared.body)
  const listed = status(await receive("GET", "/v1/shared-automations"), 200)
  const [item] = sharedAutomationListSchema.parse(listed.body).items
  assert.ok(item)
  assert.equal(item.id, id)
  assert.equal(item.sharedBy.memberId, creator.memberId)
  assert.ok(item.sharedAt > 0)
  assert.deepEqual(Object.keys(list(field(listed.body, "items"))[0] ?? {}).sort(), ["id", "name", "sharedBy", "sharedAt", "schedule", "executionTarget", "action"].sort())
  assert.deepEqual(field(status(await other("GET", "/v1/shared-automations"), 200).body, "items"), [])
  assert.deepEqual(field(status(await create("GET", "/v1/shared-automations"), 200).body, "items"), [])
  for (const method of ["GET", "PUT"] satisfies Array<"GET" | "PUT">) {
    error(await receive(method, `/v1/automations/${id}/sharing`, method === "PUT" ? {} : undefined), 404, "automation_not_found")
  }
  error(await receive("GET", `/v1/automations/${id}`), 404, "automation_not_found")
  error(await receive("PATCH", `/v1/automations/${id}`, { name: "Cannot edit source" }), 404, "automation_not_found")
  error(await other("POST", `/v1/shared-automations/${id}/copy`, {}), 404, "automation_not_found")
  const copied = automationDetailSchema.parse(status(await receive("POST", `/v1/shared-automations/${id}/copy`, { name: "My reviewed copy", model }), 201).body)
  assert.notEqual(copied.automation.id, id)
  assert.equal(copied.automation.ownerMemberId, recipient.memberId)
  assert.equal(copied.automation.state, "inactive")
  assert.equal(copied.automation.nextDueAt, null)
  assert.equal(copied.revision.workspaceId, null)
  assert.equal(copied.automation.name, "My reviewed copy")
  assert.deepEqual(status(await create("GET", `/v1/automations/${id}`), 200).body, created.body)
  status(await receive("POST", `/v1/shared-automations/${id}/copy`, {}), 201)
  const firstSharedAt = item.sharedAt
  status(await create("PUT", `/v1/automations/${id}/sharing`, { memberIds: [recipient.memberId] }), 200)
  const unchangedShare = sharedAutomationListSchema.parse(status(await receive("GET", "/v1/shared-automations"), 200).body).items[0]
  assert.equal(unchangedShare?.sharedAt, firstSharedAt, "unchanged grants retain their original sharing time")
  status(await den.setFeature(orgId, "automationSharing", false), 200)
  error(await receive("GET", "/v1/shared-automations"), 404, "feature_disabled")
  status(await den.setFeature(orgId, "automationSharing", true), 200)
  assert.equal(sharedAutomationListSchema.parse(status(await receive("GET", "/v1/shared-automations"), 200).body).items[0]?.sharedAt, firstSharedAt)
  error(await receive("POST", `/v1/shared-automations/${id}/copy`, { model: { ...model, modelId: "missing-model" } }), 409, "model_access_lost")

  for (const audience of [{ memberIds: [foreign.owner.memberId] }, { memberIds: ["invalid"] }, { teamIds: ["invalid"] }]) {
    error(await create("PUT", `/v1/automations/${id}/sharing`, audience), 400, "automation_share_target_invalid")
  }
  const foreignTeam = await den.createTeam(foreign.owner, foreign.orgId, "Foreign audience", [])
  error(await create("PUT", `/v1/automations/${id}/sharing`, { teamIds: [foreignTeam] }), 400, "automation_share_target_invalid")
  status(await create("PUT", `/v1/automations/${id}/sharing`, {}), 200)
  assert.deepEqual(field(status(await receive("GET", "/v1/shared-automations"), 200).body, "items"), [])

  const teamId = await den.createTeam(owner, orgId, "Automation audience", [recipient.memberId])
  status(await create("PUT", `/v1/automations/${id}/sharing`, { teamIds: [teamId] }), 200)
  assert.equal(list(field(status(await receive("GET", "/v1/shared-automations"), 200).body, "items")).length, 1)
  assert.deepEqual(field(status(await other("GET", "/v1/shared-automations"), 200).body, "items"), [])
  status(await admin("DELETE", `/v1/teams/${teamId}`), 204)
  assert.deepEqual(status(await create("GET", `/v1/automations/${id}/sharing`), 200).body, { orgWide: false, memberIds: [], teamIds: [] })
  error(await create("PUT", `/v1/automations/${id}/sharing`, { orgWide: true }), 403, "automation_share_org_wide_forbidden")

  const adminSource = automationDetailSchema.parse(status(await admin("POST", "/v1/automations", { ...definition, workspaceId: null }), 201).body)
  const adminId = adminSource.automation.id
  status(await admin("PUT", `/v1/automations/${adminId}/sharing`, { orgWide: true, memberIds: [recipient.memberId] }), 200)
  assert.deepEqual(status(await admin("GET", `/v1/automations/${adminId}/sharing`), 200).body, { orgWide: true, memberIds: [], teamIds: [] })
  for (const caller of [create, receive, other]) {
    assert.equal(list(field(status(await caller("GET", "/v1/shared-automations"), 200).body, "items")).some((row) => row.id === adminId), true)
  }
  assert.deepEqual(field(status(await admin("GET", "/v1/shared-automations"), 200).body, "items"), [])
  status(await admin("DELETE", `/v1/automations/${adminId}`), 200)
  assert.deepEqual(field(status(await receive("GET", "/v1/shared-automations"), 200).body, "items"), [])
  error(await admin("PUT", `/v1/automations/${adminId}/sharing`, {}), 404, "automation_not_found")

  status(await create("PUT", `/v1/automations/${id}/sharing`, { memberIds: [recipient.memberId, outsider.memberId] }), 200)
  status(await admin("DELETE", `/v1/members/${outsider.memberId}`), 204)
  assert.deepEqual(field(status(await create("GET", `/v1/automations/${id}/sharing`), 200).body, "memberIds"), [recipient.memberId])
  status(await admin("DELETE", `/v1/members/${creator.memberId}`), 204)
  assert.deepEqual(field(status(await receive("GET", "/v1/shared-automations"), 200).body, "items"), [])
  status(await den.setFeature(orgId, "automationSharing", false), 200)
  assert.equal(field(status(await receive("GET", `/v1/automations/${copied.automation.id}`), 200).body, "automation", "state"), "inactive")
  assert.equal(field(status(await receive("POST", `/v1/automations/${copied.automation.id}/activate`, {}), 200).body, "automation", "state"), "active")
  status(await receive("POST", `/v1/automations/${copied.automation.id}/deactivate`, {}), 200)
})
