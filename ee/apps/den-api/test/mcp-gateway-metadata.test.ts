import assert from "node:assert/strict"
import { test } from "node:test"
import { McpServer } from "@modelcontextprotocol/server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import type { ConnectToolView } from "../src/mcp/connect-tool-view.js"
import { createAgentMcpServer, AGENT_MCP_GUIDANCE_URI, AGENT_MCP_INSTRUCTIONS, LEGACY_AGENT_MCP_INSTRUCTIONS, MY_AGENT_INSTRUCTIONS } from "../src/mcp/agent-server.js"

for (const toolShapes of [undefined, false, true]) {
  for (const appServers of [true, false]) {
    for (const remoteSessionStatus of [true, false]) {
      test(`gateway initialization preserves identity, capabilities and full guidance (Apps ${appServers}, status ${remoteSessionStatus}, tool shapes ${toolShapes ?? "default"})`, async () => {
        const server = createAgentMcpServer({ appServers, remoteSessionStatus, ...(toolShapes === undefined ? {} : { toolShapes }) })
        const client = new Client({ name: "gateway-metadata-unit-test", version: "1" })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        await server.connect(serverTransport)
        try {
          await client.connect(clientTransport)
          assert.equal(client.getServerVersion()?.name, "openwork-den-api-agent")
          assert.equal(client.getServerVersion()?.version, "1.0.0")
          assert.equal(client.getServerVersion()?.title, "OpenWork Connect")
          assert.equal(client.getServerCapabilities()?.tools?.listChanged, true)
          assert.equal(client.getServerCapabilities()?.resources?.listChanged, true)
          assert.equal(client.getServerCapabilities()?.resources?.subscribe, undefined)
          const instructions = client.getInstructions() ?? ""
          assert.ok(Buffer.byteLength(instructions, "utf8") <= 2048)
          assert.ok(instructions.includes(AGENT_MCP_GUIDANCE_URI))
          assert.equal(instructions.includes("subscriptions/listen"), false)
          assert.equal(instructions.includes("remote-session:status"), remoteSessionStatus)
          assert.equal(instructions.includes("arguments matching each match's inputSchema"), toolShapes === true)
          assert.equal(instructions.includes("Copy external argumentsSchema into body and schemaDigest into schemaDigest"), toolShapes !== true)
          if (toolShapes !== true) {
            const baseInstructions = appServers ? AGENT_MCP_INSTRUCTIONS : LEGACY_AGENT_MCP_INSTRUCTIONS
            assert.equal(instructions, baseInstructions + (remoteSessionStatus ? "\nTo follow remote sessions, call remote-session:status with all of their commandIds or Cloud sessionIds and waitMs instead of calling remote-session:read repeatedly; read only for the transcript or the full answer." : ""))
          }
          const guidance = await client.readResource({ uri: AGENT_MCP_GUIDANCE_URI })
          const text = guidance.contents.flatMap(content => "text" in content ? [content.text] : []).join("\n")
          assert.ok(Buffer.byteLength(text, "utf8") > 2048)
          assert.ok(text.includes("invalid_capability_arguments"))
          assert.ok(text.includes("ambiguous_creation"))
          assert.ok(text.includes("cloudReadiness"))
          assert.equal(text.includes("To build or change an App"), appServers)
          assert.equal(text.includes("Every match is an MCP tool with an inputSchema"), toolShapes === true)
          assert.equal(text.includes("path, query, and body inside arguments"), toolShapes === true)
          assert.equal(text.includes("Put an object matching argumentsSchema in execute_capability.body and copy schemaDigest into execute_capability.schemaDigest"), toolShapes !== true)
          assert.equal(text.includes("invocation.argumentsField"), toolShapes !== true)
        } finally {
          await client.close()
          await server.close()
        }
      })
    }
  }
}

for (const toolShapes of [undefined, false, true]) {
  for (const appServers of [true, false]) {
    test(`full tool view guidance stays direct regardless of capability shapes (Apps ${appServers}, tool shapes ${toolShapes ?? "default"})`, async () => {
      const server = createAgentMcpServer({ appServers, toolView: "full", ...(toolShapes === undefined ? {} : { toolShapes }) })
      const client = new Client({ name: "full-view-guidance-unit-test", version: "1" })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      try {
        await client.connect(clientTransport)
        const instructions = client.getInstructions() ?? ""
        assert.ok(instructions.includes("Every connection action, Workflow, App and remote session you may use is its own tool"))
        assert.equal(instructions.includes("Search capabilities with 2-4 keyword variants"), false)
        assert.equal(instructions.includes("argumentsSchema"), false)
        const guidance = await client.readResource({ uri: AGENT_MCP_GUIDANCE_URI })
        const text = guidance.contents.flatMap(content => "text" in content ? [content.text] : []).join("\n")
        assert.ok(text.startsWith("Every connection action, Workflow, App and remote session you may use is its own tool"))
        assert.ok(text.includes("Call each tool directly with arguments matching its inputSchema."))
        assert.equal(text.includes("argumentsSchema"), false)
        assert.equal(text.includes("schemaDigest"), false)
        assert.equal(text.includes("Every match is an MCP tool with an inputSchema"), false)
        assert.equal(text.includes("To build or change an App"), appServers)
      } finally {
        await client.close()
        await server.close()
      }
    })
  }
}

for (const toolShapes of [false, true]) {
  test(`gateway instructions describe ${toolShapes ? "MCP tool shapes" : "the older match fields"} when connectStandardTools is ${toolShapes ? "on" : "off"}`, async () => {
    const server = createAgentMcpServer({ toolShapes })
    const client = new Client({ name: "gateway-tool-shapes-unit-test", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    try {
      await client.connect(clientTransport)
      const instructions = client.getInstructions() ?? ""
      assert.equal(instructions.includes("Copy external argumentsSchema into body"), !toolShapes)
      assert.equal(instructions.includes("arguments matching each match's inputSchema"), toolShapes)
      const guidance = await client.readResource({ uri: AGENT_MCP_GUIDANCE_URI })
      const text = guidance.contents.flatMap(content => "text" in content ? [content.text] : []).join("\n")
      assert.equal(text.includes("execute_capability.body"), !toolShapes)
    } finally {
      await client.close()
      await server.close()
    }
  })
}

test("an output schema cannot describe a proxy's optional structured content without breaking text-only results", async () => {
  const server = new McpServer({ name: "proxy-output-compatibility", version: "1" })
  const textResult = (): CallToolResult => ({ content: [{ type: "text", text: "Authorized skill instructions" }] })
  server.registerTool("text_proxy", { inputSchema: z.object({}) }, textResult)
  server.registerTool("schema_proxy", { inputSchema: z.object({}), outputSchema: z.looseObject({}) }, textResult)
  const client = new Client({ name: "output-compatibility-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    const preserved = await client.callTool({ name: "text_proxy", arguments: {} })
    assert.notEqual(preserved.isError, true)
    assert.equal(preserved.structuredContent, undefined)
    const rejected = await client.callTool({ name: "schema_proxy", arguments: {} })
    assert.equal(rejected.isError, true)
    assert.match(JSON.stringify(rejected.content), /output schema but no structured content/)
  } finally {
    await client.close()
    await server.close()
  }
})

test("with My agent on, chat is told to change Your agent with putMeAgent and to answer \"why so quiet?\" from its checks; off, nothing is said", async () => {
  async function instructions(options: Parameters<typeof createAgentMcpServer>[0]) {
    const server = createAgentMcpServer(options)
    const client = new Client({ name: "my-agent-guidance-test", version: "1" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    try {
      await client.connect(clientTransport)
      return client.getInstructions() ?? ""
    } finally {
      await client.close()
      await server.close()
    }
  }
  assert.equal(MY_AGENT_INSTRUCTIONS, "To change what Your agent tells the user, use putMeAgent; to explain why it was quiet, read the user's agent checks.")
  const on = await instructions({ myAgent: true })
  assert.ok(on.endsWith(MY_AGENT_INSTRUCTIONS))
  assert.doesNotMatch(await instructions({}), /putMeAgent/)
  const views: ConnectToolView[] = ["search", "full"]
  for (const toolView of views) {
    const everything = await instructions({ myAgent: true, remoteSessionStatus: true, canSendSlackMessages: true, toolView, toolShapes: true })
    assert.ok(Buffer.byteLength(everything, "utf8") <= 2048, `${toolView}: ${Buffer.byteLength(everything, "utf8")} bytes`)
  }
})
