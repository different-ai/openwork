import assert from "node:assert/strict"
import { test } from "node:test"
import { McpServer } from "@modelcontextprotocol/server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

// Skills registration imports Den configuration; initialize the test's inert
// configuration before loading the server. Metadata tests do not connect to MySQL.
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_metadata_test"
process.env.DEN_DB_ENCRYPTION_KEY = "metadata-test-db-encryption-key-not-for-production-1234567890"
process.env.BETTER_AUTH_SECRET = "metadata-test-auth-secret-not-for-production-1234567890"
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
const { createAgentMcpServer, AGENT_MCP_GUIDANCE_URI } = await import("../src/mcp/agent-server.js")

for (const appServers of [true, false]) {
  for (const remoteSessionEvents of [true, false]) {
    test(`gateway initialization preserves identity, capabilities and full guidance (Apps ${appServers}, receipts ${remoteSessionEvents})`, async () => {
      const server = createAgentMcpServer({ appServers, remoteSessionEvents })
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
        assert.equal(client.getServerCapabilities()?.resources?.subscribe, remoteSessionEvents || undefined)
        const instructions = client.getInstructions() ?? ""
        assert.ok(Buffer.byteLength(instructions, "utf8") <= 2048)
        assert.ok(instructions.includes(AGENT_MCP_GUIDANCE_URI))
        assert.equal(instructions.includes("subscriptions/listen"), remoteSessionEvents)
        const guidance = await client.readResource({ uri: AGENT_MCP_GUIDANCE_URI })
        const text = guidance.contents.flatMap(content => "text" in content ? [content.text] : []).join("\n")
        assert.ok(Buffer.byteLength(text, "utf8") > 2048)
        assert.ok(text.includes("invalid_capability_arguments"))
        assert.ok(text.includes("ambiguous_creation"))
        assert.ok(text.includes("cloudReadiness"))
        assert.equal(text.includes("To build or change an App"), appServers)
      } finally {
        await client.close()
        await server.close()
      }
    })
  }
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
