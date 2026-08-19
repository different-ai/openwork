import { expect } from "vitest"
import { needs, server, test } from "@openwork/testkit"
import { denFetch, evalIn, waitFor } from "@openwork/behaviors"
import type { DenSession } from "@openwork/behaviors"
import { navigate } from "@openwork/cdp"
import { chrome } from "@openwork/hosts"

const requirements = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_GENERATED_ARTIFACT_VIEWS_E2E_TEST"],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${String(JSON.stringify(value)).slice(0, 500)}`)
  return value
}

let requestId = 0

async function agentRpc(apiUrl: string, token: string, method: string, params: Record<string, unknown>) {
  const currentRequestId = ++requestId
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: currentRequestId, method, params }),
    signal: AbortSignal.timeout(180_000),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`MCP ${method} failed: HTTP ${response.status} ${raw.slice(0, 500)}`)
  const payload = raw.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as unknown)
    .find((candidate) => isRecord(candidate) && candidate.id === currentRequestId)
  if (!payload) throw new Error(`MCP ${method} returned no matching SSE response: ${raw.slice(0, 500)}`)
  const message = requireRecord(payload, `${method} response`)
  if (message.error) throw new Error(`MCP ${method} returned an error: ${JSON.stringify(message.error)}`)
  return requireRecord(message.result, `${method} result`)
}

function toolResourceUri(result: Record<string, unknown>, name: string): string | null {
  const tools = Array.isArray(result.tools) ? result.tools.filter(isRecord) : []
  const tool = tools.find((candidate) => candidate.name === name)
  const meta = isRecord(tool?._meta) ? tool._meta : {}
  return isRecord(meta.ui) && typeof meta.ui.resourceUri === "string" ? meta.ui.resourceUri : null
}

function toolDefinition(result: Record<string, unknown>, name: string): Record<string, unknown> | null {
  const tools = Array.isArray(result.tools) ? result.tools.filter(isRecord) : []
  return tools.find((candidate) => candidate.name === name) ?? null
}

function resourceContent(result: Record<string, unknown>): Record<string, unknown> {
  const contents = Array.isArray(result.contents) ? result.contents.filter(isRecord) : []
  return requireRecord(contents[0], "resource content")
}

async function organizationMemberIdByEmail(admin: DenSession, organizationId: string, email: string) {
  const result = await denFetch(admin, "/v1/org", {
    headers: {
      authorization: `Bearer ${admin.token}`,
      "x-openwork-org-id": organizationId,
    },
  })
  const members = isRecord(result.body) && Array.isArray(result.body.members)
    ? result.body.members.filter(isRecord)
    : []
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email)
  const memberId = member && typeof member.id === "string" ? member.id : ""
  if (!result.response.ok || !memberId) {
    throw new Error(`Resolving the Program viewer failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`)
  }
  return memberId
}

test("the agent MCP exposes the custom Artifact view authoring lifecycle", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs(requirements)
  await using den = await server({
    place,
    env: { DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "true" },
    org: {
      name: `Generated Artifact Views ${Date.now()}`,
      admin: { name: "Avery" },
      members: { viewer: { name: "Program Viewer" } },
    },
  })
  const orgs = await denFetch(den.admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  })
  const rows = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(isRecord) : []
  const organizationId = String(rows[0]?.id ?? "")
  expect(organizationId).not.toBe("")
  const enabled = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ capabilities: { codemodeScripts: true } }),
  })
  expect(enabled.response.ok, enabled.text).toBe(true)

  const tokenResponse = await denFetch(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      "x-openwork-org-id": organizationId,
    },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  })
  const mcpToken = isRecord(tokenResponse.body) ? String(tokenResponse.body.token ?? "") : ""
  expect(tokenResponse.response.ok, tokenResponse.text).toBe(true)
  expect(mcpToken).toMatch(/^ow_mcp_at_/)

  const initialized = await denFetch(den.admin, "/mcp/agent", {
    method: "POST",
    headers: {
      authorization: `Bearer ${mcpToken}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
        clientInfo: { name: "generated-artifact-view-eval", version: "1.0.0" },
      },
    }),
  })
  expect(initialized.response.ok, initialized.text).toBe(true)
  expect(initialized.text).toContain("io.modelcontextprotocol/ui")

  const initialTools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(initialTools, "save_artifact_view")).toBeNull()
  expect(toolResourceUri(initialTools, "render_dynamic_artifact")).toBe("ui://openwork/dynamic-artifact/v1/view.html")
  for (const name of ["search_programs", "select_program", "clear_program_selection"]) {
    expect(isRecord(toolDefinition(initialTools, name)?.outputSchema)).toBe(true)
  }

  const code = 'return { title: "Quarterly plan", status: "Ready" }'
  const executed = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "execute_capability_script",
    arguments: { code },
  })
  expect(executed.isError, JSON.stringify(executed)).not.toBe(true)

  const receipts = await denFetch(den.admin, "/v1/codemode-runs", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  })
  expect(receipts.response.ok, receipts.text).toBe(true)
  const runs = isRecord(receipts.body) && Array.isArray(receipts.body.runs)
    ? receipts.body.runs.filter(isRecord)
    : []
  const receipt = runs.find((run) => run.source === "adhoc" && run.status === "succeeded")
  expect(receipt).toMatchObject({ toolCallCount: 0, toolCalls: [] })

  const savedScript = await denFetch(den.admin, "/v1/codemode-scripts", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({
      name: "Quarterly plan source",
      description: "Deterministic source for generated Artifact view verification.",
      code,
      currentInput: { preview: "private-preview-value" },
      inputSchema: {
        type: "object",
        properties: { preview: { type: "string" } },
        required: ["preview"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { title: { type: "string" }, status: { type: "string" } },
        required: ["title", "status"],
        additionalProperties: false,
      },
    }),
  })
  expect(savedScript.response.status, savedScript.text).toBe(201)
  const saved = requireRecord(savedScript.body, "saved Script")
  const configObjectId = String(saved.configObjectId ?? "")
  expect(configObjectId).toMatch(/^cob_/)

  const viewer = den.members.viewer
  if (!viewer) throw new Error("The testkit did not provision the Program viewer.")
  const viewerMemberId = await organizationMemberIdByEmail(den.admin, organizationId, viewer.email)
  const shared = await denFetch(den.admin, `/v1/config-objects/${encodeURIComponent(configObjectId)}/access`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      "x-openwork-org-id": organizationId,
    },
    body: JSON.stringify({ orgMembershipId: viewerMemberId, role: "viewer" }),
  })
  expect(shared.response.ok, shared.text).toBe(true)
  const viewerDetailResponse = await denFetch(viewer, `/v1/programs/${encodeURIComponent(configObjectId)}`, {
    headers: {
      authorization: `Bearer ${viewer.token}`,
      "x-openwork-org-id": organizationId,
    },
  })
  expect(viewerDetailResponse.response.ok, viewerDetailResponse.text).toBe(true)
  const viewerDetail = requireRecord(viewerDetailResponse.body, "viewer Program detail")
  const viewerScript = requireRecord(viewerDetail.script, "viewer Script detail")
  const viewerVersion = requireRecord(viewerScript.currentVersion, "viewer Script version")
  expect(viewerVersion.code).toBeNull()
  expect(viewerVersion.exampleInput).toBeNull()
  expect(JSON.stringify(viewerVersion)).not.toContain("return input")

  const viewerGenericVersionsResponse = await denFetch(viewer, `/v1/config-objects/${encodeURIComponent(configObjectId)}/versions`, {
    headers: {
      authorization: `Bearer ${viewer.token}`,
      "x-openwork-org-id": organizationId,
    },
  })
  expect(viewerGenericVersionsResponse.response.ok, viewerGenericVersionsResponse.text).toBe(true)
  const viewerGenericVersions = isRecord(viewerGenericVersionsResponse.body) && Array.isArray(viewerGenericVersionsResponse.body.items)
    ? viewerGenericVersionsResponse.body.items.filter(isRecord)
    : []
  const viewerGenericVersion = requireRecord(viewerGenericVersions[0], "viewer generic config-object version")
  const viewerGenericPayload = requireRecord(viewerGenericVersion.normalizedPayloadJson, "viewer generic normalized payload")
  expect(viewerGenericVersion.rawSourceText).toBeNull()
  expect(viewerGenericPayload).not.toHaveProperty("exampleInput")
  expect(JSON.stringify(viewerGenericVersion)).not.toContain("private-preview-value")
  expect(JSON.stringify(viewerGenericVersion)).not.toContain(code)

  const library = await denFetch(den.admin, "/v1/me/library", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  })
  expect(library.response.ok, library.text).toBe(true)
  const libraryItems = isRecord(library.body) && Array.isArray(library.body.items)
    ? library.body.items.filter(isRecord)
    : []
  const programItem = libraryItems.find((item) => item.type === "program" && item.id === configObjectId)
  expect(programItem).toMatchObject({
    type: "program",
    id: configObjectId,
    plugin: { id: saved.pluginId },
    resultState: "never_run",
    viewState: "default",
    automationCount: 0,
  })
  expect(programItem).not.toHaveProperty("code")
  expect(programItem).not.toHaveProperty("data")
  expect(programItem).not.toHaveProperty("compiledHtml")

  const programSearch = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "search_programs",
    arguments: { query: "Quarterly plan source" },
  })
  const searchItems = requireRecord(programSearch.structuredContent, "Program search").items
  const searchedItems = Array.isArray(searchItems) ? searchItems.filter(isRecord) : []
  expect(searchedItems.some((item) => item.id === configObjectId)).toBe(true)
  expect(JSON.stringify(searchedItems)).not.toContain(code)

  const scriptRun = await denFetch(den.admin, `/v1/codemode-scripts/${configObjectId}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({
      pluginId: saved.pluginId,
      configObjectVersionId: saved.configObjectVersionId,
      input: { preview: "private-preview-value" },
    }),
  })
  expect(scriptRun.response.ok, scriptRun.text).toBe(true)

  const firstSave = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "save_artifact_view",
    arguments: {
      configObjectId,
      title: "Quarterly plan",
      description: "Agent-authored custom Artifact view.",
      reactSource: "export default function QuarterlyPlan({ data }) { return <article><h1>{data.title}</h1><p>{data.status}</p></article> }",
      cssSource: "article{padding:20px;border:2px solid #2563eb;border-radius:16px}",
    },
  })
  expect(firstSave.isError, JSON.stringify(firstSave)).not.toBe(true)
  const firstView = requireRecord(requireRecord(firstSave.structuredContent, "first save result").view, "first view")
  const artifactViewId = String(firstView.id ?? "")
  const firstRevisionId = String(firstView.activeRevisionId ?? "")
  const firstRevision = Array.isArray(firstView.revisions) ? firstView.revisions.filter(isRecord)[0] : undefined
  const firstUri = String(firstRevision?.resourceUri ?? "")
  expect(firstUri).toBe(`ui://openwork/artifacts/${artifactViewId}/views/${firstRevisionId}/index.html`)
  expect(JSON.stringify(firstSave.content)).toContain("render_selected_program")
  expect(JSON.stringify(firstSave.content)).not.toContain(`render_artifact_${artifactViewId}`)

  const firstRead = resourceContent(await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: firstUri }))
  const firstHtml = String(firstRead.text ?? "")
  expect(firstRead.mimeType).toBe("text/html;profile=mcp-app")
  expect(firstHtml).toContain("ui/initialize")
  expect(firstHtml).toContain("2026-01-26")
  expect(firstHtml).toContain("ResizeObserver")
  expect(firstHtml).toContain("MCP_APP_DOCUMENT_RUNTIME_ERROR")
  expect(firstHtml).not.toContain("<script src=")
  expect(firstHtml).not.toContain('"Ready"')

  const renderName = `render_artifact_${artifactViewId}`
  let tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, renderName)).toBeNull()
  await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "select_program",
    arguments: { programId: configObjectId },
  })
  tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, "render_selected_program")).toBe(firstUri)
  const rendered = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", { name: "render_selected_program", arguments: {} })
  expect(rendered.isError, JSON.stringify(rendered)).not.toBe(true)
  expect(requireRecord(rendered.structuredContent, "render result").data).toEqual({ title: "Quarterly plan", status: "Ready" })

  const secondSave = await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "save_artifact_view",
    arguments: {
      artifactViewId,
      configObjectId,
      title: "Quarterly plan",
      description: "Second immutable custom revision.",
      reactSource: "export default function QuarterlyPlanV2({ data }) { return <section><h1>{data.title}</h1><strong>{data.status}</strong></section> }",
      cssSource: "section{padding:24px;border:3px solid #16a34a;border-radius:18px}",
    },
  })
  const secondView = requireRecord(requireRecord(secondSave.structuredContent, "second save result").view, "second view")
  const revisions = Array.isArray(secondView.revisions) ? secondView.revisions.filter(isRecord) : []
  const secondRevision = revisions.find((revision) => revision.id !== firstRevisionId)
  const secondRevisionId = String(secondRevision?.id ?? "")
  const secondUri = String(secondRevision?.resourceUri ?? "")
  expect(secondUri).toBe(`ui://openwork/artifacts/${artifactViewId}/views/${secondRevisionId}/index.html`)
  expect(secondUri).not.toBe(firstUri)

  const secondHtml = String(resourceContent(await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: secondUri })).text ?? "")
  expect(secondHtml).not.toBe(firstHtml)
  expect(String(resourceContent(await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: firstUri })).text ?? "")).toBe(firstHtml)
  tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, renderName)).toBeNull()
  expect(toolResourceUri(tools, `preview_artifact_${artifactViewId}`)).toBeNull()
  expect(toolResourceUri(tools, "render_selected_program")).toBe(firstUri)

  await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "activate_artifact_view_revision",
    arguments: { artifactViewId, revisionId: secondRevisionId },
  })
  tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, "render_selected_program")).toBe(secondUri)

  await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "activate_artifact_view_revision",
    arguments: { artifactViewId, revisionId: firstRevisionId },
  })
  tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, "render_selected_program")).toBe(firstUri)

  await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "retire_artifact_view",
    arguments: { artifactViewId },
  })
  tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, renderName)).toBeNull()
  expect(toolResourceUri(tools, "render_selected_program")).toBe("ui://openwork/dynamic-artifact/v1/view.html")
  expect(String(resourceContent(await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: firstUri })).text ?? "")).toBe(firstHtml)
  expect(String(resourceContent(await agentRpc(den.ref.apiUrl, mcpToken, "resources/read", { uri: secondUri })).text ?? "")).toBe(secondHtml)

  await using browser = await chrome({
    name: "dynamic-artifact-library",
    startUrl: "about:blank",
    headless: true,
    host: place.host(),
  })
  await navigate(browser.client, den.ref.webUrl)
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before Program auth handoff",
  })
  await evalIn(browser, `localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)})`)
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/library`)
  await waitFor(browser, `(() => {
    const row = [...document.querySelectorAll('[data-library-item-type="program"]')]
      .find((entry) => (entry.textContent ?? "").includes("Quarterly plan source"));
    const filters = document.querySelector('[aria-label="Library filters"]');
    return Boolean(row && (filters?.textContent ?? "").includes("Programs"));
  })()`, {
    timeoutMs: 60_000,
    label: "Program row and kind filter in My Library",
  })
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/library/programs/${encodeURIComponent(configObjectId)}`)
  await waitFor(browser, `(() => {
    const detail = document.querySelector('[data-testid="den-dynamic-program-detail"]');
    if (!detail) return false;
    const text = detail.textContent ?? "";
    return ["Overview", "Preview & Data", "Script", "Views", "Runs & Automations", "Access"]
      .every((label) => text.includes(label));
  })()`, {
    timeoutMs: 60_000,
    label: "canonical six-section Program detail",
  })

  await agentRpc(den.ref.apiUrl, mcpToken, "tools/call", {
    name: "clear_program_selection",
    arguments: {},
  })
  tools = await agentRpc(den.ref.apiUrl, mcpToken, "tools/list", {})
  expect(toolResourceUri(tools, "render_selected_program")).toBeNull()
  expect(Array.isArray(tools.tools) && tools.tools.filter(isRecord).some((tool) => tool.name === "run_selected_program")).toBe(false)

  evidence.recordAssertionEvidence(
    "Custom Artifact view provider is available only on the Code Mode agent MCP",
    "The saved Script appeared immediately as a metadata-only never-run Library Program inside its OpenWork Connect Plugin. The live provider then found and selected it through the constant-size catalog, built two custom React revisions, preserved both immutable resources, injected retained Artifact data through structuredContent, activated the second revision, rolled back to the first, retired the custom view back to the generic renderer without deleting either resource, and cleared the persisted selection.",
    true,
  )
  evidence.recordAssertionEvidence(
    "Program access does not disclose manager-only Script authoring data",
    "A viewer with explicit Program access could read the composed detail and retained Artifact contract, while both the Program API and generic config-object version API omitted Script source and saved example input.",
    viewerVersion.code === null
      && viewerVersion.exampleInput === null
      && viewerGenericVersion.rawSourceText === null
      && !("exampleInput" in viewerGenericPayload),
  )
})
