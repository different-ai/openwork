import { createHash } from "node:crypto"
import { ProtocolError, ProtocolErrorCode, type McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { RemoteSkillDescriptor } from "./marketplace-capabilities.js"
import { standardSkillMarkdown, type RemoteSkillSource } from "./skill-tools.js"

/**
 * One Den skill catalog, three ways in:
 *
 * 1. `list_skills` / `get_skill` tools (skill-tools.ts): every MCP client.
 * 2. The MCP Skills Extension (SEP-2640, `io.modelcontextprotocol/skills`):
 *    hosts call `skills/list` / `skills/get` and read each skill:// resource,
 *    so the model loads a remote skill through the host's own skill tool.
 * 3. The skill index (`skill://index.json`) with `delivery: "native"`, which
 *    OpenWork's OpenCode v2 plugin turns into native skills.
 *
 * All three are built from the same descriptors and the same authorized
 * sources, so they cannot drift.
 */

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills"

/** The SKILL.md bytes a skill:// resource read returns, and their SEP-2640 digest. */
export type ResolvedSkillContent = { markdown: string; digest: string; size: number }

export type ResolvedSkill = {
  skill: RemoteSkillDescriptor
  /** Present when the member can load the skill now. */
  content?: ResolvedSkillContent
  /** Present when the skill is listed but withheld until a connection is set up. */
  blocked?: { status: string; message: string }
}

export function skillContent(skill: RemoteSkillDescriptor, source: string): ResolvedSkillContent {
  const markdown = standardSkillMarkdown(skill, source)
  return {
    markdown,
    digest: `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`,
    size: Buffer.byteLength(markdown, "utf8"),
  }
}

/** Pair each descriptor with its authorized content or setup block. Unsynced or vanished skills are dropped. */
export function resolveSkills(skills: RemoteSkillDescriptor[], sources: Map<string, RemoteSkillSource>): ResolvedSkill[] {
  const resolved: ResolvedSkill[] = []
  for (const skill of skills) {
    const source = sources.get(skill.capability)
    if (!source) continue
    if ("blocked" in source) {
      resolved.push({ skill, blocked: { status: source.blocked.status, message: source.blocked.message } })
      continue
    }
    resolved.push({ skill, content: skillContent(skill, source.content) })
  }
  return resolved
}

/** SEP-2640 entry: verbatim frontmatter, the SKILL.md URI and the digest of every file. */
function extensionEntry(resolved: ResolvedSkill & { content: ResolvedSkillContent }) {
  return {
    uri: resolved.skill.location,
    frontmatter: { name: resolved.skill.name, description: resolved.skill.description },
    resources: [{ uri: resolved.skill.location, digest: resolved.content.digest, size: resolved.content.size }],
    _meta: {
      [`${SKILLS_EXTENSION_ID}/title`]: resolved.skill.title,
      ...(resolved.skill.pluginName ? { [`${SKILLS_EXTENSION_ID}/plugin`]: resolved.skill.pluginName } : {}),
    },
  }
}

function loadable(resolved: ResolvedSkill): resolved is ResolvedSkill & { content: ResolvedSkillContent } {
  return resolved.content !== undefined
}

/**
 * Serve the member's skills through the MCP Skills Extension. Skills withheld
 * until a connection is set up are not listed: the extension has no way to say
 * "listed but not readable", and list_skills / get_skill still explain them.
 */
export function registerSkillsExtension(server: McpServer, load: () => Promise<ResolvedSkill[]>) {
  server.server.setRequestHandler(
    "skills/list",
    { params: z.object({ cursor: z.string().optional() }).passthrough() },
    async () => ({ skills: (await load()).filter(loadable).map(extensionEntry) }),
  )
  server.server.setRequestHandler(
    "skills/get",
    { params: z.object({ uri: z.string().min(1) }).passthrough() },
    async ({ uri }) => {
      const match = (await load()).filter(loadable).find((resolved) => resolved.skill.location === uri)
      if (!match) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill at ${uri} is available to you.`)
      return { skill: extensionEntry(match) }
    },
  )
}

const INDEX_DESCRIPTION_CHARS = 160
const INDEX_BUDGET_CHARS = 6_000

/**
 * A short always-on skill index for MCP server instructions, so clients that
 * put server instructions in the system prompt see which skills exist without
 * calling list_skills first. Bounded: it is sent with every session.
 */
export function skillIndexInstructions(skills: RemoteSkillDescriptor[]): string {
  if (skills.length === 0) return ""
  const header = "Skills available to this member (load one with get_skill by its name before doing that kind of task):"
  const lines: string[] = []
  let used = header.length
  for (const skill of skills) {
    const description = skill.description.length > INDEX_DESCRIPTION_CHARS
      ? `${skill.description.slice(0, INDEX_DESCRIPTION_CHARS - 1).trimEnd()}…`
      : skill.description
    const line = `- ${skill.name}: ${description}`
    if (used + line.length + 1 > INDEX_BUDGET_CHARS) {
      lines.push(`- …and ${skills.length - lines.length} more; call list_skills to see them all.`)
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return [header, ...lines].join("\n")
}
