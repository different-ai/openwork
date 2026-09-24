import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { RemoteSkillDescriptor } from "./marketplace-capabilities.js"
import { tokenize } from "./search.js"

/**
 * Direct skill tools for the `/mcp/agent` endpoint.
 *
 * Skills stay reachable through `search_capabilities` (type `skills`) and
 * `execute_capability`, and through the `skill://` resources. These two tools
 * are the path that needs no keyword guessing: `list_skills` returns the
 * member's whole authorized catalog and `get_skill` returns one SKILL.md by
 * its name or exact capability.
 */

export const LIST_SKILLS_TOOL_NAME = "list_skills"
export const GET_SKILL_TOOL_NAME = "get_skill"
const LIST_SKILLS_MAX_LIMIT = 200

export const SKILL_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const remoteSkillDescriptorSchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  capability: z.string(),
  location: z.string(),
  marketplaceName: z.string().optional(),
  pluginName: z.string().optional(),
})

export const LIST_SKILLS_OUTPUT_SCHEMA = z.object({
  skills: z.array(remoteSkillDescriptorSchema),
  total: z.number().int().nonnegative(),
  hint: z.string().optional(),
})

export const GET_SKILL_OUTPUT_SCHEMA = remoteSkillDescriptorSchema.extend({
  provenance: z.string().optional(),
  content: z.string(),
})

export type ListSkillsPayload = z.infer<typeof LIST_SKILLS_OUTPUT_SCHEMA>
export type GetSkillPayload = z.infer<typeof GET_SKILL_OUTPUT_SCHEMA>

/** Authorized SKILL.md source for one descriptor, or null once it is gone. */
export type RemoteSkillSource = { content: string; provenance?: string } | null

/** Standard SKILL.md framing: normalized frontmatter, then the source body verbatim. */
export function standardSkillMarkdown(skill: RemoteSkillDescriptor, source: string): string {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/^\s+/, "")
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${body}`
}

function describeRemoteSkill(skill: RemoteSkillDescriptor): z.infer<typeof remoteSkillDescriptorSchema> {
  return {
    name: skill.name,
    title: skill.title,
    description: skill.description,
    capability: skill.capability,
    location: skill.location,
    ...(skill.marketplaceName ? { marketplaceName: skill.marketplaceName } : {}),
    ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
  }
}

/** Resolve a skill by exact capability first, then by name or skill:// location. */
export function findRemoteSkill(skills: RemoteSkillDescriptor[], reference: string): RemoteSkillDescriptor | undefined {
  const wanted = reference.trim()
  if (!wanted) return undefined
  const lowered = wanted.toLowerCase()
  return skills.find((skill) => skill.capability === wanted)
    ?? skills.find((skill) => skill.name === wanted)
    ?? skills.find((skill) => skill.location === wanted)
    ?? skills.find((skill) => skill.name === lowered)
}

/** Keep skills whose name, title, description, marketplace, or plugin contains every query token. */
export function filterRemoteSkills(skills: RemoteSkillDescriptor[], query?: string): RemoteSkillDescriptor[] {
  const tokens = tokenize(query ?? "")
  if (tokens.length === 0) return skills
  return skills.filter((skill) => {
    const haystack = [skill.name, skill.title, skill.description, skill.marketplaceName ?? "", skill.pluginName ?? ""]
      .join(" ")
      .toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}

function jsonText(value: unknown): CallToolResult["content"] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }]
}

function skillErrorResult(error: "unknown_skill" | "skill_unavailable", name: string, message: string): CallToolResult {
  return {
    isError: true,
    content: jsonText({ error, name, message }),
  }
}

export function registerAgentSkillCatalogTools(input: {
  server: McpServer
  /** Every skill the calling member may use right now, built-in and marketplace alike. */
  listSkills: () => Promise<RemoteSkillDescriptor[]>
  /** The authorized SKILL.md source for one listed skill. */
  readSkill: (skill: RemoteSkillDescriptor) => Promise<RemoteSkillSource>
}) {
  input.server.registerTool(
    LIST_SKILLS_TOOL_NAME,
    {
      title: "List skills",
      description: [
        "List every skill available to the signed-in OpenWork member: the built-in Cloud skills plus each marketplace or plugin skill they may use.",
        "Needs no keywords. Each entry carries the stable name, the exact capability, the title and description, and the marketplace / plugin source when known.",
        "Pass the returned name or capability to get_skill to read that skill's SKILL.md. Use query only to narrow a long catalog.",
      ].join(" "),
      annotations: SKILL_TOOL_ANNOTATIONS,
      inputSchema: z.object({
        query: z.string().trim().max(200).optional().describe("Optional keywords; keeps skills whose name, title, description, marketplace, or plugin contains every word. Omit to list everything."),
        limit: z.number().int().min(1).max(LIST_SKILLS_MAX_LIMIT).optional().describe(`Max number of skills to return. Defaults to every match, at most ${LIST_SKILLS_MAX_LIMIT}.`),
      }),
      outputSchema: LIST_SKILLS_OUTPUT_SCHEMA,
    },
    async ({ query, limit }) => {
      const matches = filterRemoteSkills(await input.listSkills(), query)
      const skills = matches.slice(0, limit ?? LIST_SKILLS_MAX_LIMIT).map(describeRemoteSkill)
      const hint = matches.length === 0
        ? query
          ? "No skill matches those words. Call list_skills without query to see every available skill."
          : "No skills are available to this member yet."
        : skills.length < matches.length
          ? `Showing ${skills.length} of ${matches.length} matching skills. Raise limit or add query to narrow.`
          : undefined
      const payload: ListSkillsPayload = { skills, total: matches.length, ...(hint ? { hint } : {}) }
      return { content: jsonText(payload), structuredContent: payload }
    },
  )

  input.server.registerTool(
    GET_SKILL_TOOL_NAME,
    {
      title: "Get skill",
      description: [
        "Read one skill's authorized SKILL.md by its name or exact capability, as returned by list_skills or the skill index.",
        "The text content is the complete SKILL.md; read it fully before following it.",
        "Returns unknown_skill when nothing matches — call list_skills for the exact name.",
      ].join(" "),
      annotations: SKILL_TOOL_ANNOTATIONS,
      inputSchema: z.object({
        name: z.string().trim().min(1).max(512).describe("The skill name (e.g. create-skill) or its exact capability (e.g. skill:create-skill or plugin:<pluginId>:<configObjectId>)."),
      }),
      outputSchema: GET_SKILL_OUTPUT_SCHEMA,
    },
    async ({ name }) => {
      const skill = findRemoteSkill(await input.listSkills(), name)
      if (!skill) {
        return skillErrorResult("unknown_skill", name, `No skill named "${name}" is available to you. Call list_skills for the exact name or capability.`)
      }
      const source = await input.readSkill(skill)
      if (!source) {
        return skillErrorResult("skill_unavailable", name, `Skill "${skill.name}" is no longer available. Call list_skills for the current catalog.`)
      }
      const payload: GetSkillPayload = {
        ...describeRemoteSkill(skill),
        ...(source.provenance ? { provenance: source.provenance } : {}),
        content: standardSkillMarkdown(skill, source.content),
      }
      return { content: [{ type: "text", text: payload.content }], structuredContent: payload }
    },
  )
}
