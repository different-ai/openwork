import { createHash } from "node:crypto"
import { ProtocolError, ProtocolErrorCode, type McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { executeBuiltinSkillCapability } from "./builtin-skills.js"
import type { RemoteSkillDescriptor } from "./marketplace-capabilities.js"
import { standardSkillMarkdown } from "./skill-tools.js"

/**
 * MCP Skills extension (SEP-2640, `io.modelcontextprotocol/skills`).
 *
 * `skills/list` and `skills/get` describe the same `skill://<name>/SKILL.md`
 * resources this endpoint already serves, so any client that implements the
 * extension can discover them without OpenWork-specific tools. OpenWork's own
 * routing facts ride in each entry's `_meta`; the SKILL.md frontmatter stays
 * name + description, exactly as `resources/read` and `get_skill` return it.
 */

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills"
export const SKILL_ENTRY_META_KEY = "openwork/skill"

export const skillsExtensionServerCapabilities = {
  [SKILLS_EXTENSION_ID]: {},
}

type SkillResource = { uri: string; digest: string; size: number }

export type SkillEntry = {
  uri: string
  frontmatter: { name: string; description: string }
  /** Built-ins are fixed text, so they carry digests; organization skills change and are read per member. */
  resources: SkillResource[] | "dynamic"
  _meta: {
    [SKILL_ENTRY_META_KEY]: {
      capability: string
      title: string
      marketplaceName?: string
      pluginName?: string
      modelDiscovery: boolean
    }
  }
}

function builtinResources(skill: RemoteSkillDescriptor): SkillResource[] | null {
  const builtin = executeBuiltinSkillCapability(skill.capability)
  if (!builtin) return null
  const text = standardSkillMarkdown(skill, builtin.content)
  return [{ uri: skill.location, digest: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`, size: Buffer.byteLength(text, "utf8") }]
}

export function skillEntry(skill: RemoteSkillDescriptor, modelDiscovery: boolean): SkillEntry {
  return {
    uri: skill.location,
    frontmatter: { name: skill.name, description: skill.description },
    resources: builtinResources(skill) ?? "dynamic",
    _meta: {
      [SKILL_ENTRY_META_KEY]: {
        capability: skill.capability,
        title: skill.title,
        ...(skill.marketplaceName ? { marketplaceName: skill.marketplaceName } : {}),
        ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
        modelDiscovery,
      },
    },
  }
}

export function registerSkillsExtension(input: {
  server: McpServer
  loadSkills: () => Promise<RemoteSkillDescriptor[]>
  modelDiscovery: boolean
}) {
  // One page: the member's authorized catalog is already bounded and sorted.
  input.server.server.setRequestHandler(
    "skills/list",
    { params: z.object({ cursor: z.string().optional() }).passthrough().optional() },
    async () => ({
      resultType: "complete",
      skills: (await input.loadSkills()).map((skill) => skillEntry(skill, input.modelDiscovery)),
    }),
  )
  input.server.server.setRequestHandler(
    "skills/get",
    { params: z.object({ uri: z.string() }).passthrough() },
    async (params) => {
      const skill = (await input.loadSkills()).find((candidate) => candidate.location === params.uri)
      if (!skill) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill: ${params.uri}`)
      return { resultType: "complete", skill: skillEntry(skill, input.modelDiscovery) }
    },
  )
}
