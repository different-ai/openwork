import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { expect, test } from "bun:test"
import {
  LEGACY_WORKFLOW_ARTIFACT_TOOL_NAME,
  WORKFLOW_ARTIFACT_APP_HTML,
  WORKFLOW_ARTIFACT_APP_RESOURCE_URI,
  WORKFLOW_ARTIFACT_APP_TOOL_NAME,
  workflowArtifactAppServerCapabilities,
  workflowArtifactPayloadSchema,
  registerAgentWorkflowArtifactApp,
} from "../src/mcp/workflow-artifact-app.js"

const payload = workflowArtifactPayloadSchema.parse({
  schemaVersion: "1",
  artifact: {
    title: "Weekly pipeline",
    description: "Validated opportunities by stage.",
    pluginId: "plugin_sales",
    configObjectId: "configObject_pipeline",
    configObjectVersionId: "configObjectVersion_4",
    receiptId: "codemodeRun_week_32",
    automationRunId: "automationRun_week_32",
    source: "scheduled",
    generatedAt: "2026-08-11T10:30:00.000Z",
    resultDigest: `sha256:${"a".repeat(64)}`,
    rendererVersion: "codemode-markdown-v1",
    freshness: { state: "fresh", ageMs: 42_000 },
  },
  data: [
    { stage: "Qualified", value: 12 },
    { stage: "Proposal", value: 5 },
  ],
})

type LoadWorkflowArtifact = Parameters<typeof registerAgentWorkflowArtifactApp>[0]["load"]

async function withClient<T>(
  run: (client: Client) => Promise<T>,
  load: LoadWorkflowArtifact = async ({ receiptId }) => receiptId === "missing"
    ? { ok: false, error: "workflow_snapshot_not_found", message: "Snapshot not found." }
    : { ok: true, payload, markdown: "| Stage | Value |\n| --- | --- |\n| Qualified | 12 |" },
): Promise<T> {
  const server = new McpServer(
    { name: "workflow-artifact-test", version: "1.0.0" },
    { capabilities: workflowArtifactAppServerCapabilities },
  )
  registerAgentWorkflowArtifactApp({
    server,
    load,
  })
  const client = new Client(
    { name: "mcp-app-host-test", version: "1.0.0" },
    {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    },
  )
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

test("negotiates MCP Apps and links the render tool to a ui:// resource", async () => {
  await withClient(async (client) => {
    expect(client.getServerCapabilities()?.extensions).toEqual({
      "io.modelcontextprotocol/ui": {
        mimeTypes: ["text/html;profile=mcp-app"],
      },
    })

    const tools = await client.listTools()
    const tool = tools.tools.find((candidate) => candidate.name === WORKFLOW_ARTIFACT_APP_TOOL_NAME)
    expect(tool?._meta).toMatchObject({
      ui: {
        resourceUri: WORKFLOW_ARTIFACT_APP_RESOURCE_URI,
        visibility: ["model", "app"],
      },
      "ui/resourceUri": WORKFLOW_ARTIFACT_APP_RESOURCE_URI,
    })

    const alias = tools.tools.find((candidate) => candidate.name === LEGACY_WORKFLOW_ARTIFACT_TOOL_NAME)
    expect(alias?.description).toContain("Deprecated")

    const resources = await client.listResources()
    const resource = resources.resources.find((candidate) => candidate.uri === WORKFLOW_ARTIFACT_APP_RESOURCE_URI)
    expect(resource).toMatchObject({
      uri: WORKFLOW_ARTIFACT_APP_RESOURCE_URI,
      mimeType: "text/html;profile=mcp-app",
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
          prefersBorder: true,
        },
      },
    })
  })
})

test("serves a self-contained HTML5 app and a structured result with Markdown fallback", async () => {
  await withClient(async (client) => {
    const resource = await client.readResource({ uri: WORKFLOW_ARTIFACT_APP_RESOURCE_URI })
    expect(resource.contents).toHaveLength(1)
    expect(resource.contents[0]).toMatchObject({
      uri: WORKFLOW_ARTIFACT_APP_RESOURCE_URI,
      mimeType: "text/html;profile=mcp-app",
    })
    const content = resource.contents[0]
    expect(content && "text" in content ? content.text : "").toBe(WORKFLOW_ARTIFACT_APP_HTML)
    expect(WORKFLOW_ARTIFACT_APP_HTML).toStartWith("<!doctype html>")
    expect(WORKFLOW_ARTIFACT_APP_HTML).toContain("method: 'ui/initialize'")
    expect(WORKFLOW_ARTIFACT_APP_HTML).toContain("ui/notifications/initialized")
    expect(WORKFLOW_ARTIFACT_APP_HTML).toContain("ui/notifications/tool-result")
    expect(WORKFLOW_ARTIFACT_APP_HTML).toContain("ui/notifications/size-changed")
    expect(WORKFLOW_ARTIFACT_APP_HTML).not.toContain("<script src=")
    expect(WORKFLOW_ARTIFACT_APP_HTML).not.toContain("fetch(")
    expect(WORKFLOW_ARTIFACT_APP_HTML).toContain("['Workflow', artifact.configObjectId]")
    expect(WORKFLOW_ARTIFACT_APP_HTML).toContain("['Workflow version', artifact.configObjectVersionId]")
    expect(WORKFLOW_ARTIFACT_APP_HTML).not.toContain("['Script', artifact.configObjectId]")
    const scriptStart = WORKFLOW_ARTIFACT_APP_HTML.indexOf("<script>")
    const scriptEnd = WORKFLOW_ARTIFACT_APP_HTML.lastIndexOf("</script>")
    const inlineScript = scriptStart === -1 || scriptEnd <= scriptStart
      ? undefined
      : WORKFLOW_ARTIFACT_APP_HTML.slice(scriptStart + "<script>".length, scriptEnd)
    expect(inlineScript).toBeDefined()
    expect(() => Function(inlineScript ?? "")).not.toThrow()

    const result = await client.callTool({
      name: WORKFLOW_ARTIFACT_APP_TOOL_NAME,
      arguments: { configObjectId: "configObject_pipeline" },
    })
    expect(result.isError).not.toBe(true)
    expect(workflowArtifactPayloadSchema.parse(result.structuredContent)).toEqual(payload)
    const first = result.content[0]
    expect(first?.type === "text" ? first.text : "").toContain("# Weekly pipeline")
    expect(first?.type === "text" ? first.text : "").toContain("| Qualified | 12 |")
    expect(first?.type === "text" ? first.text : "").toContain("Workflow version: configObjectVersion_4")
    expect(first?.type === "text" ? first.text : "").not.toContain("Script version:")
    expect(result._meta).toEqual({
      schemaVersion: "1",
      receiptId: "codemodeRun_week_32",
      resultDigest: `sha256:${"a".repeat(64)}`,
    })
  })
})

test("deprecated render_dynamic_artifact alias returns the exact canonical success result", async () => {
  await withClient(async (client) => {
    const arguments_ = { configObjectId: "configObject_pipeline" }
    const canonical = await client.callTool({
      name: WORKFLOW_ARTIFACT_APP_TOOL_NAME,
      arguments: arguments_,
    })
    const legacy = await client.callTool({
      name: LEGACY_WORKFLOW_ARTIFACT_TOOL_NAME,
      arguments: arguments_,
    })
    expect(legacy).toEqual(canonical)
    expect(legacy.isError).not.toBe(true)
    expect(workflowArtifactPayloadSchema.parse(legacy.structuredContent)).toEqual(payload)
  })
})

test("deprecated render_dynamic_artifact alias returns the exact canonical parseable error", async () => {
  await withClient(async (client) => {
    const arguments_ = { configObjectId: "configObject_pipeline", receiptId: "missing" }
    const canonical = await client.callTool({
      name: WORKFLOW_ARTIFACT_APP_TOOL_NAME,
      arguments: arguments_,
    })
    const legacy = await client.callTool({
      name: LEGACY_WORKFLOW_ARTIFACT_TOOL_NAME,
      arguments: arguments_,
    })
    expect(legacy).toEqual(canonical)
    expect(legacy.isError).toBe(true)
    const first = legacy.content[0]
    expect(first?.type === "text" ? JSON.parse(first.text) : null).toEqual({
      error: "workflow_snapshot_not_found",
      message: "Snapshot not found.",
    })
  })
})

test("forwards exact receipt and freshness selection without executing a Workflow", async () => {
  const requests: Array<{ configObjectId: string; receiptId?: string; maxAgeMs?: number }> = []
  await withClient(async (client) => {
    const result = await client.callTool({
      name: WORKFLOW_ARTIFACT_APP_TOOL_NAME,
      arguments: {
        configObjectId: "configObject_pipeline",
        receiptId: "codemodeRun_week_32",
        maxAgeMs: 3_600_000,
      },
    })
    expect(result.isError).not.toBe(true)
  }, async (request) => {
    requests.push(request)
    return { ok: true, payload, markdown: "# Weekly pipeline" }
  })
  expect(requests).toEqual([{
    configObjectId: "configObject_pipeline",
    receiptId: "codemodeRun_week_32",
    maxAgeMs: 3_600_000,
  }])
})

test("preserves fail-closed authorization errors for non-UI clients", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: WORKFLOW_ARTIFACT_APP_TOOL_NAME,
      arguments: { configObjectId: "configObject_denied" },
    })
    expect(result.isError).toBe(true)
    const first = result.content[0]
    expect(first?.type === "text" ? JSON.parse(first.text) : null).toEqual({
      error: "workflow_not_found",
      message: "The Workflow is unavailable to this member.",
    })
    expect(result.structuredContent).toBeUndefined()
  }, async () => ({
    ok: false,
    error: "workflow_not_found",
    message: "The Workflow is unavailable to this member.",
  }))
})

test("keeps missing snapshots useful to clients without a UI", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: WORKFLOW_ARTIFACT_APP_TOOL_NAME,
      arguments: {
        configObjectId: "configObject_pipeline",
        receiptId: "missing",
      },
    })
    expect(result.isError).toBe(true)
    const first = result.content[0]
    expect(first?.type === "text" ? JSON.parse(first.text) : null).toEqual({
      error: "workflow_snapshot_not_found",
      message: "Snapshot not found.",
    })
  })
})
