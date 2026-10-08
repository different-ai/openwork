import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import {
  skillCreatedPayloadSchema,
  type SkillCreatedPayload,
} from "@openwork/types/skill-created-app"
import { z } from "zod"

export { skillCreatedPayloadSchema } from "@openwork/types/skill-created-app"

export const CREATE_SKILL_TOOL_NAME = "create_skill"
export const UPDATE_SKILL_TOOL_NAME = "update_skill"

export type CreateSkillResult =
  | { ok: true; payload: SkillCreatedPayload }
  | { ok: false; error: string; message: string }

export function skillCreatedTextFallback(payload: SkillCreatedPayload): string {
  return [
    `# Skill ${payload.mode === "updated" ? "updated" : "created"}: ${payload.name}`,
    payload.description,
    `Plugin ID: ${payload.pluginId}`,
    `Skill ID: ${payload.skillId}`,
    payload.libraryUrl ? `Library: ${payload.libraryUrl}` : null,
  ].filter((line): line is string => line !== null).join("\n")
}

function skillSavedToolResult(result: CreateSkillResult): CallToolResult {
  if (!result.ok) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({ error: result.error, message: result.message }),
      }],
    }
  }
  const payload = skillCreatedPayloadSchema.parse(result.payload)
  return {
    content: [{ type: "text", text: skillCreatedTextFallback(payload) }],
    structuredContent: payload,
    _meta: { schemaVersion: payload.schemaVersion, pluginId: payload.pluginId, skillId: payload.skillId },
  }
}

export function registerAgentSkillTools(input: {
  server: McpServer
  create: (request: { pluginName: string; skillMarkdown: string }) => Promise<CreateSkillResult>
  update?: (request: { skillId: string; skillMarkdown: string; reason?: string }) => Promise<CreateSkillResult>
}) {
  input.server.registerTool(
    CREATE_SKILL_TOOL_NAME,
    {
      title: "Create skill",
      description: [
        "Create one private OpenWork Cloud skill in a new Plugin.",
        "Pass a complete SKILL.md with valid frontmatter and instructions.",
        "The skill is immediately available to its creator; this does not publish it to a Marketplace or share it.",
        "Returns the saved skill details and a text confirmation.",
      ].join(" "),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({
        pluginName: z.string().trim().min(1).max(255).describe("Display name for the new Plugin."),
        skillMarkdown: z.string().trim().min(1).max(1_048_576).describe("Complete SKILL.md source, including frontmatter and instructions."),
      }),
      outputSchema: skillCreatedPayloadSchema,
    },
    async ({ pluginName, skillMarkdown }) => skillSavedToolResult(await input.create({ pluginName, skillMarkdown })),
  )
  if (!input.update) return
  const update = input.update
  input.server.registerTool(
    UPDATE_SKILL_TOOL_NAME,
    {
      title: "Update skill",
      description: [
        "Update one existing OpenWork Cloud skill by creating a new immutable version, without creating a duplicate Plugin.",
        "Pass the skill's config object id and the complete replacement SKILL.md.",
        "Returns the saved skill details and a text confirmation.",
      ].join(" "),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({
        skillId: z.string().trim().min(1).max(160).describe("The existing skill's config object id (cob_…)."),
        skillMarkdown: z.string().trim().min(1).max(1_048_576).describe("Complete replacement SKILL.md source, including frontmatter and instructions."),
        reason: z.string().trim().min(1).max(255).optional().describe("Optional short reason recorded on the new version."),
      }),
      outputSchema: skillCreatedPayloadSchema,
    },
    async ({ skillId, skillMarkdown, reason }) => skillSavedToolResult(await update({ skillId, skillMarkdown, reason })),
  )
}
