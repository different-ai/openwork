import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  uiArtifactRenderResultSchema,
  uiArtifactSearchResultSchema,
} from "@openwork/types/ui-artifact"

test("startable stdio MCP exposes two tools and retains approval state", { timeout: 30_000 }, async () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
  const cwd = fileURLToPath(new URL("..", import.meta.url))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", cli],
    cwd,
    stderr: "pipe",
  })
  const client = new Client({ name: "ui-artifact-mcp-test", version: "1.0.0" })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["search_artifacts", "use_artifact"])

    const searched = await client.callTool({
      name: "search_artifacts",
      arguments: { query: "approvals awaiting my decision", limit: 1 },
    })
    const search = uiArtifactSearchResultSchema.parse(searched.structuredContent)
    const match = search.matches[0]
    assert.equal(match?.artifactId, "work.approvals")

    const rendered = await client.callTool({
      name: "use_artifact",
      arguments: match?.toolDefinition.exampleArguments,
    })
    const initial = uiArtifactRenderResultSchema.parse(rendered.structuredContent)
    assert.equal(initial.artifact.revision, 1)

    const decided = await client.callTool({
      name: "use_artifact",
      arguments: {
        operation: "decide",
        artifactId: "work.approvals",
        instanceId: initial.artifact.instanceId,
        itemId: "expense-lisbon",
        decision: "approve",
        expectedRevision: 1,
      },
    })
    const updated = uiArtifactRenderResultSchema.parse(decided.structuredContent)
    assert.equal(updated.artifact.revision, 2)
    assert.equal(updated.interaction?.decision, "approve")

    const rerendered = await client.callTool({
      name: "use_artifact",
      arguments: match?.toolDefinition.exampleArguments,
    })
    const current = uiArtifactRenderResultSchema.parse(rerendered.structuredContent)
    assert.equal(current.artifact.revision, 2)
  } finally {
    await client.close()
  }
})
