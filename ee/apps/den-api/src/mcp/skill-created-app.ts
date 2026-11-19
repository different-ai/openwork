import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import {
  skillCreatedPayloadSchema,
  type SkillCreatedPayload,
} from "@openwork/types/skill-created-app"
import { z } from "zod"

export { skillCreatedPayloadSchema } from "@openwork/types/skill-created-app"

export const CREATE_SKILL_TOOL_NAME = "create_skill"
export const UPDATE_SKILL_TOOL_NAME = "update_skill"

const skillSavedOutputSchema = skillCreatedPayloadSchema.extend({
  schemaVersion: skillCreatedPayloadSchema.shape.schemaVersion.describe("Version of the saved-skill response format."),
  mode: skillCreatedPayloadSchema.shape.mode.describe("Whether the skill was created or updated; omitted means created."),
  name: skillCreatedPayloadSchema.shape.name.describe("Saved skill title derived from its SKILL.md."),
  pluginId: skillCreatedPayloadSchema.shape.pluginId.describe("Identifier of the new Plugin on create, or a visible associated Plugin on update."),
  skillId: skillCreatedPayloadSchema.shape.skillId.describe("Skill config object identifier; use this for subsequent update_skill calls."),
  description: skillCreatedPayloadSchema.shape.description.describe("Saved skill summary derived from its SKILL.md."),
  libraryUrl: skillCreatedPayloadSchema.shape.libraryUrl.describe("Link to the Plugin in the OpenWork library, or null when unavailable."),
})

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
        "Requires an active OpenWork Cloud membership, mcp:write scope, and permission to create Plugins and config objects. Pass a complete SKILL.md with valid name and description frontmatter and instructions.",
        "Creates persistent Plugin and skill records, not a draft; the skill is immediately available to its creator. This does not publish it to a Marketplace or share it.",
        "Returns structured saved-skill details: schemaVersion, optional mode (omitted means created), name, description, pluginId, skillId, and libraryUrl (or null), plus a text confirmation. Failures return an error code and message with isError.",
      ].join(" "),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({
        pluginName: z.string().trim().min(1).max(255).describe("Display name for the new Plugin."),
        skillMarkdown: z.string().trim().min(1).max(1_048_576).describe("The skill document to save: YAML frontmatter with name and description, followed by Markdown instructions telling an agent how and when to perform the task."),
      }),
      outputSchema: skillSavedOutputSchema,
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
        "Publish a new immutable version of an existing OpenWork Cloud skill, without creating a duplicate Plugin or changing its sharing grants.",
        "Requires an active OpenWork Cloud membership, mcp:write scope, and editor access to the skill. Pass its config object id and the complete replacement SKILL.md, not a patch.",
        "Immediately replaces the latest instructions for users with access and may remove stale required-connection bindings. Earlier immutable versions remain in history; this tool cannot overwrite or erase a published version. To undo the content change, publish another version with the previous content. Repeated calls create additional versions.",
        "Returns structured saved-skill details: schemaVersion, mode (updated), name, description, pluginId (a visible associated Plugin), skillId, and libraryUrl (or null), plus a text confirmation. Failures return an error code and message with isError; a failure resolving saved details can occur after the version was written.",
      ].join(" "),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({
        skillId: z.string().trim().min(1).max(160).describe("The existing skill's config object id (cob_…)."),
        skillMarkdown: z.string().trim().min(1).max(1_048_576).describe("Complete replacement SKILL.md source, including frontmatter and instructions."),
        reason: z.string().trim().min(1).max(255).optional().describe("Why the skill is being changed; recorded as the new version's source revision reference for traceability."),
      }),
      outputSchema: skillSavedOutputSchema,
    },
    async ({ skillId, skillMarkdown, reason }) => skillSavedToolResult(await update({ skillId, skillMarkdown, reason })),
  )
}
