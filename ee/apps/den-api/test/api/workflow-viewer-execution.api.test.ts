import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())

test("manual Workflow availability matches existing REST and MCP viewer execution without owner fallback", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Workflow owner"), "Workflow permission regression")
  const recipient = await den.newMember(owner, orgId, "Workflow recipient")
  const outsider = await den.newMember(owner, orgId, "Workflow outsider")
  const ownerApi = den.as(owner, orgId)
  const recipientApi = den.as(recipient, orgId)
  const outsiderApi = den.as(outsider, orgId)
  const ownerToken = await den.mintMcpToken(owner, orgId)
  const recipientToken = await den.mintMcpToken(recipient, orgId)
  const outsiderToken = await den.mintMcpToken(outsider, orgId)
  assert.notEqual(ownerToken, recipientToken)

  // Synthetic permission fixture, not a workshop business task or model execution.
  const inputSchema = { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false }
  const code = "return {marker: input.marker}"
  const tested = await den.callMcpTool(ownerToken, "execute_capability_script", { code, input: { marker: "authoring-fixture" }, inputSchema })
  assert.equal(tested.isError, false, tested.raw.slice(0, 400))
  const receiptId = text(field(tested.structured, "metadata", "receiptId"), "authoring receipt")
  const saved = await ownerApi("POST", "/v1/workflows", { name: "Permission fixture", receiptId, inputSchema, currentInput: { marker: "authoring-fixture" } })
  assert.equal(saved.status, 201, summary(saved))
  const workflowId = text(field(saved.body, "configObjectId"), "workflow id")
  const pluginId = text(field(saved.body, "pluginId"), "plugin id")
  const versionId = text(field(saved.body, "configObjectVersionId"), "version id")
  const capability = `plugin:${pluginId}:${workflowId}`
  const runBody = (marker: string) => ({ pluginId, configObjectVersionId: versionId, input: { marker } })

  const ownerDetail = await ownerApi("GET", `/v1/workflows/${workflowId}`)
  assert.equal(ownerDetail.status, 200, summary(ownerDetail))
  assert.equal(field(ownerDetail.body, "script", "canRun"), true)
  assert.equal(field(ownerDetail.body, "script", "canManage"), true)
  const ownerRun = await ownerApi("POST", `/v1/workflows/${workflowId}/run`, runBody("owner-manual"))
  assert.equal(ownerRun.status, 200, summary(ownerRun))

  const beforeShare = await recipientApi("GET", `/v1/workflows/${workflowId}`)
  assert.ok([403, 404].includes(beforeShare.status), summary(beforeShare))
  const granted = await ownerApi("POST", `/v1/plugins/${pluginId}/access`, { orgMembershipId: recipient.memberId, role: "viewer" })
  assert.equal(granted.status, 201, summary(granted))

  // Exercise both already-authorized paths before checking the broken availability projection.
  const recipientRun = await recipientApi("POST", `/v1/workflows/${workflowId}/run`, runBody("recipient-rest"))
  assert.equal(recipientRun.status, 200, summary(recipientRun))
  assert.equal(field(recipientRun.body, "value", "marker"), "recipient-rest")
  const recipientMcp = await den.callMcpTool(recipientToken, "execute_capability", { name: capability, body: { marker: "recipient-mcp" } })
  assert.equal(recipientMcp.isError, false, recipientMcp.raw.slice(0, 400))
  assert.equal(field(recipientMcp.body, "value", "marker"), "recipient-mcp")

  // The durable receipts identify the recipient, not the owner's token or an owner rerun.
  const ownerReceipt = text(field(ownerRun.body, "receiptId"), "owner receipt")
  const restReceipt = text(field(recipientRun.body, "receiptId"), "recipient REST receipt")
  const mcpReceipt = text(field(recipientMcp.body, "receiptId"), "recipient MCP receipt")
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("Workflow permission regression needs disposable MySQL")
  const [rows] = await client.execute("SELECT id, org_membership_id, config_object_id, config_object_version_id FROM workflow_run WHERE id IN (?, ?, ?)", [ownerReceipt, restReceipt, mcpReceipt])
  const receipts = list(rows)
  assert.equal(receipts.length, 3)
  for (const [id, actor] of [[ownerReceipt, owner.memberId], [restReceipt, recipient.memberId], [mcpReceipt, recipient.memberId]]) {
    const row = receipts.find((receipt) => receipt.id === id)
    assert.equal(row?.org_membership_id, actor)
    assert.equal(row?.config_object_id, workflowId)
    assert.equal(row?.config_object_version_id, versionId)
  }

  const outsiderList = await outsiderApi("GET", "/v1/workflows")
  assert.equal(outsiderList.status, 200, summary(outsiderList))
  assert.equal(list(field(outsiderList.body, "items")).some((item) => item.configObjectId === workflowId), false)
  for (const path of [`/v1/workflows/${workflowId}`, `/v1/workflows/${workflowId}/snapshots`]) {
    const denied = await outsiderApi("GET", path)
    assert.ok([403, 404].includes(denied.status), summary(denied))
  }
  const outsiderRun = await outsiderApi("POST", `/v1/workflows/${workflowId}/run`, runBody("outsider-denied"))
  assert.equal(outsiderRun.status, 400, summary(outsiderRun))
  assert.equal(field(outsiderRun.body, "error"), "forbidden")
  const outsiderMcp = await den.callMcpTool(outsiderToken, "execute_capability", { name: capability, body: { marker: "outsider-denied" } })
  assert.equal(outsiderMcp.isError, true)
  assert.equal(field(outsiderMcp.body, "error"), "forbidden")
  const reshare = await recipientApi("POST", `/v1/plugins/${pluginId}/access`, { orgMembershipId: outsider.memberId, role: "viewer" })
  assert.equal(reshare.status, 403, summary(reshare))

  // Manual run availability does not grant scheduled execution. Exercise the
  // existing action authorization directly; no Cloud worker or schedule is created.
  const { validateWorkflowAutomationAction } = await import("../../src/workflows.js")
  const scheduledAction = { kind: "saved_script", script: { pluginId, configObjectId: workflowId, configObjectVersionId: versionId }, input: { marker: "schedule-permission-only" } } satisfies Parameters<typeof validateWorkflowAutomationAction>[0]["action"]
  await validateWorkflowAutomationAction({ organizationId: orgId, ownerMemberId: owner.memberId, action: scheduledAction })
  for (const memberId of [recipient.memberId, outsider.memberId]) {
    await assert.rejects(validateWorkflowAutomationAction({ organizationId: orgId, ownerMemberId: memberId, action: scheduledAction }), /automation_saved_script_forbidden/)
  }

  const recipientDetail = await recipientApi("GET", `/v1/workflows/${workflowId}`)
  assert.equal(recipientDetail.status, 200, summary(recipientDetail))
  assert.equal(field(recipientDetail.body, "workflow", "role"), "viewer")
  assert.equal(field(recipientDetail.body, "script", "canManage"), false)
  assert.equal(field(recipientDetail.body, "script", "currentVersion", "code"), null)
  assert.equal(field(recipientDetail.body, "script", "canRun"), true, "A covering viewer grant already permits REST/MCP manual execution under the recipient's identity")
})
