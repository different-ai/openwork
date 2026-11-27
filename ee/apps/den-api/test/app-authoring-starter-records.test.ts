import assert from "node:assert/strict"
import test from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import type { McpAppStorage, McpAppToolBinding } from "@openwork/types/mcp-app"
import { buildGeneratedMcpApp } from "../src/generated-artifact-view-builder.js"
import { appAuthoringStarter, appStarter, appStarterResourceUri, registerAppStarterResources } from "../src/mcp/app-authoring-starter.js"
import { buildAnAppSkillSource } from "../src/mcp/build-an-app-skill.js"

const title = { name: "title", required: true, type: "text" } as const
const allFields: McpAppStorage = {
  collections: [{
    name: "requests",
    fields: [
      title,
      { name: "estimate", type: "number", required: true },
      { name: "urgent", type: "boolean" },
      { name: "due", type: "date" },
      { name: "status", type: "text", options: ["new", "in_review", "done", "<svg>", "require('x')"] },
    ],
  }, { name: "comments", fields: [title] }],
}

const cases: [string, McpAppStorage][] = [
  ["all field types and options", allFields],
  ["personal scope", { collections: [{ name: "notes", scope: "personal", fields: [title] }] }],
  ["creator-only edits", { collections: [{ name: "requests", edit: "creator", fields: [title] }] }],
]

for (const [label, storage] of cases) {
  test(`compiles the records starter with ${label}`, async () => {
    const { pattern, reactSource, cssSource } = appStarter([], storage)
    assert.equal(pattern, "records")
    const result = await buildGeneratedMcpApp({ reactSource, cssSource, title: "Saved requests", description: null })
    assert.equal(result.ok, true, result.diagnostics.map((item) => item.message).join("\n"))
  })
}

const lookup: McpAppToolBinding = {
  name: "list_requests",
  description: "List requests",
  capability: "sample-list",
  kind: "mcp",
  mode: "input",
  readOnly: true,
  inputSchema: { type: "object", properties: {} },
}
const action: McpAppToolBinding = { ...lookup, capability: "sample-create", name: "create_request", readOnly: false }

test("keeps existing starter selection when no storage is declared", () => {
  const inputs: [string, McpAppToolBinding[]][] = [["standalone", []], ["lookup", [lookup]], ["action", [lookup, action]]]
  for (const [pattern, tools] of inputs) {
    const starter = appStarter(tools)
    assert.equal(starter.pattern, pattern)
    assert.doesNotMatch(starter.reactSource, /storage_read|storage_write|openwork\/storage/)
    assert.deepEqual(appStarter(tools, undefined), starter)
  }
})

test("prepare prefers the first collection and names the unwired tools", () => {
  const prepared = appAuthoringStarter({ title: "Requests", storage: allFields }, [lookup, action])
  assert.match(prepared.starter.reactSource, /const COLLECTION = \{\s*name: "requests"/)
  assert.doesNotMatch(prepared.starter.reactSource, /name: "comments"/)
  assert.match(prepared.nextSteps.join("\n"), /Also declared but not wired yet: list_requests, create_request/)
  assert.match(prepared.nextSteps.join("\n"), /preparationId and the same storage declaration/)
})

test("lists and serves the records resource only with storage on", async () => {
  async function resources(storage?: boolean) {
    const server = new McpServer({ name: "starters", version: "1.0.0" })
    const client = new Client({ name: "starter-test", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    if (storage === undefined) registerAppStarterResources(server)
    else registerAppStarterResources(server, { storage })
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      const uri = appStarterResourceUri("records")
      const listed = await client.listResources()
      if (storage) {
        const { contents: [content] } = await client.readResource({ uri })
        assert.ok(content && "text" in content && typeof content.text === "string")
        assert.match(content.text, /"pattern":"records"/)
        assert.match(content.text, /"storage":\{"collections"/)
        assert.match(content.text, /storage_read/)
      } else {
        await assert.rejects(client.readResource({ uri }), /not found/i)
      }
      return listed
    } finally {
      await client.close()
      await server.close()
    }
  }
  const defaultList = await resources()
  assert.deepEqual(await resources(false), defaultList)
  assert.deepEqual(defaultList.resources.map(({ uri }) => uri), ["lookup", "action", "standalone"].map(appStarterResourceUri))
  const enabled = await resources(true)
  assert.deepEqual(enabled.resources.slice(0, 3), defaultList.resources)
  assert.equal(enabled.resources[3]?.uri, appStarterResourceUri("records"))
})

test("adds saved-data authoring instructions only with storage on", () => {
  for (const language of ["codemode-js", "ecmascript"] as const) {
    const original = buildAnAppSkillSource(language)
    assert.equal(buildAnAppSkillSource(language, { storage: false }), original)
    // The pre-existing skill says "storage" for the read cache and "records"
    // for ordinary result rows; do not remove those mentions from the off text.
    assert.doesNotMatch(original, /saved data|## Saved data|^- records \(|storage_read|storage_write|read_app_data|openwork\/storage/m)
    const enabled = buildAnAppSkillSource(language, { storage: true })
    for (const marker of ["## Saved data", "storage_read", "storage_write", "read_app_data", appStarterResourceUri("records")]) {
      assert.ok(enabled.includes(marker), marker)
    }
  }
})
