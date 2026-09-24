import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { expect, test } from "bun:test"
import { BUILTIN_SKILLS, executeBuiltinSkillCapability } from "../src/mcp/builtin-skills.js"
import type { RemoteSkillDescriptor } from "../src/mcp/marketplace-capabilities.js"
import {
  GET_SKILL_OUTPUT_SCHEMA,
  GET_SKILL_TOOL_NAME,
  LIST_SKILLS_OUTPUT_SCHEMA,
  LIST_SKILLS_TOOL_NAME,
  registerAgentSkillCatalogTools,
  type RemoteSkillSource,
} from "../src/mcp/skill-tools.js"

const marketplaceSkill: RemoteSkillDescriptor = {
  name: "customer-briefing-a1b2c3d4",
  title: "Customer Briefing",
  description: "Prepare a briefing before a renewal call.",
  marketplaceName: "Revenue",
  pluginName: "Customer Ops",
  capability: "plugin:plg_01h0000000000000000000000a:cob_01h0000000000000000000000b",
  location: "skill://customer-briefing-a1b2c3d4/SKILL.md",
}
const marketplaceSource = "---\nname: customer-briefing\ndescription: stale frontmatter is replaced\n---\n\n# Customer Briefing\n\nRead the account history first."

const builtinSkills = BUILTIN_SKILLS.map((skill) => skill.descriptor)
const catalog: RemoteSkillDescriptor[] = [...builtinSkills, marketplaceSkill]
  .sort((a, b) => a.name.localeCompare(b.name))

type ReadSkill = Parameters<typeof registerAgentSkillCatalogTools>[0]["readSkill"]

const defaultReadSkill: ReadSkill = async (skill): Promise<RemoteSkillSource> => {
  const builtin = executeBuiltinSkillCapability(skill.capability)
  if (builtin) return { content: builtin.content, provenance: builtin.provenance }
  if (skill.capability === marketplaceSkill.capability) {
    return { content: marketplaceSource, provenance: "Customer Ops in your organization's library." }
  }
  return null
}

async function withClient<T>(
  run: (client: Client) => Promise<T>,
  options: { skills?: RemoteSkillDescriptor[]; readSkill?: ReadSkill } = {},
): Promise<T> {
  const server = new McpServer({ name: "skill-tools-test", version: "1.0.0" })
  registerAgentSkillCatalogTools({
    server,
    listSkills: async () => options.skills ?? catalog,
    readSkill: options.readSkill ?? defaultReadSkill,
  })
  const client = new Client({ name: "skill-tools-host-test", version: "1.0.0" })
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

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const part = result.content[0]
  return part?.type === "text" && typeof part.text === "string" ? part.text : ""
}

test("lists list_skills and get_skill as read-only tools with output schemas", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([GET_SKILL_TOOL_NAME, LIST_SKILLS_TOOL_NAME])
    for (const tool of tools.tools) {
      expect(tool.outputSchema).toBeDefined()
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    }
  })
})

test("list_skills returns the whole authorized catalog without keywords", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: LIST_SKILLS_TOOL_NAME, arguments: {} })
    expect(result.isError).not.toBe(true)
    const payload = LIST_SKILLS_OUTPUT_SCHEMA.parse(result.structuredContent)
    expect(payload.total).toBe(catalog.length)
    expect(payload.skills.map((skill) => skill.name)).toEqual(catalog.map((skill) => skill.name))
    expect(payload.skills.find((skill) => skill.name === marketplaceSkill.name)).toEqual({
      name: marketplaceSkill.name,
      title: marketplaceSkill.title,
      description: marketplaceSkill.description,
      capability: marketplaceSkill.capability,
      location: marketplaceSkill.location,
      marketplaceName: "Revenue",
      pluginName: "Customer Ops",
    })
    expect(payload.skills.find((skill) => skill.name === "create-skill")).toMatchObject({ capability: "skill:create-skill" })
    expect(payload.hint).toBeUndefined()
    expect(JSON.parse(firstText(result))).toEqual(payload)
  })
})

test("list_skills narrows by query and bounds by limit", async () => {
  await withClient(async (client) => {
    const narrowed = LIST_SKILLS_OUTPUT_SCHEMA.parse(
      (await client.callTool({ name: LIST_SKILLS_TOOL_NAME, arguments: { query: "customer ops" } })).structuredContent,
    )
    expect(narrowed.skills.map((skill) => skill.name)).toEqual([marketplaceSkill.name])
    expect(narrowed.total).toBe(1)

    const bounded = LIST_SKILLS_OUTPUT_SCHEMA.parse(
      (await client.callTool({ name: LIST_SKILLS_TOOL_NAME, arguments: { limit: 2 } })).structuredContent,
    )
    expect(bounded.skills).toHaveLength(2)
    expect(bounded.total).toBe(catalog.length)
    expect(bounded.hint).toContain(`Showing 2 of ${catalog.length}`)

    const empty = LIST_SKILLS_OUTPUT_SCHEMA.parse(
      (await client.callTool({ name: LIST_SKILLS_TOOL_NAME, arguments: { query: "no such skill anywhere" } })).structuredContent,
    )
    expect(empty.skills).toEqual([])
    expect(empty.hint).toContain("without query")
  })
})

test("get_skill reads a built-in skill by name and a marketplace skill by capability", async () => {
  await withClient(async (client) => {
    const builtin = await client.callTool({ name: GET_SKILL_TOOL_NAME, arguments: { name: "create-skill" } })
    expect(builtin.isError).not.toBe(true)
    const builtinPayload = GET_SKILL_OUTPUT_SCHEMA.parse(builtin.structuredContent)
    expect(builtinPayload).toMatchObject({ name: "create-skill", capability: "skill:create-skill", provenance: "Built into OpenWork Cloud." })
    expect(builtinPayload.content).toStartWith("---\nname: create-skill\ndescription: ")
    expect(builtinPayload.content).toContain("# Create Skill")
    expect(firstText(builtin)).toBe(builtinPayload.content)

    const marketplace = await client.callTool({ name: GET_SKILL_TOOL_NAME, arguments: { name: marketplaceSkill.capability } })
    expect(marketplace.isError).not.toBe(true)
    const marketplacePayload = GET_SKILL_OUTPUT_SCHEMA.parse(marketplace.structuredContent)
    expect(marketplacePayload).toMatchObject({
      name: marketplaceSkill.name,
      capability: marketplaceSkill.capability,
      marketplaceName: "Revenue",
      pluginName: "Customer Ops",
    })
    // Same framing as the skill:// resource: normalized frontmatter, body verbatim.
    expect(marketplacePayload.content).toBe(
      `---\nname: ${marketplaceSkill.name}\ndescription: ${JSON.stringify(marketplaceSkill.description)}\n---\n\n# Customer Briefing\n\nRead the account history first.`,
    )
    expect(marketplacePayload.content).not.toContain("stale frontmatter")
  })
})

test("get_skill reports unknown and withdrawn skills as tool errors", async () => {
  const reads: string[] = []
  await withClient(async (client) => {
    const unknown = await client.callTool({ name: GET_SKILL_TOOL_NAME, arguments: { name: "does-not-exist" } })
    expect(unknown.isError).toBe(true)
    expect(JSON.parse(firstText(unknown))).toMatchObject({ error: "unknown_skill", name: "does-not-exist" })
    expect(firstText(unknown)).toContain("list_skills")

    const withdrawn = await client.callTool({ name: GET_SKILL_TOOL_NAME, arguments: { name: marketplaceSkill.name } })
    expect(withdrawn.isError).toBe(true)
    expect(JSON.parse(firstText(withdrawn))).toMatchObject({ error: "skill_unavailable", name: marketplaceSkill.name })
  }, {
    readSkill: async (skill) => {
      reads.push(skill.capability)
      return null
    },
  })
  // Nothing is read for a name that is not in the catalog.
  expect(reads).toEqual([marketplaceSkill.capability])
})
