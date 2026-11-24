import { createHash } from "node:crypto"
import { ProtocolError, ProtocolErrorCode, type McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { RemoteSkillDescriptor } from "./marketplace-capabilities.js"
import { skillFileResource, type SkillFileEntry, type SkillFileResource } from "../skill-files.js"
import { standardSkillMarkdown, type RemoteSkillSource } from "./skill-tools.js"

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills"

export type ResolvedSkillContent = { markdown: string; digest: string; size: number; files: SkillFileResource[] }

export type ResolvedSkill = {
  skill: RemoteSkillDescriptor
  content?: ResolvedSkillContent
  blocked?: { status: string; message: string }
}

export function skillContent(skill: RemoteSkillDescriptor, source: string, files: readonly SkillFileEntry[] = []): ResolvedSkillContent {
  const markdown = standardSkillMarkdown(skill, source)
  return {
    markdown,
    digest: `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`,
    size: Buffer.byteLength(markdown, "utf8"),
    files: files.map((file) => skillFileResource(skill.name, file)),
  }
}

function skillRootUri(skill: RemoteSkillDescriptor): string {
  return skill.location.slice(0, -"SKILL.md".length)
}

export function findSkillFile(resolved: readonly ResolvedSkill[], uri: string): SkillFileResource | undefined {
  for (const entry of resolved) {
    if (!entry.content || !uri.startsWith(skillRootUri(entry.skill))) continue
    const file = entry.content.files.find((candidate) => candidate.uri === uri)
    if (file) return file
  }
  return undefined
}

export function resolveSkills(skills: RemoteSkillDescriptor[], sources: Map<string, RemoteSkillSource>): ResolvedSkill[] {
  const resolved: ResolvedSkill[] = []
  for (const skill of skills) {
    const source = sources.get(skill.capability)
    if (!source) continue
    if ("blocked" in source) {
      resolved.push({ skill, blocked: { status: source.blocked.status, message: source.blocked.message } })
      continue
    }
    resolved.push({ skill, content: skillContent(skill, source.content, source.files) })
  }
  return resolved
}

function extensionEntry(resolved: ResolvedSkill & { content: ResolvedSkillContent }) {
  return {
    uri: resolved.skill.location,
    frontmatter: { name: resolved.skill.name, description: resolved.skill.description },
    resources: [
      { uri: resolved.skill.location, digest: resolved.content.digest, size: resolved.content.size },
      ...resolved.content.files.map((file) => ({ uri: file.uri, digest: file.digest, size: file.size })),
    ],
    _meta: {
      [`${SKILLS_EXTENSION_ID}/title`]: resolved.skill.title,
      ...(resolved.skill.pluginName ? { [`${SKILLS_EXTENSION_ID}/plugin`]: resolved.skill.pluginName } : {}),
    },
  }
}

function loadable(resolved: ResolvedSkill): resolved is ResolvedSkill & { content: ResolvedSkillContent } {
  return resolved.content !== undefined
}

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

export function skillIndexInstructions(skills: readonly RemoteSkillDescriptor[], budgetChars: number): string {
  const header = "Skills available to this member (load one with get_skill by its name before doing that kind of task):"
  const more = (count: number) => `- …and ${count} more; call list_skills to see them all.`
  if (skills.length === 0 || header.length + 1 + more(skills.length).length > budgetChars) return ""
  const lines: string[] = []
  let used = header.length
  for (const [index, skill] of skills.entries()) {
    const description = skill.description.length > INDEX_DESCRIPTION_CHARS
      ? `${skill.description.slice(0, INDEX_DESCRIPTION_CHARS - 1).trimEnd()}…`
      : skill.description
    const line = `- ${skill.name}: ${description}`
    const pointer = index === skills.length - 1 ? 0 : more(skills.length - index - 1).length + 1
    if (used + line.length + 1 + pointer > budgetChars) {
      lines.push(more(skills.length - index))
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return [header, ...lines].join("\n")
}
