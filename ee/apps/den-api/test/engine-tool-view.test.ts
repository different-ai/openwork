import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { CapabilityRegistryContext, CapabilitySource, CapabilitySourceKind } from "../src/mcp/capability-registry.js"
import type { CapabilityMatch } from "../src/mcp/search.js"

// No database or network: the registry's sources are faked below. Its modules'
// default adapters still need a valid local configuration at import time.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/engine_tool_view_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-engine-tool-view-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-engine-tool-view-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { db } = await import("../src/db.js")
// Better Auth seeds its resource registry on import. Return an already-present
// synthetic registry row while the modules initialize, without SQL I/O.
const bootstrapSelect = mock.method(db, "select", () => ({
  from() { return { async where() { return [{ id: "unit_oauth_resource", identifier: "http://unit.test/mcp/agent", policyVersion: 1 }] } } },
}))
const { auth } = await import("../src/auth.js")
await auth.$context
bootstrapSelect.mock.restore()

const { CAPABILITY_SOURCE_KINDS, createCapabilityRegistry } = await import("../src/mcp/capability-registry.js")
const { AGENT_MCP_GUIDANCE_URI, AGENT_MCP_INSTRUCTIONS_MAX_CHARS, createAgentMcpServer } = await import("../src/mcp/agent-server.js")
const { connectToolView } = await import("../src/mcp/connect-tool-view.js")
const { engineToolName, serviceDirectoryInstructions, withRelatedWords } = await import("../src/mcp/engine-tool-view.js")

const ENGINE = { name: "opencode", version: "2.0.26" }

test("OpenWork's engine follows its own rollout; every other client keeps connectStandardTools", () => {
  const engine = { firstPartyToken: true, engineTools: true }
  assert.equal(connectToolView(ENGINE, { enabled: false, ...engine }), "full")
  assert.equal(connectToolView(ENGINE, { enabled: true, ...engine }), "full")
  assert.equal(connectToolView(ENGINE, { enabled: false, ...engine, override: "search" }), "search")
  // Off, the engine keeps capability search, whatever connectStandardTools says.
  assert.equal(connectToolView(ENGINE, { enabled: true, firstPartyToken: true, engineTools: false }), "search")
  assert.equal(connectToolView(ENGINE, { enabled: false, firstPartyToken: true, engineTools: false }), "search")
  // Standalone OpenCode (its own OAuth token), Claude Code and others never follow the engine's rollout.
  assert.equal(connectToolView(ENGINE, { enabled: false, firstPartyToken: false, engineTools: true }), "search")
  assert.equal(connectToolView({ name: "claude-code" }, { enabled: false, ...engine }), "search")
  assert.equal(connectToolView({ name: "claude-code" }, { enabled: true, ...engine }), "full")
  assert.equal(connectToolView({ name: "cursor" }, { enabled: true, ...engine }), "search")
})

test("descriptions gain the other names for the things they mention, never verbs", () => {
  assert.equal(withRelatedWords("Create a new issue.", "create_issue"), "Create a new issue. Related words: ticket.")
  assert.equal(
    withRelatedWords("List calendar events in a date range.", "listEvents"),
    "List calendar events in a date range. Related words: meeting, appointment.",
  )
  // Plurals and camelCase count; words already present are not repeated.
  assert.equal(withRelatedWords("Find teammates.", "searchUsers"), "Find teammates. Related words: colleague, member, people, person.")
  assert.equal(withRelatedWords("Update a ticket or issue.", "update_issue"), "Update a ticket or issue.")
  assert.equal(withRelatedWords("Delete a row.", "delete_row"), "Delete a row.")
})

test("the service directory names ready services first, fits its budget and points at search() for the rest", () => {
  const services = [
    { namespace: "notion", name: "Notion", ready: false },
    { namespace: "linear", name: "Linear", ready: true },
    { namespace: "google_workspace", name: "Google Workspace", ready: true },
  ]
  const directory = serviceDirectoryInstructions(services, 4_096)
  assert.deepEqual(directory.split("\n").slice(1), [
    "- google_workspace_: Google Workspace",
    "- linear_: Linear",
    "- notion_: Notion, not connected for you yet (connection_status shows how)",
  ])
  assert.match(directory, /^Connected services, by the prefix of their tool names; find a service's tools with search\(\):/)

  const many = Array.from({ length: 200 }, (_, index) => ({ namespace: `service_${index}`, name: `Service ${index}`, ready: true }))
  for (const budget of [300, 1_500]) {
    const cut = serviceDirectoryInstructions(many, budget)
    assert.ok(cut.length <= budget, `${cut.length} > ${budget}`)
    const listed = cut.split("\n").filter((line) => line.startsWith("- service_")).length
    assert.ok(listed > 0)
    assert.match(cut, new RegExp(`\\n- …and ${many.length - listed} more; search\\(\\) finds them\\.$`))
  }
  assert.equal(serviceDirectoryInstructions(many, 100), "")
  assert.equal(serviceDirectoryInstructions([], 4_096), "")
})

test("engine tool names follow OpenCode's sanitizing", () => {
  assert.equal(engineToolName("linear.list_issues"), "linear_list_issues")
  assert.equal(engineToolName("notion.notion-search"), "notion_notion-search")
  assert.equal(engineToolName("run-workflow.weekly_report"), "run-workflow_weekly_report")
})

async function discovered(options: Parameters<typeof createAgentMcpServer>[0]) {
  const server = createAgentMcpServer(options)
  const client = new Client({ name: "engine-tool-view-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
    const guidance = await client.readResource({ uri: AGENT_MCP_GUIDANCE_URI })
    return {
      instructions: client.getInstructions() ?? "",
      guidance: guidance.contents.flatMap((content) => "text" in content ? [content.text] : []).join("\n"),
    }
  } finally {
    await client.close()
    await server.close()
  }
}

test("the engine's instructions name its tools, keep search for the rest and list services within the limit", async () => {
  const services = Array.from({ length: 120 }, (_, index) => ({ namespace: `service_${index}`, name: `Service ${index}`, ready: index % 3 !== 0 }))
  const engine = await discovered({ toolView: "full", engine: true, services, remoteSessionStatus: true, canSendSlackMessages: true, myAgent: true })
  assert.ok(engine.instructions.length <= AGENT_MCP_INSTRUCTIONS_MAX_CHARS, String(engine.instructions.length))
  assert.match(engine.instructions, /<service>_<action>, run-workflow_<name>, open-app_<name> and remote-session_<action>/)
  assert.match(engine.instructions, /search_capabilities and execute_capability cover only OpenWork's own operations and skills/)
  assert.match(engine.instructions, /openwork-bot_slack_send_as_bot/)
  assert.match(engine.instructions, /\nConnected services, by the prefix of their tool names/)
  assert.match(engine.instructions, /search\(\) finds them\.$/)
  // The guidance keeps both how to call a tool and how to use a search match.
  assert.match(engine.guidance, /Call each tool directly with arguments matching its inputSchema\./)
  assert.match(engine.guidance, /Put an object matching argumentsSchema in execute_capability\.body/)

  // Without the engine flag the full view and the search view are unchanged.
  const full = await discovered({ toolView: "full", services })
  assert.doesNotMatch(full.instructions, /Connected services|cover only OpenWork's own operations/)
  assert.match(full.instructions, /<service>\.<action>, run-workflow\.<name>/)
  assert.doesNotMatch(full.guidance, /Put an object matching argumentsSchema/)
  const search = await discovered({ engine: true, services })
  assert.doesNotMatch(search.instructions, /Connected services|<service>_<action>/)
})

function match(name: string, kind?: string): CapabilityMatch {
  return { name, method: "MCP", path: name, score: 1, summary: name, pathParams: [], queryParams: [], hasBody: true, ...(kind ? { kind } : {}) }
}

test("search for the engine leaves out what the full view lists as tools", async () => {
  const searched: CapabilitySourceKind[] = []
  const fake = (kind: CapabilitySourceKind): CapabilitySource => ({
    kind,
    parseName: () => null,
    search: async () => {
      searched.push(kind)
      return kind === "marketplace" ? [match("plugin:plg_1:cob_workflow", "workflow"), match("plugin:plg_1:cob_skill", "skill")] : [match(`${kind}:one`)]
    },
    enumerate: () => ({ excluded: "unit test" }),
    execute: async () => ({ content: [] }),
  })
  const registry = createCapabilityRegistry(Object.fromEntries(CAPABILITY_SOURCE_KINDS.map((kind) => [kind, fake(kind)])) as Record<CapabilitySourceKind, CapabilitySource>)
  const context = {} as CapabilityRegistryContext

  const unlisted = await registry.search(context, { query: "anything", limit: 20, unlistedOnly: true })
  assert.deepEqual([...searched].sort(), ["admin", "builtinSkill", "catalog", "marketplace"])
  assert.deepEqual(unlisted.matches.map((entry) => entry.name).sort(), ["admin:one", "builtinSkill:one", "catalog:one", "plugin:plg_1:cob_skill"])

  searched.length = 0
  const everything = await registry.search(context, { query: "anything", limit: 20 })
  assert.equal(searched.length, CAPABILITY_SOURCE_KINDS.length)
  assert.equal(everything.matches.length, CAPABILITY_SOURCE_KINDS.length + 1)
})
