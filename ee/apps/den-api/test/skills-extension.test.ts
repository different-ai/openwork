import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server"
import { z } from "zod"
import { createAgentMcpHttpHandler } from "../src/mcp/agent-http.js"
import { createAgentMcpServer } from "../src/mcp/agent-server.js"
import type { RemoteSkillDescriptor } from "../src/mcp/marketplace-capabilities.js"
import { registerSkillsExtension, resolveSkills, skillIndexInstructions, SKILLS_EXTENSION_ID } from "../src/mcp/skills-extension.js"

const refunds: RemoteSkillDescriptor = {
  name: "refunds-ab12cd34",
  title: "Refunds",
  description: "Process customer refund requests per company policy. Use when someone asks to refund an order.",
  pluginName: "Support",
  capability: "plugin:plg_1:cob_1",
  location: "skill://refunds-ab12cd34/SKILL.md",
}
const crm: RemoteSkillDescriptor = {
  name: "crm-sync-ef56gh78",
  title: "CRM sync",
  description: "Sync the CRM.",
  pluginName: "Sales",
  capability: "plugin:plg_2:cob_2",
  location: "skill://crm-sync-ef56gh78/SKILL.md",
}

function resolved() {
  return resolveSkills([refunds, crm, { ...crm, name: "gone", capability: "plugin:plg_3:cob_3", location: "skill://gone/SKILL.md" }], new Map([
    [refunds.capability, { content: "---\nname: whatever\n---\n\nRefund within 30 days." }],
    [crm.capability, { blocked: { status: "needs_connection", message: "Connect Salesforce first.", action: null } }],
  ]))
}

function fixture(options: { skillIndex?: string } = {}) {
  const handler = createAgentMcpHttpHandler(() => {
    const server = createAgentMcpServer({ skillsExtension: true, ...options })
    registerSkillsExtension(server, async () => resolved())
    return server
  })
  return async (method: string, params: object) => {
    const response = await handler.fetch(new Request("https://example.test/mcp/agent", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
        [PROTOCOL_VERSION_META_KEY]: "2026-07-28", [CLIENT_INFO_META_KEY]: { name: "skills-test-client", version: "1" }, [CLIENT_CAPABILITIES_META_KEY]: {},
      } } }),
    }))
    return response.json()
  }
}

test("resolveSkills pairs each skill with its standard SKILL.md digest, or its setup block, and drops vanished skills", () => {
  const [loaded, blocked, ...rest] = resolved()
  assert.equal(rest.length, 0)
  assert.ok(loaded?.content)
  assert.equal(loaded.content.markdown, `---\nname: refunds-ab12cd34\ndescription: ${JSON.stringify(refunds.description)}\n---\n\nRefund within 30 days.`)
  assert.equal(loaded.content.digest, `sha256:${createHash("sha256").update(loaded.content.markdown).digest("hex")}`)
  assert.equal(loaded.content.size, Buffer.byteLength(loaded.content.markdown))
  assert.deepEqual(blocked?.blocked, { status: "needs_connection", message: "Connect Salesforce first." })
  assert.equal(blocked?.content, undefined)
})

test("skills/list and skills/get follow SEP-2640 and list only skills the member can load", async () => {
  const call = fixture()
  const list = z.object({ result: z.object({ skills: z.array(z.object({
    uri: z.string(),
    frontmatter: z.object({ name: z.string(), description: z.string() }),
    resources: z.array(z.object({ uri: z.string(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), size: z.number() })),
  })) }) }).parse(await call("skills/list", {}))
  assert.deepEqual(list.result.skills.map((skill) => skill.uri), [refunds.location])
  assert.deepEqual(list.result.skills[0]?.frontmatter, { name: refunds.name, description: refunds.description })
  assert.equal(list.result.skills[0]?.resources[0]?.uri, refunds.location)

  const got = z.object({ result: z.object({ skill: z.object({ uri: z.string() }) }) }).parse(await call("skills/get", { uri: refunds.location }))
  assert.equal(got.result.skill.uri, refunds.location)
  const missing = z.object({ error: z.object({ message: z.string() }) }).parse(await call("skills/get", { uri: crm.location }))
  assert.match(missing.error.message, /No skill at skill:\/\/crm-sync/)
})

test("the server advertises the skills extension and appends the skill index to its instructions", async () => {
  const call = fixture({ skillIndex: skillIndexInstructions([refunds]) })
  const discovered = z.object({ result: z.looseObject({
    capabilities: z.looseObject({ extensions: z.record(z.string(), z.unknown()) }),
    instructions: z.string(),
  }) }).parse(await call("server/discover", {}))
  assert.ok(SKILLS_EXTENSION_ID in discovered.result.capabilities.extensions)
  assert.match(discovered.result.instructions, /- refunds-ab12cd34: Process customer refund requests/)
})

test("the skill index is bounded and points at list_skills for the rest", () => {
  const many = Array.from({ length: 200 }, (_, index) => ({ ...refunds, name: `skill-${index}`, description: "x".repeat(400) }))
  const index = skillIndexInstructions(many)
  assert.ok(index.length < 6_200)
  assert.match(index, /…and \d+ more; call list_skills/)
  assert.equal(skillIndexInstructions([]), "")
})
