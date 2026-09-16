import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { GeneratedArtifactView, WorkflowArtifactPayload } from "@openwork/types/workflows"
import { artifactViewResourceUri } from "../src/artifact-view-resource.js"
import { workflowArtifactAppServerCapabilities } from "../src/mcp/workflow-artifact-app.js"
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
  }> = {},
): Promise<T> {
  const server = new McpServer(
    { name: "generated-artifact-test", version: "1.0.0" },
    { capabilities: workflowArtifactAppServerCapabilities },
  )
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
      arguments: { configObjectId, title: view.title, reactSource: "export default function View() { return <div /> }" },
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
      arguments: { configObjectId, title: view.title, reactSource: "export default function View( {" },
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
      arguments: { configObjectId, title: view.title, reactSource: "export default function View() { return <div /> }" },
    })
    expect(saved.isError).not.toBe(true)
    expect(saved._meta?.["openwork/appDraft"]).toEqual({
      appId: viewId,
      revisionId: draftRevisionId,
      title: view.title,
      ...(dataMode === "live" ? {} : { receiptId: payload.artifact.receiptId }),
    })
  }, {
    save: async () => ({ ...view, dataMode }),
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

test("live connection failures preserve structured cards and never return retained data", async () => {
  const connectionCard = { state: "needs_connection", message: "Connect your account" }
  await withClient(async (client) => {
    const result = await client.callTool({ name: `run_artifact_${view.id}`, arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual(connectionCard)
    expect(JSON.stringify(result)).not.toContain(payload.artifact.receiptId)
  }, {
    views: [{ ...view, dataMode: "live" }],
    loadData: async () => ({ ok: false, error: "capability_unavailable", message: "Connect your account", connectionCard }),
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
