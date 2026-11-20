import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { RemoteSkillDescriptor } from "./marketplace-capabilities.js"
import { tokenize } from "./search.js"
import { skillFileMimeType, skillFileText, skillFileUri, type SkillFileEntry } from "../skill-files.js"

// Small images go back as image content, which models can see.
const VIEWABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const VIEWABLE_IMAGE_MAX_BYTES = 1024 * 1024

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
  name: z.string().describe("Stable skill name accepted by get_skill."),
  title: z.string().describe("Human-readable skill title."),
  description: z.string().describe("Summary of what the skill does and when to use it."),
  capability: z.string().describe("Exact capability identifier accepted by get_skill or execute_capability."),
  location: z.string().describe("skill:// resource URI for this skill."),
  marketplaceName: z.string().optional().describe("Source marketplace's display name, when known."),
  pluginName: z.string().optional().describe("Source Plugin's display name, when known."),
})

export const LIST_SKILLS_OUTPUT_SCHEMA = z.object({
  skills: z.array(remoteSkillDescriptorSchema).describe("Authorized matching skill descriptors, capped by limit; does not include SKILL.md content."),
  total: z.number().int().nonnegative().describe("Number of authorized matching skills before applying limit."),
  hint: z.string().optional().describe("Guidance when the catalog is empty or the returned list is truncated."),
})

export const GET_SKILL_OUTPUT_SCHEMA = remoteSkillDescriptorSchema.extend({
  provenance: z.string().optional().describe("Source or attribution information for the skill, when available."),
  content: z.string().describe("Complete authorized SKILL.md with normalized name and description frontmatter followed by the source instructions; with file, that file's text instead, or a note when the file is binary."),
  files: z.array(z.object({
    path: z.string().describe("Path relative to the skill's folder; pass it as file to read it."),
    size: z.number().int().nonnegative().describe("Size in bytes."),
  })).optional().describe("The skill's supporting files (references, scripts, templates), when it has any."),
  filesNote: z.string().optional().describe("How to read the supporting files: the note the text response ends with, for clients that show structured content instead of text."),
  file: z.object({
    path: z.string().describe("The supporting file that content holds."),
    mimeType: z.string().describe("Its media type."),
    binary: z.boolean().optional().describe("True when the file is not text: content is a note, and the bytes come from its skill:// resource."),
  }).optional().describe("Present when a supporting file was read instead of SKILL.md."),
})

export type ListSkillsPayload = z.infer<typeof LIST_SKILLS_OUTPUT_SCHEMA>
export type GetSkillPayload = z.infer<typeof GET_SKILL_OUTPUT_SCHEMA>

/** Authorized SKILL.md source for one descriptor, or null once it is gone. */
/**
 * The authorized SKILL.md, or why it is held back. A marketplace skill whose
 * plugin still needs a connection set up is listed but its text is withheld;
 * `blocked` carries the readiness hint and the action that unblocks it.
 */
export type RemoteSkillSource =
  | { content: string; provenance?: string; files?: SkillFileEntry[] }
  | { blocked: { status: string; message: string; action: unknown } }
  | null

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

function plainSkillName(value: string): string {
  return value.split("/")
    .map((part) => part.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter(Boolean)
    .join("/")
}

/**
 * Skills by the name a person or agent would use: the title without the
 * unique suffix list_skills adds ("task-management" for
 * task-management-w925wxnt), optionally qualified by plugin
 * ("productivity/task-management").
 */
export function findRemoteSkillsByPlainName(skills: RemoteSkillDescriptor[], reference: string): RemoteSkillDescriptor[] {
  const wanted = plainSkillName(reference)
  if (!wanted) return []
  return skills.filter((skill) => {
    const title = plainSkillName(skill.title)
    return title === wanted || (skill.pluginName ? `${plainSkillName(skill.pluginName)}/${title}` === wanted : false)
  })
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

/** Tells the model which files came with the skill and how to read one; empty when there are none. */
export function supportingFilesNote(skill: RemoteSkillDescriptor, files: readonly { path: string }[]): string {
  if (files.length === 0) return ""
  return [
    `Supporting files of this skill. Paths in the skill are relative to its folder. Read one with get_skill ${JSON.stringify({ name: skill.capability, file: "<path>" })}:`,
    ...files.map((entry) => `- ${entry.path}`),
  ].join("\n")
}

function skillErrorResult(error: "unknown_skill" | "unknown_skill_file" | "skill_unavailable" | "skill_needs_setup", name: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return {
    isError: true,
    content: jsonText({ error, name, message, ...extra }),
  }
}

export function registerAgentSkillCatalogTools(input: {
  server: McpServer
  /** Every skill the calling member may use right now, built-in and marketplace alike. */
  listSkills: () => Promise<RemoteSkillDescriptor[]>
  /** The authorized SKILL.md source for one listed skill, with its supporting files; `file` is set when the call reads one of them. */
  readSkill: (skill: RemoteSkillDescriptor, read: { file?: string }) => Promise<RemoteSkillSource>
  /** One listed supporting file's contents, or null when they cannot be read. */
  readFile: (file: SkillFileEntry) => Promise<Uint8Array | null>
}) {
  input.server.registerTool(
    LIST_SKILLS_TOOL_NAME,
    {
      title: "List skills",
      description: [
        "List every skill available to the signed-in OpenWork member: the built-in Cloud skills plus each marketplace or plugin skill they may use.",
        "Read-only; requires an active OpenWork membership. Returns skills (authorized matching descriptors, without SKILL.md content), total (matches before limit), and an optional hint for empty or truncated results.",
        "Needs no keywords. Each entry carries the stable name, the exact capability, the title and description, and the marketplace / plugin source when known.",
        "Pass the returned name or capability to get_skill to read that skill's SKILL.md. Use query only to narrow a long catalog.",
      ].join(" "),
      annotations: SKILL_TOOL_ANNOTATIONS,
      inputSchema: z.object({
        query: z.string().trim().max(200).optional().describe("Keywords to narrow the authorized catalog; every search token must appear in the skill's name, title, description, marketplace, or plugin. Omit to browse without filtering."),
        limit: z.number().int().min(1).max(LIST_SKILLS_MAX_LIMIT).optional().describe("Number of matching skill descriptors to include; total still counts all matches, so use query to narrow a truncated catalog."),
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
        "Read-only; requires an active OpenWork membership and access to the skill. The text response is the complete SKILL.md; read it fully before following it.",
        "Structured content returns the skill descriptor plus content (the complete normalized SKILL.md) and optional provenance; it does not execute the instructions.",
        "A skill may come with supporting files such as references/GUIDE.md; they are listed after the SKILL.md and in files. Pass file with one of those paths to read it.",
        "Returns unknown_skill for missing or ambiguous references, skill_unavailable if the source is gone, or skill_needs_setup with status and action when a required connection is not ready. Call list_skills for an exact name or capability.",
      ].join(" "),
      annotations: SKILL_TOOL_ANNOTATIONS,
      inputSchema: z.object({
        name: z.string().trim().min(1).max(512).describe("The skill name (e.g. create-skill) or its exact capability (e.g. skill:create-skill or plugin:<pluginId>:<configObjectId>)."),
        file: z.string().trim().min(1).max(255).optional().describe("A supporting file of the skill to read instead of SKILL.md, as a path relative to the skill's folder (e.g. references/GUIDE.md)."),
      }),
      outputSchema: GET_SKILL_OUTPUT_SCHEMA,
    },
    async ({ name, file }) => {
      const skills = await input.listSkills()
      const plainMatches = findRemoteSkill(skills, name) ? [] : findRemoteSkillsByPlainName(skills, name)
      if (plainMatches.length > 1) {
        return skillErrorResult("unknown_skill", name, `Several skills are named "${name}". Pass one of these capabilities.`, {
          candidates: plainMatches.map((candidate) => ({ name: candidate.name, capability: candidate.capability, pluginName: candidate.pluginName ?? null })),
        })
      }
      const skill = findRemoteSkill(skills, name) ?? plainMatches[0]
      if (!skill) {
        return skillErrorResult("unknown_skill", name, `No skill named "${name}" is available to you. Call list_skills for the exact name or capability.`)
      }
      const source = await input.readSkill(skill, { ...(file ? { file } : {}) })
      if (source && "blocked" in source) {
        return skillErrorResult("skill_needs_setup", name, source.blocked.message, { status: source.blocked.status, action: source.blocked.action })
      }
      if (!source) {
        return skillErrorResult("skill_unavailable", name, `Skill "${skill.name}" is no longer available. Call list_skills for the current catalog.`)
      }
      const files = (source.files ?? []).map((entry) => ({ path: entry.path, size: entry.size }))
      if (file) {
        const wanted = file.replace(/^\.\//, "")
        const match = source.files?.find((entry) => entry.path === wanted)
        if (!match) {
          return skillErrorResult("unknown_skill_file", name, files.length > 0
            ? `Skill "${skill.name}" has no file "${file}". Pass one of the listed paths.`
            : `Skill "${skill.name}" has no supporting files.`, { files: files.map((entry) => entry.path) })
        }
        const bytes = await input.readFile(match)
        if (!bytes) return skillErrorResult("skill_unavailable", name, `File "${match.path}" of skill "${skill.name}" could not be read. Try again.`)
        const text = skillFileText(bytes)
        if (text !== null) {
          const filePayload: GetSkillPayload = {
            ...describeRemoteSkill(skill),
            content: text,
            file: { path: match.path, mimeType: skillFileMimeType(match.path) },
          }
          return { content: [{ type: "text", text }], structuredContent: filePayload }
        }
        const mimeType = skillFileMimeType(match.path, false)
        const viewable = VIEWABLE_IMAGE_TYPES.has(mimeType) && bytes.byteLength <= VIEWABLE_IMAGE_MAX_BYTES
        const note = [
          `${match.path} is a binary file (${mimeType}, ${bytes.byteLength} bytes)${viewable ? "; the image follows" : ""}.`,
          `A client that reads MCP resources gets its bytes from ${skillFileUri(skill.name, match.path)}.`,
        ].join(" ")
        const binaryPayload: GetSkillPayload = {
          ...describeRemoteSkill(skill),
          content: note,
          file: { path: match.path, mimeType, binary: true },
        }
        return {
          content: [
            { type: "text", text: note },
            ...(viewable ? [{ type: "image" as const, data: Buffer.from(bytes).toString("base64"), mimeType }] : []),
          ],
          structuredContent: binaryPayload,
        }
      }
      const payload: GetSkillPayload = {
        ...describeRemoteSkill(skill),
        ...(source.provenance ? { provenance: source.provenance } : {}),
        content: standardSkillMarkdown(skill, source.content),
        // Many clients show the model structured content instead of the text,
        // so the note rides here too; content stays the exact SKILL.md.
        ...(files.length > 0 ? { files, filesNote: supportingFilesNote(skill, files) } : {}),
      }
      const text = payload.filesNote ? `${payload.content}\n\n---\n${payload.filesNote}` : payload.content
      return { content: [{ type: "text", text }], structuredContent: payload }
    },
  )
}
