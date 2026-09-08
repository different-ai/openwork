import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { expect, test } from "bun:test"
import {
  CONNECTION_ACTION_APP_HTML,
  CONNECTION_ACTION_APP_RESOURCE_URI,
  CONNECTION_ACTION_TOOL_NAME,
  connectedConnectionActionPayload,
  connectionActionErrorCard,
  connectionActionLaunch,
  connectionActionSearchCard,
  connectionActionPayloadFromStatus,
  connectionActionPayloadSchema,
  connectionActionTextFallback,
  registerAgentConnectionActionApp,
  type ConnectionActionProbeResult,
} from "../src/mcp/connection-action-app.js"
import type { ExternalConnectionStatus } from "../src/mcp/external-capabilities.js"
import { workflowArtifactAppServerCapabilities } from "../src/mcp/workflow-artifact-app.js"

const needsSignInStatus: ExternalConnectionStatus = {
  version: 1,
  kind: "connection_action",
  source: "openwork-cloud",
  layer: "downstream_provider",
  connectionId: "emc_gmail",
  connectionName: "Gmail",
  authType: "oauth",
  credentialMode: "per_member",
  state: "needs_connection",
  errorCode: "not_connected",
  message: "You haven't connected your Gmail account yet.",
  actor: "member",
  action: {
    type: "connect",
    label: "Connect Gmail",
    surface: "openwork_your_connections",
    retry: "search_capabilities",
    url: "https://app.openworklabs.com/dashboard/connections/emc_gmail",
  },
}

async function withClient<T>(
  run: (client: Client) => Promise<T>,
  probe: (request: { connectionId: string }) => Promise<ConnectionActionProbeResult> =
    async () => ({ ok: true, payload: connectionActionPayloadFromStatus(needsSignInStatus) }),
): Promise<T> {
  const server = new McpServer(
    { name: "connection-action-test", version: "1.0.0" },
    { capabilities: workflowArtifactAppServerCapabilities },
  )
  registerAgentConnectionActionApp({ server, probe })
  const client = new Client(
    { name: "connection-action-host-test", version: "1.0.0" },
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

test("lists connection_action as an app-only tool with its ui:// resource", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools()
    const tool = tools.tools.find((candidate) => candidate.name === CONNECTION_ACTION_TOOL_NAME)
    expect(tool?._meta).toMatchObject({
      ui: {
        resourceUri: CONNECTION_ACTION_APP_RESOURCE_URI,
        visibility: ["app"],
      },
    })

    const resources = await client.listResources()
    expect(resources.resources).toContainEqual(expect.objectContaining({
      uri: CONNECTION_ACTION_APP_RESOURCE_URI,
      mimeType: "text/html;profile=mcp-app",
    }))

    const resource = await client.readResource({ uri: CONNECTION_ACTION_APP_RESOURCE_URI })
    const content = resource.contents[0]
    expect(content && "text" in content ? content.text : "").toBe(CONNECTION_ACTION_APP_HTML)
    expect(CONNECTION_ACTION_APP_HTML).toStartWith("<!doctype html>")
    expect(CONNECTION_ACTION_APP_HTML).toContain("ui/notifications/tool-result")
    expect(CONNECTION_ACTION_APP_HTML).not.toContain("<script src=")
  })
})

test("connection status payloads carry the exact human action and same-server launch", () => {
  const payload = connectionActionPayloadFromStatus(needsSignInStatus)
  expect(connectionActionPayloadSchema.parse(payload)).toEqual({
    schemaVersion: "1",
    connectionId: "emc_gmail",
    connectionName: "Gmail",
    state: "needs_connection",
    actor: "member",
    message: "You haven't connected your Gmail account yet.",
    action: {
      type: "connect",
      label: "Connect Gmail",
      surface: "openwork_your_connections",
      url: "https://app.openworklabs.com/dashboard/connections/emc_gmail",
    },
  })
  expect(connectionActionLaunch(payload)).toEqual({
    toolName: CONNECTION_ACTION_TOOL_NAME,
    resourceUri: CONNECTION_ACTION_APP_RESOURCE_URI,
    arguments: { connectionId: "emc_gmail" },
  })
  const match = { kind: "connection_status", connectionStatus: needsSignInStatus }
  const searchCard = connectionActionSearchCard([match])
  expect(searchCard?.connectionAction).toEqual(payload)
  expect(searchCard?.meta).toEqual({ "openwork/mcpApp": connectionActionLaunch(payload) })
  expect(connectionActionSearchCard([match, match])).toEqual(searchCard)
  expect(connectionActionSearchCard([])).toBeNull()
  expect(connectionActionSearchCard([{ kind: "tool" }])).toBeNull()
  expect(connectionActionSearchCard([match, {
    ...match, connectionStatus: { ...needsSignInStatus, connectionId: "emc_other" },
  }])).toBeNull()
  const fallback = connectionActionTextFallback(payload)
  expect(fallback).toContain("# Connection needs attention: Gmail")
  expect(fallback).toContain("Action: Connect Gmail")
  expect(fallback).toContain("Open: https://app.openworklabs.com/dashboard/connections/emc_gmail")

  const connected = connectedConnectionActionPayload({ connectionId: "emc_gmail", connectionName: "Gmail" })
  expect(connected.state).toBe("connected")
  expect(connected.action).toBeNull()
  expect(connectionActionTextFallback(connected)).toContain("# Connection ready: Gmail")
})

test("needs_connection tool failures carry the same card as the probe", () => {
  const card = connectionActionErrorCard(needsSignInStatus)
  const parsed = connectionActionPayloadSchema.parse(card.structuredContent)
  expect(parsed.state).toBe("needs_connection")
  expect(parsed.action?.label).toBe("Connect Gmail")
  expect(card.meta).toEqual({
    "openwork/mcpApp": {
      toolName: CONNECTION_ACTION_TOOL_NAME,
      resourceUri: CONNECTION_ACTION_APP_RESOURCE_URI,
      arguments: { connectionId: "emc_gmail" },
    },
  })
})

test("the app-only tool probes live status and returns schema-valid structured content", async () => {
  const probed: string[] = []
  await withClient(async (client) => {
    const result = await client.callTool({
      name: CONNECTION_ACTION_TOOL_NAME,
      arguments: { connectionId: "emc_gmail" },
    })
    expect(result.isError).not.toBe(true)
    const parsed = connectionActionPayloadSchema.parse(result.structuredContent)
    expect(parsed.state).toBe("needs_connection")
    expect(parsed.action?.label).toBe("Connect Gmail")
    const checked = await client.callTool({
      name: CONNECTION_ACTION_TOOL_NAME,
      arguments: { connectionId: "emc_gmail" },
    })
    expect(checked.isError).not.toBe(true)
    const connected = connectionActionPayloadSchema.parse(checked.structuredContent)
    expect(connected.state).toBe("connected")
    expect(connected.action).toBeNull()
    expect(connected.connectionId).toBe("emc_gmail")
  }, async ({ connectionId }) => {
    probed.push(connectionId)
    return { ok: true, payload: probed.length === 1
      ? connectionActionPayloadFromStatus(needsSignInStatus)
      : connectedConnectionActionPayload({ connectionId, connectionName: "Gmail" }) }
  })
  expect(probed).toEqual(["emc_gmail", "emc_gmail"])
})
