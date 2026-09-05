import { expect } from "vitest"
import {
  createCloudAutomation,
  createOrgConnection,
  denFetch,
  grantOpenWorkWebAccess,
  listWorkflows,
  patchAutomation,
  readAutomation,
  readAutomationRun,
  readAutomationRuns,
  readWorkflowDetail,
  runAutomationNow,
  runWorkflow,
  saveWorkflow,
} from "@openwork/behaviors"
import { mcpMock, needs, server, test } from "@openwork/testkit"

const requirements = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_SAVED_SCRIPT_AUTOMATIONS_E2E_TEST"],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value).slice(0, 500)}`)
  return value
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

async function eventually<T>(
  read: () => Promise<T>,
  accepted: (value: T) => boolean,
  label: string,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let latest: T | undefined
  while (Date.now() < deadline) {
    latest = await read()
    if (accepted(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(latest).slice(0, 1_000)}`)
}

let mcpRequestId = 0

async function agentRpc(
  apiUrl: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpRequestId, method, params }),
    signal: AbortSignal.timeout(180_000),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`MCP ${method} failed: HTTP ${response.status} ${raw.slice(0, 500)}`)
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"))
  if (!dataLine) throw new Error(`MCP ${method} returned no SSE data frame: ${raw.slice(0, 500)}`)
  const message = requireRecord(JSON.parse(dataLine.slice(5)), "MCP response")
  if (message.error) throw new Error(`MCP ${method} returned an error: ${JSON.stringify(message.error)}`)
  return requireRecord(message.result, `MCP ${method} result`)
}

test("a Code Mode result becomes a cloud Automation and a durable artifact result", { timeout: 1_200_000 }, async ({ evidence, place }) => {
  needs(requirements)
  await using den = await server({
    place,
    env: { DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "true" },
    org: { name: `Workflow Automation ${Date.now()}`, admin: { name: "Sarah" }, members: { colleague: { name: "Colleague" } } },
    mocks: { reports: mcpMock({ allowUnauthenticatedMcp: true }) },
  })
  const orgs = await denFetch(den.admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  })
  const orgRows = isRecord(orgs.body) ? records(orgs.body.orgs) : []
  const organizationId = String(orgRows[0]?.id ?? "")
  expect(organizationId).not.toBe("")

  // Cloud Automations require OpenWork Web access for the organization. The
  // launched Den seeds this admin into the platform-admin allowlist, so the
  // spec grants the audited complimentary entitlement inline.
  await grantOpenWorkWebAccess(
    den.admin,
    organizationId,
    "saved-script-automations spec exercises Cloud Automations",
  )

  // A connection found by chat must remain callable in a saved Workflow even
  // when it was added after the first search batch of 16 connections.
  for (let index = 0; index < 16; index += 1) {
    await createOrgConnection(den.admin, {
      name: `Earlier source ${index}`,
      url: den.mocks.reports.mcpUrl,
      authType: "none",
      credentialMode: "shared",
      access: { orgWide: true },
    })
  }
  const connection = await createOrgConnection(den.admin, {
    name: "Report source",
    url: den.mocks.reports.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  })
  const catalog = await denFetch(den.admin, `/v1/mcp-connections/${connection.id}/tools`, {
    headers: { authorization: `Bearer ${den.admin.token}` },
  })
  expect(catalog.response.ok, catalog.text).toBe(true)
  const catalogTools = isRecord(catalog.body) ? records(catalog.body.tools) : []
  expect(catalogTools.some((tool) => tool.name === "mock_echo")).toBe(true)

  const tokenResponse = await denFetch(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      "x-openwork-org-id": organizationId,
    },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  })
  expect(tokenResponse.response.ok, tokenResponse.text).toBe(true)
  const mcpToken = isRecord(tokenResponse.body) && typeof tokenResponse.body.token === "string"
    ? tokenResponse.body.token
    : ""
  expect(mcpToken).toMatch(/^ow_mcp_at_/)

  const stamp = Date.now()
  const scriptName = `Launch briefing ${stamp}`
  const firstMarker = `launch-now-${stamp}`
  const scheduledMarker = `launch-scheduled-${stamp}`
  const code = [
    "const result = await tools.den.getWorkers({})",
    "return { briefing: { topic: input.topic, workerCount: result.workers.length } }",
  ].join("\n")
  const inputSchema = {
    type: "object",
    properties: { topic: { type: "string" } },
    required: ["topic"],
    additionalProperties: false,
  }
  const outputSchema = {
    type: "object",
    properties: { briefing: {} },
    required: ["briefing"],
    additionalProperties: false,
  }

  const executed = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "execute_capability_script",
    arguments: { code, input: { topic: firstMarker } },
  })
  expect(executed.isError).not.toBe(true)
  expect(JSON.stringify(executed.content)).toContain(firstMarker)

  const savedResponse = await saveWorkflow(den.admin, {
    name: scriptName,
    description: "Builds a reusable launch briefing from the organization's worker roster.",
    code,
    currentInput: { topic: firstMarker },
    inputSchema,
    outputSchema,
  })
  expect(savedResponse.status, savedResponse.text).toBe(201)
  const saved = requireRecord(savedResponse.body, "saved Workflow")
  const pluginId = typeof saved.pluginId === "string" ? saved.pluginId : ""
  const configObjectId = typeof saved.configObjectId === "string" ? saved.configObjectId : ""
  const configObjectVersionId = typeof saved.configObjectVersionId === "string" ? saved.configObjectVersionId : ""
  expect(pluginId).not.toBe("")
  expect(configObjectId).not.toBe("")
  expect(configObjectVersionId).not.toBe("")
  evidence.recordAssertionEvidence(
    "A successful ad-hoc Code Mode result is promotable without retyping its procedure",
    "The exact successful code was saved as an immutable Workflow version using its recent receipt.",
    true,
  )

  const manualResult = await runWorkflow(den.admin, configObjectId, {
    pluginId,
    configObjectVersionId,
    input: { topic: firstMarker },
  })
  expect(manualResult.status).toBe("succeeded")
  expect(JSON.stringify(manualResult.value)).toContain(firstMarker)
  expect(String(manualResult.receiptId ?? "")).not.toBe("")
  evidence.recordAssertionEvidence(
    "The Workflow produces a validated artifact-ready result",
    "A direct run of the immutable version returned a schema-valid result and durable receipt.",
    true,
  )

  const appRequest = (session: typeof den.admin, path: string, init: RequestInit = {}) =>
    denFetch(session, path, { ...init, headers: { authorization: `Bearer ${session.token}` } })
  const draft = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "save_artifact_view",
    arguments: {
      configObjectId, title: "Briefing app",
      reactSource: "export default function Briefing({ data }) { return <article><h1>Briefing</h1><p>{data.briefing.topic}</p></article> }",
    },
  })
  expect(draft.isError).not.toBe(true)
  const view = requireRecord(requireRecord(draft.structuredContent, "draft result").view, "draft view")
  const revision = records(view.revisions)[0]
  expect(revision?.buildStatus).toBe("ready")
  expect(requireRecord(draft._meta, "draft host metadata")["openwork/appDraft"]).toEqual({
    appId: view.id, revisionId: revision?.id, receiptId: manualResult.receiptId, title: "Briefing app",
  })
  const appPath = `/v1/apps/${view.id}`
  const pinnedPath = `${appPath}?revisionId=${revision?.id}&receiptId=${manualResult.receiptId}`
  const draftApp = await appRequest(den.admin, pinnedPath)
  expect(draftApp.response.status, draftApp.text).toBe(200)
  expect(draftApp.body).toMatchObject({ onDashboard: false, view: { activeRevisionId: null }, payload: { data: { briefing: { topic: firstMarker } } } })
  expect((await appRequest(den.admin, "/v1/apps")).body).toMatchObject({ enabled: true, items: [] })
  expect((await appRequest(den.admin, `${appPath}/dashboard`, { method: "POST", body: JSON.stringify({ added: true }) })).response.status).toBe(404)
  const beforeSave = await readWorkflowDetail(den.admin, configObjectId)
  const beforeSnapshots = (await appRequest(den.admin, `/v1/workflows/${configObjectId}/snapshots`)).body
  const save = { revisionId: revision?.id, title: "Saved briefing", useInWorkflow: false, expectedActiveRevisionId: null }
  const savedApp = await appRequest(den.admin, `${appPath}/save`, { method: "POST", body: JSON.stringify(save) })
  expect(savedApp.response.status, savedApp.text).toBe(200)
  expect(savedApp.body).toMatchObject({ activeRevisionId: revision?.id, title: "Saved briefing", useInWorkflow: false })
  const reopened = await appRequest(den.admin, appPath)
  expect(reopened.response.status, reopened.text).toBe(200)
  expect(reopened.body).toMatchObject({ onDashboard: true, revision: { id: revision?.id }, view: { configObjectId } })
  const listedApps = await appRequest(den.admin, "/v1/apps")
  expect(listedApps.response.status, listedApps.text).toBe(200)
  expect(requireRecord(listedApps.body, "saved app list").items).toEqual([
    expect.objectContaining({ onDashboard: true, view: expect.objectContaining({ id: view.id, activeRevisionId: revision?.id, title: "Saved briefing" }) }),
  ])
  expect(requireRecord(reopened.body, "reopened app").html).toEqual(requireRecord(draftApp.body, "draft app").html)
  expect((await readWorkflowDetail(den.admin, configObjectId)).script.currentVersion).toEqual(beforeSave.script.currentVersion)
  expect((await appRequest(den.admin, `/v1/workflows/${configObjectId}/snapshots`)).body).toEqual(beforeSnapshots)
  expect((await appRequest(den.admin, `${appPath}/save`, { method: "POST", body: JSON.stringify({ ...save, title: "Stale overwrite" }) })).response.status).toBe(409)
  for (const added of [false, true]) {
    const placement = await appRequest(den.admin, `${appPath}/dashboard`, { method: "POST", body: JSON.stringify({ added }) })
    expect(placement.response.status, placement.text).toBe(200)
    expect((await appRequest(den.admin, appPath)).body).toMatchObject({ onDashboard: added, view: { activeRevisionId: revision?.id, title: "Saved briefing" } })
  }
  const colleague = den.members.colleague
  if (!colleague) throw new Error("Colleague was not provisioned")
  expect((await appRequest(colleague, appPath)).response.status).toBe(403)
  expect((await appRequest(colleague, `${appPath}/dashboard`, { method: "POST", body: JSON.stringify({ added: true }) })).response.status).toBe(403)
  expect((await appRequest(colleague, "/v1/apps")).body).toMatchObject({ items: [] })
  await appRequest(colleague, `${appPath}/dashboard`, { method: "POST", body: JSON.stringify({ added: false }) })
  expect((await appRequest(den.admin, appPath)).body).toMatchObject({ onDashboard: true })
  evidence.recordAssertionEvidence(
    "A draft app can be saved and reopened with personal placement without running, scheduling, or granting workflow access",
    "The real MCP builder produced a draft; the Apps routes retained its exact revision and HTML, saved personal placement without changing workflow version or snapshots, rejected stale saves and an ungranted member, and removed/re-added only the author's card.",
    true,
  )

  const scheduledAfter = new Date().toISOString()
  const automationResponse = await createCloudAutomation(den.admin, {
    name: `${scriptName} once`,
    schedule: { kind: "once", timezone: "UTC", at: Date.now() + 30_000 },
    action: {
      kind: "saved_script",
      script: { pluginId, configObjectId, configObjectVersionId },
      input: { topic: scheduledMarker },
    },
  })
  expect(automationResponse.status, automationResponse.text).toBe(201)
  const automationDetail = requireRecord(automationResponse.body, "Automation")
  const automation = requireRecord(automationDetail.automation, "Automation identity")
  const automationId = typeof automation.id === "string" ? automation.id : ""
  expect(automationId).not.toBe("")

  const scheduledRun = await eventually(async () => {
    const response = await readAutomationRuns(den.admin, automationId)
    expect(response.status >= 200 && response.status < 300, response.text).toBe(true)
    return isRecord(response.body)
      ? records(response.body.items).find((run) => run.trigger === "scheduled")
      : undefined
  }, (run) => run?.status === "succeeded", "scheduled Workflow Automation to succeed", 5 * 60_000)
  const scheduledRunId = typeof scheduledRun?.id === "string" ? scheduledRun.id : ""
  expect(scheduledRunId).not.toBe("")

  const scheduledExternalCalls = await den.mocks.reports.toolCalls({
    name: "mock_echo",
    sinceIso: scheduledAfter,
  })
  expect(scheduledExternalCalls).toHaveLength(0)

  const scheduledReceiptResponse = await readAutomationRun(den.admin, scheduledRunId)
  expect(scheduledReceiptResponse.status >= 200 && scheduledReceiptResponse.status < 300, scheduledReceiptResponse.text).toBe(true)
  const scheduledReceipt = requireRecord(scheduledReceiptResponse.body, "scheduled Automation receipt")
  const scheduledReceiptRun = requireRecord(scheduledReceipt.run, "scheduled Automation run")
  const scheduledReceiptAutomation = requireRecord(scheduledReceipt.automation, "scheduled Automation identity")
  const scheduledReceiptRevision = requireRecord(scheduledReceipt.revision, "scheduled Automation revision")
  const scheduledExecutionThread = requireRecord(scheduledReceiptRun.executionThread, "scheduled Automation execution thread")
  expect(JSON.stringify(scheduledReceipt)).toContain(scheduledMarker)
  expect(scheduledReceiptAutomation.id).toBe(automationId)
  expect(scheduledReceiptRevision.id).toBe(scheduledRun?.revisionId)
  expect(Array.isArray(scheduledReceipt.events)).toBe(true)
  expect(scheduledReceipt.events).toEqual([])
  expect(String(scheduledExecutionThread.id ?? "")).not.toBe("")
  expect(scheduledExecutionThread).toMatchObject({
    threadKind: "automation",
    executionLocation: "cloud",
    automationId,
    automationRunId: scheduledRunId,
    engineKind: "openwork-cloud-codemode-v1",
  })

  const toolList = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  const tools = records(toolList.tools)
  const renderTool = tools.find((candidate) => candidate.name === "render_workflow_artifact")
  const renderToolMeta = isRecord(renderTool?._meta) ? renderTool._meta : {}
  const modernUi = isRecord(renderToolMeta.ui) ? renderToolMeta.ui : {}
  expect(modernUi.resourceUri).toBe("ui://openwork/workflow-artifact/v1/view.html")
  expect(renderToolMeta["ui/resourceUri"]).toBe("ui://openwork/workflow-artifact/v1/view.html")

  const resourceList = await agentRpc(den.ref.apiUrl, mcpToken, "resources/list", {})
  const resources = records(resourceList.resources)
  const appResource = resources.find((candidate) => candidate.uri === "ui://openwork/workflow-artifact/v1/view.html")
  expect(appResource?.mimeType).toBe("text/html;profile=mcp-app")

  const resourceRead = await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", {
    uri: "ui://openwork/workflow-artifact/v1/view.html",
  })
  const resourceContents = records(resourceRead.contents)
  expect(resourceContents[0]?.mimeType).toBe("text/html;profile=mcp-app")
  expect(String(resourceContents[0]?.text ?? "")).toContain("ui/initialize")
  expect(String(resourceContents[0]?.text ?? "")).not.toContain("fetch(")

  const rendered = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "render_workflow_artifact",
    arguments: { configObjectId },
  })
  expect(rendered.isError).not.toBe(true)
  const structured = requireRecord(rendered.structuredContent, "Workflow Artifact structuredContent")
  const artifact = requireRecord(structured.artifact, "Workflow Artifact lineage")
  const fallback = records(rendered.content)
  expect(structured.schemaVersion).toBe("1")
  expect(artifact.configObjectId).toBe(configObjectId)
  expect(artifact.source).toBe("scheduled")
  expect(String(artifact.receiptId ?? "")).not.toBe("")
  expect(JSON.stringify(structured.data)).toContain(scheduledMarker)
  expect(String(fallback[0]?.text ?? "")).toContain(scheduledMarker)
  evidence.recordAssertionEvidence(
    "The latest Automation snapshot is portable as a standards-based MCP App",
    "The agent endpoint returns the scheduled result as versioned structuredContent and a Markdown fallback linked to a self-contained ui:// resource.",
    true,
  )

  const externalMarker = `launch-external-${stamp}`
  const discovered = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query: "Report source mock_echo", type: "mcp", limit: 20 },
  })
  expect(discovered.isError).not.toBe(true)
  const discoveryText = records(discovered.content).find((part) => part.type === "text")?.text
  if (typeof discoveryText !== "string") throw new Error("Capability search returned no text result")
  const matches = records(requireRecord(JSON.parse(discoveryText), "capability search").matches)
  const externalMatch = matches.find((match) => match.name === `mcp:${connection.id}:mock_echo`)
  expect(externalMatch?.scriptPath).toBe("tools.report_source.mock_echo")
  const batchTool = catalogTools.find((tool) => tool.name === "mock_batch")
  expect(batchTool).toBeDefined()
  expect(isRecord(batchTool?.annotations) ? batchTool.annotations.readOnlyHint : undefined).not.toBe(true)
  const externalCode = `await tools.report_source.mock_batch({ items: [{ text: input.topic }] }); return { briefing: await ${externalMatch?.scriptPath}({ text: input.topic }) }`
  const externalRunStartedAt = new Date().toISOString()
  const externalExecuted = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "execute_capability_script",
    arguments: { code: externalCode, input: { topic: externalMarker } },
  })
  expect(externalExecuted.isError).not.toBe(true)
  expect(JSON.stringify(externalExecuted.content)).toContain(externalMarker)
  const interactiveExternalCalls = await den.mocks.reports.toolCalls({
    name: "mock_echo",
    atLeast: 1,
    sinceIso: externalRunStartedAt,
    timeoutMs: 60_000,
  })
  expect(interactiveExternalCalls.filter((call) => call.args.text === externalMarker)).toHaveLength(1)

  const stringInputMarker = `launch-string-input-${stamp}`
  const stringInputStartedAt = new Date().toISOString()
  const stringInputExecuted = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "execute_capability_script",
    arguments: { code: externalCode, input: JSON.stringify({ topic: stringInputMarker }) },
  })
  expect(stringInputExecuted.isError).not.toBe(true)
  expect(JSON.stringify(stringInputExecuted.content)).toContain(stringInputMarker)
  const stringInputCalls = await den.mocks.reports.toolCalls({
    name: "mock_echo",
    atLeast: 1,
    sinceIso: stringInputStartedAt,
    timeoutMs: 60_000,
  })
  const matchingStringInputCalls = stringInputCalls.filter((call) => call.args.text === stringInputMarker)
  const stringInputCallsHaveText = stringInputCalls.every(
    (call) => typeof call.args.text === "string" && call.args.text.length > 0,
  )
  expect(matchingStringInputCalls).toHaveLength(1)
  expect(stringInputCallsHaveText).toBe(true)
  evidence.recordAssertionEvidence(
    "Script parameters survive JSON-string encoding from MCP clients",
    "A JSON-encoded `input` string is bound as an object, so `input.topic` reaches the provider instead of undefined.",
    matchingStringInputCalls.length === 1 && stringInputCallsHaveText,
  )

  const externalSavedResponse = await saveWorkflow(den.admin, {
    name: `${scriptName} external`,
    description: "Checks the unattended Cloud boundary for external MCP tools.",
    code: externalCode,
    currentInput: { topic: externalMarker },
    inputSchema,
    outputSchema,
  })
  expect(externalSavedResponse.status, externalSavedResponse.text).toBe(201)
  const externalSaved = requireRecord(externalSavedResponse.body, "external saved Workflow")
  const externalPluginId = typeof externalSaved.pluginId === "string" ? externalSaved.pluginId : ""
  const externalConfigObjectId = typeof externalSaved.configObjectId === "string" ? externalSaved.configObjectId : ""
  let externalConfigObjectVersionId = typeof externalSaved.configObjectVersionId === "string" ? externalSaved.configObjectVersionId : ""
  expect(externalPluginId).not.toBe("")
  expect(externalConfigObjectId).not.toBe("")
  expect(externalConfigObjectVersionId).not.toBe("")
  const graph = requireRecord(externalSaved.graph, "saved Workflow graph")
  const graphNodes = records(graph.nodes)
  expect(graph.parseError).toBeNull()
  expect(graphNodes.some((node) => node.kind === "tool" && node.scriptPath === "tools.report_source.mock_echo")).toBe(true)
  expect(graphNodes.find((node) => node.kind === "input")?.fields).toEqual(["topic"])
  expect(graphNodes.some((node) => node.kind === "return")).toBe(true)
  expect(String(externalSaved.mermaid ?? "")).toMatch(/^flowchart TD\n/)
  expect(String(externalSaved.mermaid ?? "")).toContain("report_source.mock_echo")

  const detail = await readWorkflowDetail(den.admin, externalConfigObjectId)
  const script = detail.script
  const currentVersion = requireRecord(script.currentVersion, "current version")
  expect(currentVersion.graph).toEqual(graph)
  evidence.recordAssertionEvidence(
    "A saved Workflow exposes a structural step graph for visual rendering",
    "The save response and the Workflow detail carry the same tool/input/return graph plus a Mermaid flowchart.",
    true,
  )

  const editedDraft = {
    name: `${scriptName} edited external`,
    description: "A manually refreshed report using an unclassified provider tool.",
    code: externalCode,
    exampleInput: { topic: externalMarker },
    inputSchema,
    outputSchema,
    requiredCapabilities: [
      { capabilityName: `mcp:${connection.id}:mock_batch`, scriptPath: "tools.report_source.mock_batch" },
      { capabilityName: `mcp:${connection.id}:mock_echo`, scriptPath: "tools.report_source.mock_echo" },
    ],
  }
  const testedDraft = await denFetch(den.admin, "/v1/workflows/test", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ ...editedDraft, configObjectId: externalConfigObjectId }),
  })
  expect(testedDraft.response.status, testedDraft.text).toBe(200)
  const testReceipt = requireRecord(testedDraft.body, "draft test receipt")
  const rejectedEdit = await denFetch(den.admin, `/v1/workflows/${externalConfigObjectId}/versions`, {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ ...editedDraft, code: `${externalCode}\n`, receiptId: testReceipt.receiptId }),
  })
  expect(rejectedEdit.response.status, rejectedEdit.text).toBe(400)
  expect(rejectedEdit.text).toContain("workflow_matching_test_receipt_required")
  const editedVersion = await denFetch(den.admin, `/v1/workflows/${externalConfigObjectId}/versions`, {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ ...editedDraft, receiptId: testReceipt.receiptId }),
  })
  expect(editedVersion.response.status, editedVersion.text).toBe(201)
  const editedDetail = requireRecord(editedVersion.body, "edited Workflow")
  const editedCurrentVersion = requireRecord(editedDetail.currentVersion, "edited current version")
  expect(typeof editedCurrentVersion.id).toBe("string")
  externalConfigObjectVersionId = String(editedCurrentVersion.id)
  evidence.recordAssertionEvidence(
    "A successful manual report can be saved and edited with an unclassified provider tool",
    "Both initial save and a tested new version succeed without granting unattended execution.",
    externalSavedResponse.status === 201 && editedVersion.response.status === 201,
  )

  const externalManualRun = await runWorkflow(den.admin, externalConfigObjectId, {
    pluginId: externalPluginId,
    configObjectVersionId: externalConfigObjectVersionId,
    input: { topic: externalMarker },
  })
  expect(externalManualRun.status).toBe("succeeded")

  const externalDraft = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "save_artifact_view",
    arguments: {
      configObjectId: externalConfigObjectId, title: "Report app",
      reactSource: "export default function Report({ data }) { return <article><h1>Report</h1><pre>{JSON.stringify(data.briefing)}</pre></article> }",
    },
  })
  expect(externalDraft.isError).not.toBe(true)
  const externalView = requireRecord(requireRecord(externalDraft.structuredContent, "external app draft").view, "external view")
  const externalRevision = records(externalView.revisions)[0]
  expect(externalRevision?.buildStatus).toBe("ready")
  const externalAppPath = `/v1/apps/${externalView.id}`
  const externalAppSaved = await appRequest(den.admin, `${externalAppPath}/save`, {
    method: "POST", body: JSON.stringify({ revisionId: externalRevision?.id, title: "Report app", useInWorkflow: false, expectedActiveRevisionId: null }),
  })
  expect(externalAppSaved.response.status, externalAppSaved.text).toBe(200)
  const refreshMarker = `launch-refreshed-${stamp}`
  const refreshedRun = await runWorkflow(den.admin, externalConfigObjectId, {
    pluginId: externalPluginId, configObjectVersionId: externalConfigObjectVersionId,
    input: { topic: refreshMarker },
  })
  expect(refreshedRun.status).toBe("succeeded")
  const refreshedApp = await appRequest(den.admin, externalAppPath)
  expect(refreshedApp.response.status, refreshedApp.text).toBe(200)
  expect(refreshedApp.body).toMatchObject({ onDashboard: true, view: { configObjectId: externalConfigObjectId } })
  expect(JSON.stringify(requireRecord(refreshedApp.body, "refreshed app").payload)).toContain(refreshMarker)
  expect(JSON.stringify(requireRecord(refreshedApp.body, "refreshed app").payload)).not.toContain(externalMarker)
  const forbiddenApp = await appRequest(colleague, externalAppPath)
  expect(forbiddenApp.response.status).toBe(403)
  expect(forbiddenApp.body).not.toHaveProperty("payload")
  expect(forbiddenApp.body).not.toHaveProperty("view")
  const unrelatedApp = await appRequest(den.admin, appPath)
  expect(JSON.stringify(unrelatedApp.body)).toContain(scheduledMarker)
  expect(JSON.stringify(unrelatedApp.body)).not.toContain(refreshMarker)
  evidence.recordAssertionEvidence(
    "A connection beyond the first 16 works from chat discovery through a saved and refreshed app",
    "Search returned the seventeenth connection's callable script path. Its procedure executed, saved, reran and produced an app whose latest payload changed on refresh; the unrelated app and colleague's access stayed unchanged.",
    true,
  )

  const latestDetail = await readWorkflowDetail(den.admin, externalConfigObjectId)
  const latestScript = latestDetail.script
  const latest = requireRecord(latestScript.latestSnapshot, "latest snapshot")
  const externalToolCallNames = records(latest.toolCalls).map((call) => call.name)
  expect(externalToolCallNames).toEqual(["report_source.mock_batch", "report_source.mock_echo"])

  const internalDetail = await readWorkflowDetail(den.admin, configObjectId)
  const internalScript = internalDetail.script
  const internalLatest = requireRecord(internalScript.latestSnapshot, "internal latest snapshot")
  const internalToolCallNames = records(internalLatest.toolCalls).map((call) => call.name)
  expect(internalToolCallNames).toEqual(["den.getWorkers"])
  evidence.recordAssertionEvidence(
    "Each Workflow run records the tool calls it made for step-level replay",
    "The latest snapshot lists both external tools for the external Workflow and only den.getWorkers for the internal one.",
    externalToolCallNames.length === 2
      && externalToolCallNames[0] === "report_source.mock_batch"
      && externalToolCallNames[1] === "report_source.mock_echo"
      && internalToolCallNames.length === 1
      && internalToolCallNames[0] === "den.getWorkers",
  )

  const searchCode = "const found = await tools.$codemode.search({ query: input.topic }); return { count: found.items.length }"
  const searchExecuted = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "execute_capability_script",
    arguments: { code: searchCode, input: { topic: "workers" } },
  })
  expect(searchExecuted.isError).not.toBe(true)

  const rejectedSearchWorkflow = await saveWorkflow(den.admin, {
    name: `${scriptName} search`,
    code: searchCode,
    currentInput: { topic: "workers" },
    inputSchema,
  })
  expect(rejectedSearchWorkflow.status, rejectedSearchWorkflow.text).toBe(400)
  const rejectedSearchBody = requireRecord(rejectedSearchWorkflow.body, "rejected search Workflow")
  expect(rejectedSearchBody.error).toBe("workflow_capability_unavailable")
  expect(String(rejectedSearchBody.capability ?? "")).toMatch(/\$codemode\.search$/)
  const rejectedSearchMessage = String(rejectedSearchBody.message ?? "")
  expect(rejectedSearchMessage).toContain("search_capabilities")

  const workflowList = await listWorkflows(den.admin)
  const searchWorkflowWasSaved = workflowList.items
    .some((item) => item.name === `${scriptName} search`)
  expect(searchWorkflowWasSaved).toBe(false)
  evidence.recordAssertionEvidence(
    "Saving a Workflow that depends on in-script search is rejected with a next step",
    rejectedSearchMessage,
    rejectedSearchWorkflow.status === 400
      && rejectedSearchBody.error === "workflow_capability_unavailable"
      && /\$codemode\.search$/.test(String(rejectedSearchBody.capability ?? ""))
      && rejectedSearchMessage.includes("search_capabilities")
      && !searchWorkflowWasSaved,
  )

  const externalAutomation = await patchAutomation(den.admin, automationId, {
    action: {
      kind: "saved_script",
      script: {
        pluginId: externalPluginId,
        configObjectId: externalConfigObjectId,
        configObjectVersionId: externalConfigObjectVersionId,
      },
      input: { topic: externalMarker },
    },
  })
  expect(externalAutomation.status >= 200 && externalAutomation.status < 300, externalAutomation.text).toBe(true)

  const unattendedRunStartedAt = new Date().toISOString()
  const failedRunResponse = await runAutomationNow(den.admin, automationId)
  expect(failedRunResponse.status, failedRunResponse.text).toBe(202)
  const queued = isRecord(failedRunResponse.body) ? requireRecord(failedRunResponse.body.run, "queued Automation run") : {}
  const failedRunId = typeof queued.id === "string" ? queued.id : ""
  expect(failedRunId).not.toBe("")

  const failedReceipt = await eventually(async () => {
    const response = await readAutomationRun(den.admin, failedRunId)
    expect(response.status >= 200 && response.status < 300, response.text).toBe(true)
    return requireRecord(response.body, "failed Automation receipt")
  }, (receipt) => isRecord(receipt.run)
    && ["failed", "skipped", "cancelled"].includes(String(receipt.run.status)), "external-capability run to finish")
  const failedReceiptRun = requireRecord(failedReceipt.run, "failed Automation run")
  expect(failedReceiptRun.status).toBe("failed")
  const failedRunError = requireRecord(failedReceiptRun.error, "failed Automation error")
  expect(String(failedRunError.message ?? "")).toContain("must be read-only and explicitly approved")

  const afterBoundaryRejection = await eventually(async () => {
    const response = await readAutomation(den.admin, automationId)
    expect(response.status >= 200 && response.status < 300, response.text).toBe(true)
    return requireRecord(response.body, "Automation after unattended boundary rejection")
  }, (detail) => isRecord(detail.automation) && detail.automation.state === "needs_attention", "Automation to need attention")
  expect(JSON.stringify(afterBoundaryRejection)).toContain(scheduledMarker)

  let unattendedExternalCalls = 0
  try {
    unattendedExternalCalls = (await den.mocks.reports.toolCalls({
      atLeast: 1,
      sinceIso: unattendedRunStartedAt,
      timeoutMs: 5_000,
    })).length
  } catch {
    unattendedExternalCalls = 0
  }
  expect(unattendedExternalCalls).toBe(0)
  evidence.recordAssertionEvidence(
    "Unattended Cloud rejects external MCP capability access before provider I/O and preserves the last good result",
    `Provider calls from the unattended run: ${unattendedExternalCalls}; the previous ${scheduledMarker} result remains durable.`,
    unattendedExternalCalls === 0 && JSON.stringify(afterBoundaryRejection).includes(scheduledMarker),
  )
})
