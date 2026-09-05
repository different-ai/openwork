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
    views: [view],
    loadResource: async () => ({ html, resourceDigest: digest, csp: view.revisions[0]!.csp }),
    loadData: async () => ({ ok: true, payload, markdown: "# Custom pipeline" }),
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
