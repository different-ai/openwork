import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { expect, test } from "bun:test"
import {
  attachPluginFlowCard,
  PLUGIN_FLOW_APP_HTML,
  PLUGIN_FLOW_APP_RESOURCE_URI,
  PLUGIN_FLOW_TOOL_NAME,
  pluginFlowPayloadForCapability,
  pluginFlowPayloadSchema,
  registerAgentPluginFlowApp,
} from "../src/mcp/plugin-flow-app.js"
import { workflowArtifactAppServerCapabilities } from "../src/mcp/workflow-artifact-app.js"

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = new McpServer(
    { name: "plugin-flow-test", version: "1.0.0" },
    { capabilities: workflowArtifactAppServerCapabilities },
  )
  registerAgentPluginFlowApp(server)
  const client = new Client(
    { name: "plugin-flow-host-test", version: "1.0.0" },
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

test("lists plugin_flow as an app-only tool with its ui:// resource", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools()
    const tool = tools.tools.find((candidate) => candidate.name === PLUGIN_FLOW_TOOL_NAME)
    expect(tool?._meta).toMatchObject({
      ui: {
        resourceUri: PLUGIN_FLOW_APP_RESOURCE_URI,
        visibility: ["app"],
      },
    })

    const resource = await client.readResource({ uri: PLUGIN_FLOW_APP_RESOURCE_URI })
    const content = resource.contents[0]
    expect(content && "text" in content ? content.text : "").toBe(PLUGIN_FLOW_APP_HTML)
    expect(PLUGIN_FLOW_APP_HTML).toStartWith("<!doctype html>")
    expect(PLUGIN_FLOW_APP_HTML).toContain("ui/notifications/tool-result")
    expect(PLUGIN_FLOW_APP_HTML).not.toContain("<script src=")
  })
})

test("maps library sharing capabilities to schema-valid card payloads", () => {
  expect(pluginFlowPayloadForCapability({
    name: "postMarketplacesPlugins",
    path: { marketplaceId: "mkt_demo" },
    body: { pluginId: "plg_demo" },
  })).toEqual({
    schemaVersion: "1",
    mode: "marketplace_plugin_added",
    pluginId: "plg_demo",
    marketplaceId: "mkt_demo",
    recipient: null,
  })

  expect(pluginFlowPayloadForCapability({
    name: "postPluginsAccess",
    path: { pluginId: "plg_demo" },
    body: { orgMembershipId: "om_demo", role: "viewer" },
  })).toEqual({
    schemaVersion: "1",
    mode: "plugin_access_granted",
    pluginId: "plg_demo",
    marketplaceId: null,
    recipient: { kind: "member", id: "om_demo", role: "viewer" },
  })

  expect(pluginFlowPayloadForCapability({
    name: "postMarketplacesAccess",
    path: { marketplaceId: "mkt_demo" },
    body: { teamId: "tem_demo", role: "manager" },
  })).toEqual({
    schemaVersion: "1",
    mode: "marketplace_access_granted",
    pluginId: null,
    marketplaceId: "mkt_demo",
    recipient: { kind: "team", id: "tem_demo", role: "manager" },
  })

  expect(pluginFlowPayloadForCapability({
    name: "getMarketplaces",
    path: {},
    body: {},
  })).toBeNull()
})

test("attaches the same-server launch to successful sharing results only", () => {
  const success = attachPluginFlowCard({
    name: "postPluginsAccess",
    path: { pluginId: "plg_demo" },
    body: { orgWide: true, role: "viewer" },
    result: {
      content: [{ type: "text" as const, text: "{\"ok\":true}" }],
    },
  })
  expect(pluginFlowPayloadSchema.parse(success.structuredContent)).toMatchObject({
    mode: "plugin_access_granted",
    recipient: { kind: "org_wide", id: null, role: "viewer" },
  })
  expect(success._meta).toEqual({
    "openwork/mcpApp": {
      toolName: PLUGIN_FLOW_TOOL_NAME,
      resourceUri: PLUGIN_FLOW_APP_RESOURCE_URI,
      arguments: { mode: "plugin_access_granted" },
    },
  })

  const failure = attachPluginFlowCard({
    name: "postPluginsAccess",
    path: { pluginId: "plg_demo" },
    body: { orgMembershipId: "om_demo" },
    result: {
      isError: true,
      content: [{ type: "text" as const, text: "{\"error\":\"forbidden\"}" }],
    },
  })
  expect(failure._meta).toBeUndefined()

  const untracked = attachPluginFlowCard({
    name: "postPlugins",
    path: {},
    body: { name: "Demo" },
    result: {
      content: [{ type: "text" as const, text: "{\"ok\":true}" }],
    },
  })
  expect(untracked._meta).toBeUndefined()
})
