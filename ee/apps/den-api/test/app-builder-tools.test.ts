import assert from "node:assert/strict"
import test from "node:test"
import { McpServer } from "@modelcontextprotocol/server"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpAppInputSchema, prepareMcpAppInputSchema, readMcpAppInputSchema, updateMcpAppInputSchema } from "@openwork/types/mcp-app"
import { z } from "zod"
import { BUILD_AN_APP_SKILL_SOURCE } from "../src/mcp/build-an-app-skill.js"
import { appAuthoringStarter } from "../src/mcp/app-authoring-starter.js"

import { registerAppBuilderTools } from "../src/mcp/app-builder-tools.js"
import { buildMarketplaceCapabilityName } from "../src/mcp/marketplace-capability-name.js"

const jsonSchema = z.object({
  description: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  items: z.unknown().optional(),
}).passthrough()

function assertDescriptions(value: unknown, path: string) {
  const schema = jsonSchema.parse(value)
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const property = jsonSchema.parse(field)
    assert.ok(property.description?.trim(), `${path}.${name} needs a description`)
    assertDescriptions(field, `${path}.${name}`)
  }
  if (schema.items) assertDescriptions(schema.items, `${path}[]`)
}

test("App preparation lists built-in libraries", () => {
  const input = { title: "Procedural scene" }
  const on = appAuthoringStarter(input, [])
  for (const specifier of ["lucide-react", "recharts", "motion/react", "three/addons/controls/OrbitControls.js"]) {
    assert.match(on.nextSteps.at(-1) ?? "", new RegExp(`"${specifier}"|${specifier} for`))
  }
  assert.match(on.nextSteps.at(-1) ?? "", /<svg>/)
  assert.match(BUILD_AN_APP_SKILL_SOURCE, /When prepare_app's nextSteps lists built-in libraries, import only those/)
})

test("App source cannot grant itself library access", () => {
  const parsed = createMcpAppInputSchema.safeParse({
    title: "Procedural scene",
    reactSource: "export default function Scene() { return <p>Scene</p> }",
    textFallback: "A procedural scene.",
    allowLibraries: true,
  })
  assert.equal(parsed.success, false)
  if (!parsed.success) assert.equal(parsed.error.issues[0]?.message, 'Unrecognized key: "allowLibraries"')
})

test("Marketplace capability names retain their wire format", () => {
  assert.equal(buildMarketplaceCapabilityName("plugin-id", "object-id"), "plugin:plugin-id:object-id")
})

test("App builder metadata describes all inputs and keeps create_app concise", async (t) => {
  const server = new McpServer({ name: "app-builder-metadata-test", version: "1.0.0" })
  const unavailable = async () => { throw new Error("Metadata test must not run an App operation") }
  registerAppBuilderTools({
    server,
    scopes: new Set(),
    service: { prepare: unavailable, create: unavailable, update: unavailable, read: unavailable },
    publicOrigin: "https://example.com",
    notifyCatalogChanged() {},
  })
  const client = new Client({ name: "metadata-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const { tools } = await client.listTools()
    assert.equal(tools.length, 4)
    for (const tool of tools) assertDescriptions(tool.inputSchema, tool.name)
    const create = tools.find((tool) => tool.name === "create_app")
    assert.ok(create?.description)
    const descriptionBytes = Buffer.byteLength(create.description, "utf8")
    assert.ok(descriptionBytes <= 2048)
    t.diagnostic(`create_app description: ${descriptionBytes} UTF-8 bytes`)
    assert.match(create.description, /skill:build-an-app/)
    assert.equal(tools.find((tool) => tool.name === "read_app")?.title, "Read an App")

    // Only descriptions may differ from the shared validators' JSON schemas.
    const stripDescriptions = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stripDescriptions)
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).filter(([key, child]) => !(key === "description" && typeof child === "string") && key !== "$schema").map(([key, child]) => [key, stripDescriptions(child)]))
      }
      return value
    }
    for (const [name, schema] of Object.entries({ prepare_app: prepareMcpAppInputSchema, create_app: createMcpAppInputSchema, update_app: updateMcpAppInputSchema, read_app: readMcpAppInputSchema })) {
      assert.deepEqual(stripDescriptions(tools.find((tool) => tool.name === name)?.inputSchema), stripDescriptions(z.toJSONSchema(schema)), name)
    }
    assert.match(BUILD_AN_APP_SKILL_SOURCE, /result is no longer undefined/)
    assert.match(BUILD_AN_APP_SKILL_SOURCE, /openwork\/result-cache/)
    assert.match(BUILD_AN_APP_SKILL_SOURCE, /one such call per click/)
    assert.match(BUILD_AN_APP_SKILL_SOURCE, /app\.revisionId/)
  } finally {
    await client.close()
    await server.close()
  }
})
