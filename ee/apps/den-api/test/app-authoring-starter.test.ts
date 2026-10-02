import { expect, test } from "bun:test"
import { prepareMcpAppOutputSchema } from "@openwork/types/mcp-app"
import { appAuthoringStarter } from "../src/mcp/app-authoring-starter.js"
import { buildGeneratedMcpApp } from "../src/generated-artifact-view-builder.js"

test("the returned starter compiles in the real App sandbox with escaped user text", async () => {
  for (const tools of [[], [{ name: "list_items", description: "List items", capability: "getProjects", kind: "api", mode: "input", readOnly: true, inputSchema: { type: "object" } }]] satisfies Parameters<typeof appAuthoringStarter>[1][]) {
    const input = { title: 'Items </main> {"unsafe"}', description: "A compact starting point." }
    const prepared = prepareMcpAppOutputSchema.parse(appAuthoringStarter(input, tools))
    const built = await buildGeneratedMcpApp({ ...prepared.starter, ...input })
    expect(built.ok).toBe(true)
    expect(prepared.tools).toEqual(tools)
    expect(prepared.starter.reactSource).not.toContain('Items </main>')
    if (tools.length) {
      expect(prepared.starter.reactSource).toContain('name: "list_items"')
      expect(prepared.starter.reactSource).toContain('onClick={run}')
    }
  }
})
