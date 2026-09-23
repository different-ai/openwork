import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { workflowRunnerAppHtml } from "@openwork/mcp-apps/workflow-runner"
import {
  workflowRunnerOpenOutputSchema,
  workflowRunnerRunOutputSchema,
  workflowRunnerResourceUri,
  type WorkflowRunnerCatalog,
  type WorkflowRunnerResult,
} from "@openwork/types/workflow-runner-app"
import { expect, mock, test } from "bun:test"
import { registerAgentWorkflowRunnerApp } from "../src/mcp/workflow-runner-app.js"
import type { WorkflowRunnerService } from "../src/mcp/workflow-runner-service.js"
import { workflowArtifactAppServerCapabilities } from "../src/mcp/workflow-artifact-app.js"

const workflow = {
  pluginId: "plg_fixture",
  configObjectId: "cob_fixture",
  configObjectVersionId: "cov_fixture",
  title: "Daily summary",
  description: "Read current totals.",
  blockedReason: null,
}
const catalog: WorkflowRunnerCatalog = { schemaVersion: "1", kind: "workflow_catalog", workflows: [workflow], hasMore: false }
const result: WorkflowRunnerResult = {
  schemaVersion: "1", kind: "workflow_result", workflow, value: { count: 3 }, receiptId: "wfr_fixture",
  resultDigest: "sha256:fixture", outputSchemaDigest: null,
}

async function withClient(run: (client: Client, service: WorkflowRunnerService) => Promise<void>, options: {
  app?: boolean
  service?: WorkflowRunnerService
} = {}) {
  const service = options.service ?? {
    open: mock(async () => catalog),
    run: mock(async () => result),
  }
  const server = new McpServer({ name: "workflow-runner-test", version: "1.0.0" }, {
    capabilities: workflowArtifactAppServerCapabilities,
  })
  registerAgentWorkflowRunnerApp({ server, service })
  const client = new Client({ name: "portable-client", version: "1.0.0" }, {
    capabilities: options.app ? workflowArtifactAppServerCapabilities : {},
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    await run(client, service)
  } finally {
    await client.close()
    await server.close()
  }
}

test("standard clients see fixed launch binding and a model/app run tool without a UI binding", async () => {
  for (const app of [false, true]) await withClient(async (client, service) => {
    expect(client.getServerCapabilities()?.extensions).toEqual(workflowArtifactAppServerCapabilities.extensions)
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual(["open_workflows", "run_workflow_readonly"])
    expect(listed.tools[0]?._meta).toEqual({
      ui: { resourceUri: workflowRunnerResourceUri, visibility: ["model", "app"] },
      "ui/resourceUri": workflowRunnerResourceUri,
    })
    expect(listed.tools[1]?._meta).toEqual({ ui: { visibility: ["model", "app"] } })
    for (const tool of listed.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(tool.outputSchema).toBeDefined()
      expect(JSON.stringify(tool)).not.toContain('"openwork/')
      expect(JSON.stringify(tool)).not.toContain("mcp:app-host")
    }
    const resources = await client.listResources()
    expect(resources.resources).toHaveLength(1)
    expect(resources.resources[0]).toMatchObject({ uri: workflowRunnerResourceUri, mimeType: "text/html;profile=mcp-app" })
    const read = await client.readResource({ uri: workflowRunnerResourceUri })
    expect(read.contents).toEqual([{
      uri: workflowRunnerResourceUri, mimeType: "text/html;profile=mcp-app", text: workflowRunnerAppHtml,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } },
    }])
    expect(workflowRunnerAppHtml).not.toContain(workflow.title)
    expect(workflowRunnerAppHtml).not.toContain(workflow.configObjectId)
    expect(service.open).not.toHaveBeenCalled()
    expect(service.run).not.toHaveBeenCalled()
  }, { app })
})

test("launch lists only and both App and text clients receive readable catalog and run results", async () => {
  for (const app of [false, true]) await withClient(async (client, service) => {
    const opened = await client.callTool({ name: "open_workflows", arguments: { query: "Daily" } })
    expect(workflowRunnerOpenOutputSchema.parse(opened.structuredContent)).toEqual(catalog)
    expect(opened.content).toEqual([{ type: "text", text: expect.stringContaining("Daily summary") }])
    expect(opened.content).toEqual([{ type: "text", text: expect.stringContaining("cov_fixture") }])
    expect(service.run).not.toHaveBeenCalled()
    const selected = { pluginId: workflow.pluginId, configObjectId: workflow.configObjectId, configObjectVersionId: workflow.configObjectVersionId }
    const ran = await client.callTool({ name: "run_workflow_readonly", arguments: { ...selected, timeZone: "UTC" } })
    expect(workflowRunnerRunOutputSchema.parse(ran.structuredContent)).toEqual(result)
    expect(ran.content).toEqual([{ type: "text", text: expect.stringContaining("Receipt: wfr_fixture") }])
    expect(ran.content).toEqual([{ type: "text", text: expect.stringContaining("3") }])
    expect(ran._meta).toBeUndefined()
    expect(service.run).toHaveBeenCalledWith({ ...selected, timeZone: "UTC" })
  }, { app })
})

test("empty catalog explains the Workflow prerequisite and errors remain structured and sanitized", async () => {
  await withClient(async (client) => {
    const opened = await client.callTool({ name: "open_workflows", arguments: {} })
    expect(opened.structuredContent).toEqual({ ...catalog, workflows: [] })
    expect(opened.content).toEqual([{ type: "text", text: expect.stringContaining("No accessible Workflows") }])
    const ran = await client.callTool({ name: "run_workflow_readonly", arguments: {
      pluginId: "plg_fixture", configObjectId: "cob_fixture", configObjectVersionId: "cov_fixture",
    } })
    expect(ran.isError).toBe(true)
    expect(workflowRunnerRunOutputSchema.parse(ran.structuredContent).kind).toBe("workflow_error")
    expect(JSON.stringify(ran)).not.toContain("secret-value")
  }, { service: {
    open: async () => ({ ...catalog, workflows: [] }),
    run: async () => { throw new Error("secret-value") },
  } })
})

test("SDK rejects extra code, input, mode flags, absent IDs, oversized query and invalid field types before callbacks", async () => {
  await withClient(async (client, service) => {
    const selected = { pluginId: "plg_fixture", configObjectId: "cob_fixture", configObjectVersionId: "cov_fixture" }
    const requests = [
      { name: "open_workflows", arguments: { query: "x".repeat(201) } },
      { name: "open_workflows", arguments: { query: 2 } },
      { name: "open_workflows", arguments: { run: true } },
      { name: "run_workflow_readonly", arguments: {} },
      ...[
        { input: {} }, { body: {} }, { data: {} }, { runtime: {} }, { code: "return 1" },
        { mode: "live" }, { readOnly: false }, { validateScriptOutput: false }, { timeZone: 5 },
        { pluginId: "" }, { configObjectVersionId: null },
      ].map((extra) => ({ name: "run_workflow_readonly", arguments: { ...selected, ...extra } })),
    ]
    for (const request of requests) {
      const response = await client.callTool(request)
      expect(response.isError).toBe(true)
    }
    expect(service.open).not.toHaveBeenCalled()
    expect(service.run).not.toHaveBeenCalled()
  })
})
