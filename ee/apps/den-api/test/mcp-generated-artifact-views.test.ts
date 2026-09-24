import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { GeneratedArtifactView, WorkflowArtifactPayload } from "@openwork/types/workflows"
import { artifactViewResourceUri } from "../src/artifact-view-resource.js"
import { registerAgentWorkflowArtifactResource, workflowArtifactAppServerCapabilities } from "../src/mcp/workflow-artifact-app.js"
import { registerAgentGeneratedArtifactViews } from "../src/mcp/generated-artifact-views.js"

const viewId = "arv_01k28e8vz5e5svgkde54dgqy0c"
const activeRevisionId = "avr_01k28e91dcf6ftyz9e90pcrv7p"
const draftRevisionId = "avr_01k28e99fpfmrs5hvh5rj49vrz"
const rollbackRevisionId = "avr_01k28e9dq2en6sh6djm0bvx0yk"
const savedRevisionId = "avr_01k28e9eq2en6sh6djm0bvx0yk"
const configObjectId = "cob_01k28e8q8pf8r9sff9mhyqxved"
const html = "<!doctype html><html><body><div id=\"root\"></div></body></html>"
const digest = `sha256:${createHash("sha256").update(html).digest("hex")}`

function revision(id: string, createdAt: string) {
  return {
    id,
    artifactViewId: viewId,
    resourceUri: artifactViewResourceUri(viewId, id),
    buildStatus: "ready" as const,
    sourceDigest: digest,
    resourceDigest: digest,
    outputSchemaDigest: digest,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    diagnostics: [],
    compilerName: "esbuild",
    compilerVersion: "test",
    reactVersion: "19.1.1",
    compiledHtmlBytes: Buffer.byteLength(html),
    retiredAt: null,
    createdAt,
  }
}

const view: GeneratedArtifactView = {
  id: viewId,
  configObjectId,
  title: "Custom pipeline",
  description: "Agent-authored pipeline view.",
  status: "active",
  activeRevisionId,
  revisions: [
    revision(draftRevisionId, "2026-08-12T12:00:00.000Z"),
    revision(activeRevisionId, "2026-08-12T11:00:00.000Z"),
    revision(rollbackRevisionId, "2026-08-12T10:00:00.000Z"),
  ],
  createdAt: "2026-08-12T11:00:00.000Z",
  updatedAt: "2026-08-12T12:00:00.000Z",
}

const payload: WorkflowArtifactPayload = {
  schemaVersion: "1",
  artifact: {
    title: "Custom pipeline",
    description: "Agent-authored pipeline view.",
    pluginId: "plg_01k28e8q8pf8r9sff9mhyqxved",
    configObjectId,
    configObjectVersionId: "cov_01k28e8q8pf8r9sff9mhyqxved",
    receiptId: "cmr_01k28e8q8pf8r9sff9mhyqxved",
    automationRunId: null,
    source: "manual",
    generatedAt: "2026-08-12T12:00:00.000Z",
    resultDigest: digest,
    rendererVersion: "codemode-markdown-v1",
    freshness: { state: "fresh", ageMs: 100 },
  },
  data: { title: "Qualified", total: 12 },
}

async function withClient<T>(
  run: (client: Client) => Promise<T>,
  overrides: Partial<{
    views: GeneratedArtifactView[]
    loadData: Parameters<typeof registerAgentGeneratedArtifactViews>[0]["loadData"]
    save: () => Promise<GeneratedArtifactView>
    activate: (request: { artifactViewId: string; revisionId: string }) => Promise<GeneratedArtifactView>
    retire: () => Promise<GeneratedArtifactView>
    legacyViewsWritable: boolean
  }> = {},
): Promise<T> {
  const server = new McpServer(
    { name: "generated-artifact-test", version: "1.0.0" },
    { capabilities: { ...workflowArtifactAppServerCapabilities, tools: { listChanged: true }, resources: { listChanged: true } } },
  )
  registerAgentWorkflowArtifactResource(server)
  registerAgentGeneratedArtifactViews({
    server,
    views: overrides.views ?? [view],
    loadResource: async () => ({ html, resourceDigest: digest, csp: view.revisions[0]!.csp }),
    loadData: overrides.loadData ?? (async () => ({ ok: true, payload, markdown: "# Custom pipeline" })),
    save: overrides.save ?? (async () => view),
    activate: overrides.activate ?? (async ({ revisionId }) => ({ ...view, activeRevisionId: revisionId })),
    retire: overrides.retire ?? (async () => ({ ...view, status: "retired", activeRevisionId: null })),
    notifyCatalogChanged: () => {
      server.sendToolListChanged()
      server.sendResourceListChanged()
    },
    legacyViewsWritable: overrides.legacyViewsWritable ?? true,
  })
  const client = new Client({ name: "host", version: "1.0.0" }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

test("advertises exact immutable active and preview URIs in tool definitions", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools()
    const render = tools.tools.find((tool) => tool.name === `render_artifact_${viewId}`)
    const preview = tools.tools.find((tool) => tool.name === `preview_artifact_${viewId}`)
    const save = tools.tools.find((tool) => tool.name === "save_artifact_view")
    expect(render?._meta).toMatchObject({ ui: { resourceUri: artifactViewResourceUri(viewId, activeRevisionId) } })
    expect(preview?._meta).toMatchObject({ ui: { resourceUri: artifactViewResourceUri(viewId, draftRevisionId) } })
    expect(save?._meta).toBeUndefined()
    expect(save?.description).toContain("OpenWork offers Open preview")
    expect(save?.description).toContain("choose Save in OpenWork")
    expect(save?.description).not.toContain("automatically")

    const resources = await client.listResources()
    expect(resources.resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining([
      artifactViewResourceUri(viewId, activeRevisionId),
      artifactViewResourceUri(viewId, draftRevisionId),
      artifactViewResourceUri(viewId, rollbackRevisionId),
    ]))
  })
})

test("serves the stored HTML bytes and keeps Artifact data in structuredContent", async () => {
  await withClient(async (client) => {
    const resource = await client.readResource({ uri: artifactViewResourceUri(viewId, activeRevisionId) })
    const content = resource.contents[0]
    expect(content && "text" in content ? content.text : null).toBe(html)
    expect(content?.mimeType).toBe("text/html;profile=mcp-app")

    const result = await client.callTool({ name: `render_artifact_${viewId}`, arguments: {} })
    expect(result.structuredContent).toEqual(payload)
    expect(html).not.toContain("Qualified")
  })
})

test("keeps per-view render tools exposed without selection-bound aliases", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools()
    expect(tools.tools.some((tool) => tool.name === `render_artifact_${viewId}`)).toBe(true)
    expect(tools.tools.some((tool) => tool.name === `preview_artifact_${viewId}`)).toBe(true)
    expect(tools.tools.filter((tool) => /selected_program$/.test(tool.name))).toEqual([])
    expect(tools.tools.filter((tool) => tool.name.includes("_program"))).toEqual([])
    expect(tools.tools.some((tool) => tool.name === "save_artifact_view")).toBe(true)
    const saved = await client.callTool({
      name: "save_artifact_view",
      arguments: {
        artifactViewId: viewId,
        configObjectId,
        title: view.title,
        reactSource: "export default function View() { return <div /> }",
      },
    })
    expect(JSON.stringify(saved.content)).toContain(`preview_artifact_${viewId}`)
  })
})

test("activation and rollback refresh the render tool to each exact immutable URI", async () => {
  await withClient(async (client) => {
    let changed = 0
    let resourcesChanged = 0
    client.setNotificationHandler("notifications/tools/list_changed", () => { changed += 1 })
    client.setNotificationHandler("notifications/resources/list_changed", () => { resourcesChanged += 1 })
    await client.callTool({
      name: "activate_artifact_view_revision",
      arguments: { artifactViewId: viewId, revisionId: draftRevisionId },
    })
    expect(changed).toBeGreaterThan(0)
    expect(resourcesChanged).toBeGreaterThan(0)
    const tools = await client.listTools()
    let render = tools.tools.find((tool) => tool.name === `render_artifact_${viewId}`)
    expect(render?._meta).toMatchObject({ ui: { resourceUri: artifactViewResourceUri(viewId, draftRevisionId) } })

    await client.callTool({
      name: "activate_artifact_view_revision",
      arguments: { artifactViewId: viewId, revisionId: rollbackRevisionId },
    })
    render = (await client.listTools()).tools.find((tool) => tool.name === `render_artifact_${viewId}`)
    expect(render?._meta).toMatchObject({ ui: { resourceUri: artifactViewResourceUri(viewId, rollbackRevisionId) } })
    expect(changed).toBeGreaterThan(1)
    expect(resourcesChanged).toBeGreaterThan(1)
  })
})

test("save and retirement refresh the same session's resources and tools", async () => {
  const savedView: GeneratedArtifactView = {
    ...view,
    revisions: [revision(savedRevisionId, "2026-08-12T13:00:00.000Z"), ...view.revisions],
    updatedAt: "2026-08-12T13:00:00.000Z",
  }
  await withClient(async (client) => {
    let changed = 0
    let resourcesChanged = 0
    client.setNotificationHandler("notifications/tools/list_changed", () => { changed += 1 })
    client.setNotificationHandler("notifications/resources/list_changed", () => { resourcesChanged += 1 })
    const saved = await client.callTool({
      name: "save_artifact_view",
      arguments: {
        artifactViewId: viewId,
        configObjectId,
        title: view.title,
        reactSource: "export default function View() { return <div /> }",
      },
    })
    expect(JSON.stringify(saved.content)).toContain(`preview_artifact_${viewId}`)
    expect(changed).toBeGreaterThan(0)
    expect(resourcesChanged).toBeGreaterThan(0)
    const resources = await client.listResources()
    expect(resources.resources.map((resource) => resource.uri)).toContain(artifactViewResourceUri(viewId, savedRevisionId))
    let tools = await client.listTools()
    expect(tools.tools.find((tool) => tool.name === `preview_artifact_${viewId}`)?._meta)
      .toMatchObject({ ui: { resourceUri: artifactViewResourceUri(viewId, savedRevisionId) } })

    await client.callTool({ name: "retire_artifact_view", arguments: { artifactViewId: viewId } })
    tools = await client.listTools()
    expect(tools.tools.some((tool) => tool.name === `render_artifact_${viewId}`)).toBe(false)
    expect(changed).toBeGreaterThan(1)
    expect(resourcesChanged).toBeGreaterThan(1)
  }, {
    save: async () => savedView,
    retire: async () => ({ ...savedView, status: "retired", activeRevisionId: null }),
  })
})

test("returns actionable tool errors for missing schemas and failed builds", async () => {
  await withClient(async (client) => {
    const missingSchema = await client.callTool({
      name: "save_artifact_view",
      arguments: { artifactViewId: viewId, configObjectId, title: view.title, reactSource: "export default function View() { return <div /> }" },
    })
    expect(missingSchema.isError).toBe(true)
    expect(JSON.stringify(missingSchema.content)).toContain("artifact_view_output_schema_required")
    expect(JSON.stringify(missingSchema.content)).toContain("Do not retry save_artifact_view yet")
  }, {
    save: async () => { throw new Error("artifact_view_output_schema_required") },
  })

  const failedRevision = {
    ...revision(savedRevisionId, "2026-08-12T13:00:00.000Z"),
    buildStatus: "failed" as const,
    resourceDigest: null,
    compiledHtmlBytes: null,
    diagnostics: [{ level: "error" as const, message: "Unexpected token", line: 1, column: 8 }],
  }
  await withClient(async (client) => {
    const failed = await client.callTool({
      name: "save_artifact_view",
      arguments: { artifactViewId: viewId, configObjectId, title: view.title, reactSource: "export default function View( {" },
    })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed.content)).toContain("artifact_view_build_failed")
    expect(JSON.stringify(failed.content)).toContain("Unexpected token")
    expect(JSON.stringify(failed.content)).toContain(viewId)
  }, {
    save: async () => ({ ...view, activeRevisionId: null, revisions: [failedRevision] }),
  })
})

const draftDataModes: Array<GeneratedArtifactView["dataMode"]> = ["live", "snapshot", undefined]

test.each(draftDataModes)("%s draft metadata preserves compatible desktop preview arguments", async (dataMode) => {
  await withClient(async (client) => {
    const saved = await client.callTool({
      name: "save_artifact_view",
      arguments: { artifactViewId: viewId, configObjectId, title: view.title, reactSource: "export default function View() { return <div /> }" },
    })
    expect(saved.isError).not.toBe(true)
    const text = JSON.stringify(saved.content)
    expect(text).toContain(`preview_artifact_${viewId}`)
    expect(text).toContain("Choose Open preview in OpenWork, then Save")
    expect(text).not.toContain("automatically")
    if (dataMode === "live") {
      expect(text).toContain(`run_artifact_${viewId}`)
      expect(text).toContain("optional timeZone")
      expect(text).toContain("input.runtime")
      expect(text).toContain("No other inputs or receipt overrides")
      expect(text).toContain("choose Save")
      expect(text).toContain("Do not activate")
      const catalog = await client.listTools()
      expect(catalog.tools.find((tool) => tool.name === `run_artifact_${viewId}`)?._meta)
        .toMatchObject({ ui: { resourceUri: artifactViewResourceUri(viewId, activeRevisionId) } })
    } else {
      expect(text).not.toContain(`run_artifact_${viewId}`)
      expect(saved.content).toEqual([{ type: "text", text: `Saved immutable view revision ${draftRevisionId} at ${artifactViewResourceUri(viewId, draftRevisionId)}. Choose Open preview in OpenWork, then Save to keep the app on your dashboard. In other MCP clients: Call preview_artifact_${viewId} to display that revision.` }])
    }
    expect(saved.structuredContent).toMatchObject({ view: { activeRevisionId } })
    expect(saved._meta?.["openwork/appDraft"]).toEqual({
      appId: viewId,
      revisionId: draftRevisionId,
      title: view.title,
      ...(dataMode === "live" ? {} : { receiptId: payload.artifact.receiptId }),
    })
  }, {
    views: [{ ...view, dataMode }],
    save: async () => ({ ...view, dataMode }),
    activate: async () => { throw new Error("Saving a draft must not activate it") },
  })
})

test.each(draftDataModes)("%s edits of existing drafts preserve explicit preview metadata without activation", async (dataMode) => {
  let loads = 0
  const draftView = { ...view, dataMode, activeRevisionId: null }
  await withClient(async (client) => {
    const saved = await client.callTool({
      name: "save_artifact_view",
      arguments: { artifactViewId: viewId, configObjectId, title: view.title, reactSource: "export default function View() { return <div /> }" },
    })
    expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true)
    expect(saved.structuredContent).toEqual({ view: draftView })
    expect(saved._meta?.["openwork/appDraft"]).toEqual({
      appId: viewId, revisionId: draftRevisionId, title: view.title,
      ...(dataMode === "live" ? {} : { receiptId: payload.artifact.receiptId }),
    })
    expect(loads).toBe(1)
    const tools = await client.listTools()
    expect(tools.tools.some(tool => tool.name === `render_artifact_${viewId}`)).toBe(false)
    expect(tools.tools.find(tool => tool.name === `preview_artifact_${viewId}`)?._meta)
      .toMatchObject({ ui: { resourceUri: artifactViewResourceUri(viewId, draftRevisionId) } })
    const preview = await client.callTool({ name: `preview_artifact_${viewId}`, arguments: {} })
    expect(preview.structuredContent).toEqual(payload)
    expect(preview._meta?.["openwork/appDraft"]).toEqual(dataMode === "live"
      ? { appId: viewId, revisionId: draftRevisionId, title: view.title } : undefined)
    expect(loads).toBe(2)
  }, {
    views: [],
    save: async () => draftView,
    loadData: async () => { loads += 1; return { ok: true, payload, markdown: "# Preview" } },
    activate: async () => { throw new Error("Saving a draft must not activate it") },
  })
})

test.each([null, activeRevisionId])("live preview recovery preserves the draft with active revision %s", async (activeId) => {
  const savedView: GeneratedArtifactView = {
    ...view,
    dataMode: "live",
    activeRevisionId: activeId,
    revisions: [revision(savedRevisionId, "2026-08-12T13:00:00.000Z"), ...view.revisions],
  }
  const connectionStatus = { connectionName: "Test connection", action: "Connect your account" }
  const connectionCard = {
    schemaVersion: "1", connectionId: "emc_fixture", connectionName: "Test connection",
    state: "needs_connection", actor: "member", message: "Connect your account",
    action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
  }
  const requests: Array<Parameters<Parameters<typeof registerAgentGeneratedArtifactViews>[0]["loadData"]>[0]> = []
  let saves = 0
  let activations = 0
  await withClient(async (client) => {
    let changed = 0
    client.setNotificationHandler("notifications/tools/list_changed", () => { changed += 1 })
    const failed = await client.callTool({
      name: "save_artifact_view",
      arguments: { artifactViewId: viewId, configObjectId, title: view.title, reactSource: "export default function View() { return <div /> }" },
    })
    expect(failed.isError).toBe(true)
    expect(failed._meta?.["openwork/appDraft"]).toBeUndefined()
    expect(failed.structuredContent).toEqual(connectionCard)
    expect(failed._meta?.["openwork/mcpApp"]).toEqual({
      toolName: "connection_action", resourceUri: "ui://openwork/connection-action/v2/view.html", arguments: { connectionId: "emc_fixture" },
    })
    expect(JSON.stringify(failed)).not.toContain(payload.artifact.receiptId)
    const content = failed.content?.[0]
    expect(JSON.stringify(content)).toContain("artifact_view_preview_unavailable")
    const error = JSON.parse(content?.type === "text" ? content.text : "{}")
    expect(error).toMatchObject({
      error: "artifact_view_preview_unavailable",
      artifactViewId: viewId,
      viewRevisionId: savedRevisionId,
      configObjectId,
      reason: "capability_unavailable",
      detail: "Connect your account",
      connectionStatus,
      connectionCard,
    })
    expect(error.message).toContain(`preview_artifact_${viewId}`)
    expect(error.message).toContain("optional timeZone")
    expect(error.message).toContain("input.runtime")
    expect(error.message).toContain("No other inputs or receipt overrides")
    expect(error.message).not.toContain("example inputs")
    expect(error.message).not.toContain("execute_capability")
    expect(error.message).not.toContain("retry save_artifact_view")
    expect(error.message).toContain("Do not rebuild")
    expect(error.message).toContain("Do not schedule an Automation or report the preview ready yet")
    expect(changed).toBeGreaterThan(0)
    const catalog = await client.listTools()
    expect(catalog.tools.find((tool) => tool.name === `preview_artifact_${viewId}`)?._meta)
      .toMatchObject({ ui: { resourceUri: artifactViewResourceUri(viewId, savedRevisionId) } })
    expect(catalog.tools.find((tool) => tool.name === `run_artifact_${viewId}`)?._meta)
      .toMatchObject({ ui: { resourceUri: artifactViewResourceUri(viewId, activeId ?? savedRevisionId) } })
    const recovered = await client.callTool({ name: `preview_artifact_${viewId}`, arguments: { timeZone: "Asia/Tokyo" } })
    expect(recovered.isError).not.toBe(true)
    expect(recovered.structuredContent).toEqual(payload)
    expect(recovered._meta?.["openwork/appDraft"]).toEqual({ appId: viewId, revisionId: savedRevisionId, title: view.title })
    expect(recovered._meta?.["openwork/mcpApp"]).toBeUndefined()
    expect(requests).toEqual([
      { configObjectId, expectedOutputSchemaDigest: digest, dataMode: "live" },
      { configObjectId, expectedOutputSchemaDigest: digest, dataMode: "live", timeZone: "Asia/Tokyo" },
    ])
    expect(saves).toBe(1)
    expect(activations).toBe(0)
  }, {
    views: activeId ? [{ ...view, dataMode: "live" }] : [],
    save: async () => { saves += 1; return savedView },
    activate: async () => { activations += 1; return savedView },
    loadData: async (request) => {
      requests.push(request)
      return requests.length === 1
        ? { ok: false, error: "capability_unavailable", message: "Connect your account", connectionStatus, connectionCard }
        : { ok: true, payload, markdown: "# Current" }
    },
  })
})

test.each(draftDataModes.filter((mode) => mode !== "live"))("%s preview failure retains snapshot recovery guidance", async (dataMode) => {
  await withClient(async (client) => {
    const failed = await client.callTool({
      name: "save_artifact_view",
      arguments: { artifactViewId: viewId, configObjectId, title: view.title, reactSource: "export default function View() { return <div /> }" },
    })
    expect(failed.isError).toBe(true)
    const content = failed.content?.[0]
    const error = JSON.parse(content?.type === "text" ? content.text : "{}")
    expect(error.message).toBe("The app draft compiled, but its preview has no compatible readable Workflow result. Run the current saved Workflow version explicitly with its example inputs using execute_capability, then retry save_artifact_view with the artifactViewId below. An ad-hoc execute_capability_script run is not a saved Workflow result. Do not schedule an Automation or report the preview ready yet.")
    expect(failed._meta?.["openwork/appDraft"]).toBeUndefined()
    const catalog = await client.listTools()
    expect(catalog.tools.some((tool) => tool.name.startsWith("run_artifact_"))).toBe(false)
    expect(catalog.tools.some((tool) => tool.name.startsWith("preview_artifact_"))).toBe(false)
  }, {
    views: [],
    save: async () => ({ ...view, dataMode }),
    loadData: async (request) => {
      expect(request.dataMode).toBe("snapshot")
      return { ok: false, error: "workflow_artifact_not_found", message: "No saved result" }
    },
  })
})

test("live run, render and preview fetch as the caller with strict runtime inputs", async () => {
  const requests: Array<Parameters<Parameters<typeof registerAgentGeneratedArtifactViews>[0]["loadData"]>[0]> = []
  await withClient(async (client) => {
    const catalog = await client.listTools()
    const run = catalog.tools.find((tool) => tool.name === `run_artifact_${view.id}`)
    expect(run?._meta).toMatchObject({ ui: { resourceUri: view.revisions[1]!.resourceUri } })
    for (const prefix of ["run", "render", "preview"]) {
      const result = await client.callTool({ name: `${prefix}_artifact_${view.id}`, arguments: { timeZone: "Asia/Tokyo" } })
      expect(result.isError).not.toBe(true)
    }
    expect(requests).toHaveLength(3)
    expect(requests.every((request) => request.dataMode === "live" && request.timeZone === "Asia/Tokyo")).toBe(true)
    for (const argumentsValue of [{ receiptId: "foreign" }, { today: "2020-01-01" }, { timeZone: "invalid" }]) {
      const result = await client.callTool({ name: `run_artifact_${view.id}`, arguments: argumentsValue })
      expect(result.isError).toBe(true)
    }
    expect(requests).toHaveLength(3)
  }, {
    views: [{ ...view, dataMode: "live" }],
    loadData: async (request) => {
      requests.push(request)
      return { ok: true, payload, markdown: "# Current" }
    },
  })
})

test.each(draftDataModes)("%s render results preserve published desktop routing", async (dataMode) => {
  await withClient(async (client) => {
    const catalog = await client.listTools()
    for (const prefix of dataMode === "live" ? ["run", "render", "preview"] : ["render", "preview"]) {
      const name = `${prefix}_artifact_${viewId}`
      const revisionId = prefix === "preview" ? draftRevisionId : activeRevisionId
      const resourceUri = artifactViewResourceUri(viewId, revisionId)
      expect(catalog.tools.find((tool) => tool.name === name)?._meta).toMatchObject({ ui: { resourceUri } })
      const result = await client.callTool({ name, arguments: {} })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual(payload)
      expect(result._meta).toMatchObject({ resourceDigest: digest, resultDigest: payload.artifact.resultDigest })
      expect(result._meta?.["openwork/appDraft"]).toEqual(dataMode === "live" && prefix === "preview"
        ? { appId: viewId, revisionId, title: view.title } : undefined)
      if (dataMode === "live") {
        expect(result._meta?.artifactViewId).toBeUndefined()
        expect(result._meta?.viewRevisionId).toBeUndefined()
      } else {
        expect(result._meta).toMatchObject({ artifactViewId: viewId, viewRevisionId: revisionId })
      }
      const resource = await client.readResource({ uri: resourceUri })
      expect(resource.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app", text: html })
    }
  }, { views: [{ ...view, dataMode }] })
})

test.each(["run", "render", "preview"])("live %s connection failures launch the shared connection App without retained data", async prefix => {
  const connectionCard = {
    schemaVersion: "1", connectionId: "emc_fixture", connectionName: "Test connection",
    state: "needs_connection", actor: "member", message: "Connect your account",
    action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
  }
  await withClient(async (client) => {
    const result = await client.callTool({ name: `${prefix}_artifact_${view.id}`, arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual(connectionCard)
    expect(result._meta?.["openwork/mcpApp"]).toEqual({
      toolName: "connection_action", resourceUri: "ui://openwork/connection-action/v2/view.html", arguments: { connectionId: "emc_fixture" },
    })
    expect(JSON.stringify(result)).not.toContain(payload.artifact.receiptId)
  }, {
    views: [{ ...view, dataMode: "live" }],
    loadData: async () => ({ ok: false, error: "capability_unavailable", message: "Connect your account", connectionCard }),
  })
})

test.each([undefined, { state: "needs_connection", message: "Connect your account" }])("does not invent a connection App for missing or incomplete connection data (%j)", async connectionCard => {
  await withClient(async client => {
    for (const name of [`run_artifact_${viewId}`, "save_artifact_view"]) {
      const result = await client.callTool({
        name,
        arguments: name === "save_artifact_view"
          ? { artifactViewId: viewId, configObjectId, title: view.title, reactSource: "export default function View() { return <div /> }" } : {},
      })
      expect(result.isError).toBe(true)
      expect(result._meta?.["openwork/mcpApp"]).toBeUndefined()
      expect(JSON.stringify(result.content)).toContain("capability_unavailable")
    }
  }, {
    views: [{ ...view, dataMode: "live" }],
    save: async () => ({ ...view, dataMode: "live" }),
    loadData: async () => ({ ok: false, error: "capability_unavailable", message: "Data unavailable", connectionCard }),
  })
})

test("where create_app is available, legacy views are read-only: they render, read, and retire but are never saved or re-activated", async () => {
  const writes: string[] = []
  let loads = 0
  await withClient(async (client) => {
    const reactSource = "export default function View() { return <div /> }"
    for (const request of [
      { name: "save_artifact_view", arguments: { configObjectId, title: view.title, reactSource } },
      { name: "save_artifact_view", arguments: { artifactViewId: view.id, configObjectId, title: view.title, reactSource } },
      { name: "activate_artifact_view_revision", arguments: { artifactViewId: view.id, revisionId: view.revisions[0]!.id } },
    ]) {
      const result = await client.callTool(request)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain("legacy_view_read_only")
      expect(JSON.stringify(result.content)).toContain("create_app")
      expect(result._meta).toBeUndefined()
    }
    expect(writes).toEqual([])
    expect(loads).toBe(0)
    const rendered = await client.callTool({ name: `render_artifact_${view.id}`, arguments: {} })
    expect(rendered.isError).not.toBe(true)
    expect(loads).toBe(1)
    expect((await client.readResource({ uri: view.revisions[0]!.resourceUri })).contents[0]).toMatchObject({ uri: view.revisions[0]!.resourceUri })
    expect((await client.callTool({ name: "retire_artifact_view", arguments: { artifactViewId: view.id } })).isError).not.toBe(true)
    expect(writes).toEqual(["retire"])
  }, {
    legacyViewsWritable: false,
    save: async () => { writes.push("save"); return view },
    activate: async () => { writes.push("activate"); return view },
    retire: async () => { writes.push("retire"); return { ...view, status: "retired", activeRevisionId: null } },
    loadData: async () => { loads += 1; return { ok: true, payload, markdown: "# Snapshot" } },
  })
})

test("legacy views retain snapshot inputs and do not advertise live execution", async () => {
  let receiptId: string | undefined
  await withClient(async (client) => {
    const catalog = await client.listTools()
    expect(catalog.tools.some((tool) => tool.name.startsWith("run_artifact_"))).toBe(false)
    await client.callTool({ name: `render_artifact_${view.id}`, arguments: { receiptId: "caller-receipt" } })
    expect(receiptId).toBe("caller-receipt")
  }, {
    loadData: async (request) => {
      expect(request.dataMode).toBe("snapshot")
      receiptId = request.receiptId
      return { ok: true, payload, markdown: "# Snapshot" }
    },
  })
})

test("legacy creation keeps working where create_app is unavailable", async () => {
  let saves = 0
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "save_artifact_view",
      arguments: { configObjectId, title: view.title, reactSource: "export default function View() { return <div /> }" },
    })
    expect(JSON.stringify(result.content)).not.toContain("legacy_view_read_only")
    expect(saves).toBe(1)
  }, {
    save: async () => { saves += 1; return view },
    legacyViewsWritable: true,
  })
})
