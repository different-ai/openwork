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
    env: { DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "true" },
    org: { name: `Workflow Automation ${Date.now()}`, admin: { name: "Sarah" }, members: { colleague: { name: "Colleague" } } },
    mocks: { reports: seed.mock({ allowUnauthenticatedMcp: true }) },
  })
  return { den }
}, { timeout: 1_200_000, resources: { surfaces: [], services: ["den", "mock"] } })

test("an owner saves and reopens a snapshot app while unsafe external live data remains blocked (protocol-level)", async ({ world, evidence, step }) => {
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

  const appCode = "return { briefing: { topic: input.topic } }"
  const appExecuted = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "execute_capability_script",
    arguments: { code: appCode, input: { topic: firstMarker }, inputSchema, outputSchema },
  })
  expect(appExecuted.isError).not.toBe(true)
  expect(JSON.stringify(appExecuted.content)).toContain(firstMarker)
  const appSavedResponse = await saveWorkflow(den.admin, {
    name: `${scriptName} snapshot app`,
    code: appCode,
    currentInput: { topic: firstMarker },
    inputSchema,
    outputSchema,
  })
  expect(appSavedResponse.status, appSavedResponse.text).toBe(201)
  const appSaved = requireRecord(appSavedResponse.body, "saved app Workflow")
  const appPluginId = typeof appSaved.pluginId === "string" ? appSaved.pluginId : ""
  const appConfigObjectId = typeof appSaved.configObjectId === "string" ? appSaved.configObjectId : ""
  const appConfigObjectVersionId = typeof appSaved.configObjectVersionId === "string" ? appSaved.configObjectVersionId : ""
  expect(appPluginId).not.toBe("")
  expect(appConfigObjectId).not.toBe("")
  expect(appConfigObjectId).not.toBe(configObjectId)
  expect(appConfigObjectVersionId).not.toBe("")
  const appWorkflow = await readWorkflowDetail(den.admin, appConfigObjectId)
  expect(requireRecord(appWorkflow.script.currentVersion, "app Workflow version").requiredCapabilities).toEqual([])
  expect(appWorkflow.script.latestSuccessfulSnapshot).toBeNull()

  const initialDraftSource = "export default function Briefing({ data }) { return <article><h1>Briefing</h1><p>{data.briefing.topic}</p></article> }"
  const emptyDraft = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "save_artifact_view",
    arguments: { configObjectId: appConfigObjectId, dataMode: "snapshot", title: "Briefing app", reactSource: initialDraftSource },
  })
  expect(emptyDraft.isError).toBe(true)
  expect(emptyDraft._meta).toBeUndefined()
  expect(emptyDraft.structuredContent).toBeUndefined()
  const emptyText = records(emptyDraft.content)[0]?.text
  if (typeof emptyText !== "string") throw new Error("Missing preview failure result")
  const emptyFailure = requireRecord(JSON.parse(emptyText), "empty preview failure")
  expect(emptyFailure.error).toBe("artifact_view_preview_unavailable")
  expect(emptyFailure.reason).toBe("workflow_snapshot_not_found")
  expect(emptyFailure.message).toContain("Run the current saved Workflow version")
  expect(emptyFailure.configObjectId).toBe(appConfigObjectId)
  expect(emptyFailure.viewRevisionId).toBeTypeOf("string")
  const emptyView = { id: emptyFailure.artifactViewId }
  expect(emptyView.id).toBeTypeOf("string")
  const beforeExplicitRun = await readWorkflowDetail(den.admin, appConfigObjectId)
  expect(beforeExplicitRun.script.latestSuccessfulSnapshot).toBeNull()
  evidence.recordAssertionEvidence(
    "Legacy draft readiness requires a readable saved Workflow result",
    "The builder returned artifact_view_preview_unavailable with the compiled revision identity, without ready metadata, activation, result data, or implicit snapshot Workflow execution.",
    true,
  )

  const manualResult = await step("the owner's saved Workflow produces a durable validated manual result", async () => {
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
    return result
  })

  const appResult = await runWorkflow(den.admin, appConfigObjectId, {
    pluginId: appPluginId,
    configObjectVersionId: appConfigObjectVersionId,
    input: { topic: firstMarker },
  })
  expect(appResult.status).toBe("succeeded")
  expect(appResult.value).toEqual({ briefing: { topic: firstMarker } })
  expect(String(appResult.receiptId ?? "")).not.toBe("")
  expect(appResult.receiptId).not.toBe(manualResult.receiptId)
  const beforePreview = await readWorkflowDetail(den.admin, appConfigObjectId)
  const appRequest = (session: typeof den.admin, path: string, init: RequestInit = {}) =>
    denFetch(session, path, { ...init, headers: { authorization: `Bearer ${session.token}` } })
  const beforePreviewSnapshots = (await appRequest(den.admin, `/v1/workflows/${appConfigObjectId}/snapshots`)).body
  const draft = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "save_artifact_view",
    arguments: {
      artifactViewId: emptyView.id, configObjectId: appConfigObjectId, dataMode: "snapshot", title: "Briefing app",
      reactSource: initialDraftSource,
    },
  })
  expect(draft.isError).not.toBe(true)
  const view = requireRecord(requireRecord(draft.structuredContent, "draft result").view, "draft view")
  expect(view.id).toBe(emptyView.id)
  expect(view).toMatchObject({ configObjectId: appConfigObjectId, dataMode: "snapshot" })
  const revision = records(view.revisions)[0]
  expect(revision?.buildStatus).toBe("ready")
  expect(revision?.resourceUri).toBeTypeOf("string")
  expect(revision?.id).toBeTypeOf("string")
  expect(draft._meta).toEqual({ "openwork/appDraft": { appId: view.id, revisionId: revision?.id, receiptId: appResult.receiptId, title: "Briefing app" } })
  expect(JSON.stringify(draft.content)).toContain("Saved immutable view revision")
  expect(view.activeRevisionId).toBeNull()
  const previewToolName = `preview_artifact_${view.id}`
  expect(JSON.stringify(draft.content)).toContain(previewToolName)
  const previewTools = records((await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})).tools)
  const previewTool = previewTools.find((tool) => tool.name === previewToolName)
  expect(previewTool).toBeDefined()
  expect(previewTool?._meta).toMatchObject({ ui: { resourceUri: revision?.resourceUri } })
  expect(previewTools.find((tool) => tool.name === "save_artifact_view")?._meta).toBeUndefined()
  const previewUri = requireRecord(requireRecord(previewTool?._meta, "preview tool metadata").ui, "preview UI metadata").resourceUri
  const previewResource = await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: previewUri })
  const previewContent = records(previewResource.contents)[0]
  expect(previewContent).toMatchObject({ uri: revision?.resourceUri, mimeType: "text/html;profile=mcp-app" })
  expect(previewContent?.text).toBeTypeOf("string")
  expect(previewContent?._meta).toMatchObject({ resourceDigest: revision?.resourceDigest })
  expect(previewResource).not.toHaveProperty("_meta.openwork/appDraft")
  const preview = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: previewToolName,
    arguments: { receiptId: appResult.receiptId },
  })
  expect(preview.isError).not.toBe(true)
  expect(preview.structuredContent).toMatchObject({
    artifact: { configObjectId: appConfigObjectId, receiptId: appResult.receiptId },
    data: appResult.value,
  })
  expect(preview._meta).toMatchObject({ artifactViewId: view.id, viewRevisionId: revision?.id })
  expect(preview).not.toHaveProperty("_meta.openwork/appDraft")
  expect((await readWorkflowDetail(den.admin, appConfigObjectId)).script.latestSuccessfulSnapshot).toEqual(
    beforePreview.script.latestSuccessfulSnapshot,
  )
  const appPath = `/v1/apps/${view.id}`
  const pinnedPath = `${appPath}?revisionId=${revision?.id}&receiptId=${appResult.receiptId}`
  const draftApp = await appRequest(den.admin, pinnedPath)
  expect(draftApp.response.status, draftApp.text).toBe(200)
  expect(requireRecord(draftApp.body, "draft app preview").html).toBe(previewContent?.text)
  expect(draftApp.body).toMatchObject({
    onDashboard: false,
    view: { activeRevisionId: null, configObjectId: appConfigObjectId, dataMode: "snapshot" },
    payload: { artifact: { configObjectId: appConfigObjectId, receiptId: appResult.receiptId }, data: appResult.value },
  })
  expect((await appRequest(den.admin, "/v1/apps")).body).toMatchObject({ enabled: true, items: [] })
  expect((await appRequest(den.admin, `${appPath}/dashboard`, { method: "POST", body: JSON.stringify({ added: true }) })).response.status).toBe(404)
  const beforeSave = await readWorkflowDetail(den.admin, appConfigObjectId)
  const beforeSnapshots = (await appRequest(den.admin, `/v1/workflows/${appConfigObjectId}/snapshots`)).body
  expect(beforeSnapshots).toEqual(beforePreviewSnapshots)
  const save = { revisionId: revision?.id, title: "Saved briefing", useInWorkflow: false, expectedActiveRevisionId: null }
  const colleague = den.members.colleague
  if (!colleague) throw new Error("Colleague was not provisioned")
  await step("the owner saves and reopens the exact snapshot; stale saves and an ungranted colleague cannot change it", async () => {
    const savedApp = await appRequest(den.admin, `${appPath}/save`, { method: "POST", body: JSON.stringify(save) })
    expect(savedApp.response.status, savedApp.text).toBe(200)
    expect(savedApp.body).toMatchObject({ activeRevisionId: revision?.id, title: "Saved briefing", useInWorkflow: false })
    const reopened = await appRequest(den.admin, appPath)
    expect(reopened.response.status, reopened.text).toBe(200)
    expect(reopened.body).toMatchObject({
      onDashboard: true, revision: { id: revision?.id }, view: { configObjectId: appConfigObjectId },
      payload: { artifact: { configObjectId: appConfigObjectId, receiptId: appResult.receiptId }, data: appResult.value },
    })
    const listedApps = await appRequest(den.admin, "/v1/apps")
    expect(listedApps.response.status, listedApps.text).toBe(200)
    expect(requireRecord(listedApps.body, "saved app list").items).toEqual([
      expect.objectContaining({ onDashboard: true, view: expect.objectContaining({ id: view.id, activeRevisionId: revision?.id, title: "Saved briefing" }) }),
    ])
    expect(requireRecord(reopened.body, "reopened app").html).toEqual(requireRecord(draftApp.body, "draft app").html)
    expect((await readWorkflowDetail(den.admin, appConfigObjectId)).script.currentVersion).toEqual(beforeSave.script.currentVersion)
    expect((await appRequest(den.admin, `/v1/workflows/${appConfigObjectId}/snapshots`)).body).toEqual(beforeSnapshots)
    expect((await appRequest(den.admin, `${appPath}/save`, { method: "POST", body: JSON.stringify({ ...save, title: "Stale overwrite" }) })).response.status).toBe(409)
    for (const added of [false, true]) {
      const placement = await appRequest(den.admin, `${appPath}/dashboard`, { method: "POST", body: JSON.stringify({ added }) })
      expect(placement.response.status, placement.text).toBe(200)
      expect((await appRequest(den.admin, appPath)).body).toMatchObject({ onDashboard: added, view: { activeRevisionId: revision?.id, title: "Saved briefing" } })
    }
    expect((await appRequest(colleague, appPath)).response.status).toBe(403)
    expect((await appRequest(colleague, `${appPath}/dashboard`, { method: "POST", body: JSON.stringify({ added: true }) })).response.status).toBe(403)
    expect((await appRequest(colleague, "/v1/apps")).body).toMatchObject({ items: [] })
    await appRequest(colleague, `${appPath}/dashboard`, { method: "POST", body: JSON.stringify({ added: false }) })
    expect((await appRequest(den.admin, appPath)).body).toMatchObject({ onDashboard: true })
    evidence.recordAssertionEvidence(
      "A draft app can be saved and reopened with personal placement without running, scheduling, or granting workflow access",
      "The real MCP builder retained exact openwork/appDraft revision and receipt metadata for released clients; modern-client suppression is independent of this backend contract. The advertised preview tool's standard UI metadata resolved to the same immutable HTML served by the explicitly requested Apps preview path. The Apps routes retained its exact revision and HTML, saved personal placement without changing workflow version or snapshots, rejected stale saves and an ungranted member, and removed/re-added only the author's card.",
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
    description: "Checks the unattended Cloud boundary for external MCP tools.",
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
    "Both initial save and a tested new version succeed without granting unattended execution.",
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

  await step("an unclassified external Workflow cannot expose live data or evade the boundary through snapshot mode", async () => {
    const callsBeforePreview = await den.mocks.reports.toolCalls()
    const appsBeforePreview = (await appRequest(den.admin, "/v1/apps")).body
    const externalDraft = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
      name: "save_artifact_view",
      arguments: {
        configObjectId: externalConfigObjectId, dataMode: "live", title: "Report app",
        reactSource: "export default function Report({ data }) { return <article><h1>Report</h1><pre>{JSON.stringify(data.briefing)}</pre></article> }",
      },
    })
    expect(externalDraft.isError).toBe(true)
    expect(externalDraft._meta).toBeUndefined()
    expect(externalDraft.structuredContent).toBeUndefined()
    const failureText = records(externalDraft.content).find(part => part.type === "text")?.text
    if (typeof failureText !== "string") throw new Error("External app rejection has no explanation")
    const failure = requireRecord(JSON.parse(failureText), "external live preview rejection")
    expect(failure).toMatchObject({ error: "artifact_view_preview_unavailable", reason: "capability_unavailable", configObjectId: externalConfigObjectId })
    expect(failure.detail).toBe("Live apps may only call current Den-authorized read-only capabilities.")
    expect(failure.artifactViewId).toBeTypeOf("string")
    expect(failure.viewRevisionId).toBeTypeOf("string")
    expect(await den.mocks.reports.toolCalls()).toEqual(callsBeforePreview)
    expect((await appRequest(den.admin, "/v1/apps")).body).toEqual(appsBeforePreview)
    const blockedPreview = await appRequest(den.admin, `/v1/apps/${failure.artifactViewId}?revisionId=${failure.viewRevisionId}`)
    expect(blockedPreview.response.status, blockedPreview.text).toBe(200)
    expect(blockedPreview.body).toMatchObject({ onDashboard: false, html: null, payload: null,
      runError: { error: "capability_unavailable", providerCallAttempted: false },
    })
    const forbiddenApp = await appRequest(colleague, `/v1/apps/${failure.artifactViewId}`)
    expect(forbiddenApp.response.status).toBe(403)
    expect(forbiddenApp.body).not.toHaveProperty("payload")
    expect(forbiddenApp.body).not.toHaveProperty("view")
    const snapshotEscape = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
      name: "save_artifact_view",
      arguments: { configObjectId: externalConfigObjectId, dataMode: "snapshot", title: "Report snapshot", reactSource: initialDraftSource },
    })
    expect(snapshotEscape.isError).toBe(true)
    expect(JSON.stringify(snapshotEscape.content)).toContain("artifact_view_snapshot_personal_data_denied")
    expect(snapshotEscape._meta).toBeUndefined()
    expect(snapshotEscape.structuredContent).toBeUndefined()
    expect(await den.mocks.reports.toolCalls()).toEqual(callsBeforePreview)
    expect((await readWorkflowDetail(den.admin, externalConfigObjectId)).script.latestSuccessfulSnapshot).toEqual(externalManualDetail.script.latestSuccessfulSnapshot)
    evidence.recordAssertionEvidence("Unsafe external app data is rejected before provider I/O", failureText, true)
  })

  const refreshMarker = `launch-refreshed-${stamp}`
  await step("rejecting live app access still permits an explicit manual Workflow refresh", async () => {
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

  const unrelatedApp = await appRequest(den.admin, appPath)
  expect(unrelatedApp.body).toMatchObject({
    view: { configObjectId: appConfigObjectId },
    payload: { artifact: { receiptId: appResult.receiptId }, data: appResult.value },
  })
  expect(JSON.stringify(unrelatedApp.body)).not.toContain(scheduledMarker)
  expect(JSON.stringify(unrelatedApp.body)).not.toContain(externalMarker)
  expect(JSON.stringify(unrelatedApp.body)).not.toContain(refreshMarker)
  evidence.recordAssertionEvidence(
    "A connection beyond the first 16 works from discovery through a saved manual Workflow",
    "Search returned the seventeenth connection's callable script path and its procedure executed, saved, and recorded both provider calls while the unrelated snapshot app stayed unchanged.",
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

  const unattendedExternalCalls = (await den.mocks.reports.toolCalls({ sinceIso: unattendedRunStartedAt })).length
  expect(unattendedExternalCalls).toBe(0)
  evidence.recordAssertionEvidence(
    "Unattended Cloud rejects external MCP capability access before provider I/O and preserves the last good result",
    `Provider calls from the unattended run: ${unattendedExternalCalls}; the previous ${scheduledMarker} result remains durable.`,
    unattendedExternalCalls === 0 && JSON.stringify(afterBoundaryRejection).includes(scheduledMarker),
  )
})
