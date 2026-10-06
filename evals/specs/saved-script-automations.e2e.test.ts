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
import { needs, spec } from "@openwork/testkit"

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

const test = spec.world(async seed => {
  needs(requirements)
  const den = await seed.den({
    org: { name: `Workflow Automation ${Date.now()}`, admin: { name: "Sarah" }, members: { colleague: { name: "Colleague" } } },
    mocks: { reports: seed.mock({ allowUnauthenticatedMcp: true }) },
  })
  return { den }
}, { timeout: 1_200_000, resources: { surfaces: [], services: ["den", "mock"] } })

test("saved Workflows run manually, on schedule, and unattended with external tools (protocol-level)", async ({ world, evidence, step, probe }) => {
  const { den } = world
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

  await step("retired Workflow-bound saved apps answer as disabled for published desktops", async () => {
    const listed = await probe.api(den.admin, "/v1/apps")
    expect(listed.response.status, listed.text).toBe(200)
    expect(listed.body).toEqual({ enabled: false, sharingEnabled: false, items: [] })
    const opened = await probe.api(den.admin, "/v1/apps/app_missing")
    expect(opened.response.status).toBe(404)
    expect(opened.body).toEqual({ error: "artifact_view_not_found" })
    for (const path of ["/v1/apps/app_missing/save", "/v1/artifact-views/app_missing/retire"]) {
      const absent = await denFetch(den.admin, path, { method: "POST", headers: { authorization: `Bearer ${den.admin.token}` } })
      expect(absent.response.status, path).toBe(404)
      expect(absent.body).toEqual({ error: "artifact_view_not_found" })
    }
    const detail = await probe.api(den.admin, `/v1/workflows/${configObjectId}`)
    expect(detail.response.status, detail.text).toBe(200)
    expect(detail.body).toMatchObject({ workflow: { viewState: "default", activeViewTitle: null }, views: [] })
    const tools = records((await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})).tools)
    expect(tools.map((tool) => tool.name).filter((name) => typeof name === "string" && /artifact_view|render_artifact_|preview_artifact_/.test(name))).toEqual([])
    evidence.recordAssertionEvidence(
      "Saved-app routes keep the disabled responses published desktops expect, and no saved-app MCP tools remain",
      "GET /v1/apps returned enabled:false with no items; open, save and retire returned 404 artifact_view_not_found; the Workflow detail had the default view state and no views; tools/list had no artifact view tools.",
      true,
    )
  })

  await step("the owner's saved Workflow produces a durable validated manual result", async () => {
    const result = await runWorkflow(den.admin, configObjectId, {
      pluginId,
      configObjectVersionId,
      input: { topic: firstMarker },
    })
    expect(result.status).toBe("succeeded")
    expect(JSON.stringify(result.value)).toContain(firstMarker)
    expect(String(result.receiptId ?? "")).not.toBe("")
    evidence.recordAssertionEvidence(
      "The Workflow produces a validated artifact-ready result",
      JSON.stringify({ status: result.status, value: result.value, receiptId: result.receiptId }),
      true,
    )
  })

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

  const externalInputSchema = {
    anyOf: [inputSchema, {
      type: "object",
      properties: { runtime: {
        type: "object",
        properties: Object.fromEntries(["now", "today", "timeZone", "dayStart", "dayEnd"].map(key => [key, { type: "string" }])),
        required: ["now", "today", "timeZone", "dayStart", "dayEnd"],
        additionalProperties: false,
      } },
      required: ["runtime"],
      additionalProperties: false,
    }],
  }
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
    description: "Runs external MCP tools on demand, live, and unattended.",
    code: externalCode,
    currentInput: { topic: externalMarker },
    inputSchema: externalInputSchema,
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
    inputSchema: externalInputSchema,
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
    "Both initial save and a tested new version succeed.",
    externalSavedResponse.status === 201 && editedVersion.response.status === 201,
  )

  const externalManualRun = await runWorkflow(den.admin, externalConfigObjectId, {
    pluginId: externalPluginId,
    configObjectVersionId: externalConfigObjectVersionId,
    input: { topic: externalMarker },
  })
  expect(externalManualRun.status).toBe("succeeded")
  const externalManualDetail = await readWorkflowDetail(den.admin, externalConfigObjectId)
  const externalManualSnapshot = requireRecord(externalManualDetail.script.latestSnapshot, "external manual snapshot")
  const externalToolCallNames = records(externalManualSnapshot.toolCalls).map((call) => call.name)
  expect(externalToolCallNames).toEqual(["report_source.mock_batch", "report_source.mock_echo"])

  const refreshMarker = `launch-refreshed-${stamp}`
  await step("an explicit manual Workflow refresh still works", async () => {
    const beforeRefresh = new Date().toISOString()
    const refreshed = await runWorkflow(den.admin, externalConfigObjectId, {
      pluginId: externalPluginId, configObjectVersionId: externalConfigObjectVersionId,
      input: { topic: refreshMarker },
    })
    expect(refreshed.status).toBe("succeeded")
    expect(JSON.stringify(refreshed.value)).toContain(refreshMarker)
    expect(JSON.stringify(refreshed.value)).not.toContain(externalMarker)
    expect(refreshed.receiptId).not.toBe(externalManualRun.receiptId)
    const calls = await den.mocks.reports.toolCalls({ sinceIso: beforeRefresh })
    expect(calls.map(call => call.name)).toEqual(["mock_batch", "mock_echo"])
    evidence.recordAssertionEvidence("Manual refresh remains authorized", JSON.stringify({ status: refreshed.status, receiptId: refreshed.receiptId, value: refreshed.value }), true)
  })

  evidence.recordAssertionEvidence(
    "A connection beyond the first 16 works from discovery through a saved manual Workflow",
    "Search returned the seventeenth connection's callable script path and its procedure executed, saved, and recorded both provider calls.",
    true,
  )

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
  const unattendedRunResponse = await runAutomationNow(den.admin, automationId)
  expect(unattendedRunResponse.status, unattendedRunResponse.text).toBe(202)
  const queued = isRecord(unattendedRunResponse.body) ? requireRecord(unattendedRunResponse.body.run, "queued Automation run") : {}
  const unattendedRunId = typeof queued.id === "string" ? queued.id : ""
  expect(unattendedRunId).not.toBe("")

  const unattendedReceipt = await eventually(async () => {
    const response = await readAutomationRun(den.admin, unattendedRunId)
    expect(response.status >= 200 && response.status < 300, response.text).toBe(true)
    return requireRecord(response.body, "external Automation receipt")
  }, (receipt) => isRecord(receipt.run)
    && ["succeeded", "failed", "skipped", "cancelled"].includes(String(receipt.run.status)), "external-capability run to finish")
  const unattendedRun = requireRecord(unattendedReceipt.run, "external Automation run")
  expect(unattendedRun.status, JSON.stringify(unattendedRun.error ?? null)).toBe("succeeded")

  const unattendedExternalCalls = await den.mocks.reports.toolCalls({ sinceIso: unattendedRunStartedAt })
  expect(unattendedExternalCalls.map(call => call.name)).toEqual(["mock_batch", "mock_echo"])
  expect(unattendedExternalCalls.some(call => call.args.text === externalMarker)).toBe(true)
  evidence.recordAssertionEvidence(
    "Unattended Cloud runs a Workflow that calls external MCP tools",
    `Provider calls from the unattended run: ${unattendedExternalCalls.map(call => call.name).join(", ")}`,
    unattendedRun.status === "succeeded" && unattendedExternalCalls.length === 2,
  )
})
