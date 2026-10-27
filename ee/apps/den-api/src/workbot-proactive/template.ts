import { and, count, desc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { ConfigObjectTable, ConfigObjectVersionTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { AGENT_INSTRUCTIONS, AGENT_TIMING } from "@openwork/automations/proactive"
import {
  agentTemplateContentSchema,
  DEFAULT_AGENT_TEMPLATE,
  enabledResponsibilities,
  type AgentTemplateContent,
} from "@openwork/types/den/workbot-proactive"
import { db } from "../db.js"

/**
 * The "Your agent" template: a versioned config object of type `agent`, in the same markdown agent-definition format
 * Library imports (`AGENT.md`: frontmatter, then the agent's instructions). OpenWork extends the frontmatter with
 * `sources`, `responsibilities` and `schedule`. The built-in default is version 1 and lives here, in code; each admin
 * save adds a `config_object_version` to the organization's one "Your agent" object. Each member's agent row points
 * at the version it last ran.
 */

export const AGENT_TEMPLATE_PATH = "openwork/agents/your-agent.md"
export const AGENT_TEMPLATE_SCHEMA_VERSION = "openwork-agent/1"
const TEMPLATE_TITLE = "Your agent"
const TEMPLATE_DESCRIPTION = "Reads each member's Gmail and Google Calendar on a schedule and tells them only what needs them."

export type AgentTemplateVersion = AgentTemplateContent & {
  /** The saved version, or null for the built-in default. */
  versionId: DenTypeId<"configObjectVersion"> | null
  version: number
}

export const BUILTIN_AGENT_TEMPLATE: AgentTemplateVersion = { ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 }

/** The template as an agent definition file. */
export function renderAgentTemplate(content: AgentTemplateContent): string {
  const hours = AGENT_TIMING.checkEveryMs / 3_600_000
  const lines = [
    "---",
    "name: your-agent",
    `description: ${TEMPLATE_DESCRIPTION}`,
    "mode: primary",
    "sources: gmail, google_calendar",
    `responsibilities: ${enabledResponsibilities(content).join(", ") || "none"}`,
    `schedule: morning pass, then every ${hours} hours in working hours`,
    "---",
    AGENT_INSTRUCTIONS,
  ]
  if (content.instructions.trim()) lines.push("", "## Organization instructions", content.instructions.trim())
  return `${lines.join("\n")}\n`
}

async function findTemplateObject(organizationId: DenTypeId<"organization">) {
  const [row] = await db
    .select({ id: ConfigObjectTable.id })
    .from(ConfigObjectTable)
    .where(and(
      eq(ConfigObjectTable.organizationId, organizationId),
      eq(ConfigObjectTable.objectType, "agent"),
      eq(ConfigObjectTable.currentRelativePath, AGENT_TEMPLATE_PATH),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))
    .orderBy(desc(ConfigObjectTable.createdAt))
    .limit(1)
  return row ?? null
}

/** The organization's current template: its newest saved version, or the built-in default. */
export async function readAgentTemplate(organizationId: DenTypeId<"organization">): Promise<AgentTemplateVersion> {
  const object = await findTemplateObject(organizationId)
  if (!object) return BUILTIN_AGENT_TEMPLATE
  const [latest] = await db
    .select({ id: ConfigObjectVersionTable.id, payload: ConfigObjectVersionTable.normalizedPayloadJson })
    .from(ConfigObjectVersionTable)
    .where(and(eq(ConfigObjectVersionTable.configObjectId, object.id), eq(ConfigObjectVersionTable.isDeletedVersion, false)))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
    .limit(1)
  const parsed = agentTemplateContentSchema.safeParse(latest?.payload)
  if (!latest || !parsed.success) return BUILTIN_AGENT_TEMPLATE
  const [saved] = await db.select({ versions: count() }).from(ConfigObjectVersionTable).where(eq(ConfigObjectVersionTable.configObjectId, object.id))
  return { ...parsed.data, versionId: latest.id, version: (saved?.versions ?? 0) + 1 }
}

/** Saves an admin's edit as a new version (creating the organization's "Your agent" object on the first save). */
export async function saveAgentTemplate(input: {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
  content: AgentTemplateContent
  now?: Date
}): Promise<AgentTemplateVersion> {
  const now = input.now ?? new Date()
  const rawSourceText = renderAgentTemplate(input.content)
  const versionId = createDenTypeId("configObjectVersion")
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: ConfigObjectTable.id })
      .from(ConfigObjectTable)
      .where(and(
        eq(ConfigObjectTable.organizationId, input.organizationId),
        eq(ConfigObjectTable.objectType, "agent"),
        eq(ConfigObjectTable.currentRelativePath, AGENT_TEMPLATE_PATH),
        eq(ConfigObjectTable.status, "active"),
        isNull(ConfigObjectTable.deletedAt),
      ))
      .orderBy(desc(ConfigObjectTable.createdAt))
      .limit(1)
      .for("update")
    const configObjectId = existing?.id ?? createDenTypeId("configObject")
    if (!existing) {
      await tx.insert(ConfigObjectTable).values({
        id: configObjectId,
        organizationId: input.organizationId,
        objectType: "agent",
        sourceMode: "cloud",
        title: TEMPLATE_TITLE,
        description: TEMPLATE_DESCRIPTION,
        searchText: `${TEMPLATE_TITLE}\n${TEMPLATE_DESCRIPTION}`,
        currentFileName: "your-agent.md",
        currentFileExtension: "md",
        currentRelativePath: AGENT_TEMPLATE_PATH,
        status: "active",
        createdByOrgMembershipId: input.memberId,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      await tx.update(ConfigObjectTable).set({ updatedAt: now }).where(eq(ConfigObjectTable.id, configObjectId))
    }
    await tx.insert(ConfigObjectVersionTable).values({
      id: versionId,
      organizationId: input.organizationId,
      configObjectId,
      normalizedPayloadJson: { ...input.content },
      rawSourceText,
      schemaVersion: AGENT_TEMPLATE_SCHEMA_VERSION,
      createdVia: "cloud",
      createdByOrgMembershipId: input.memberId,
      isDeletedVersion: false,
      createdAt: now,
    })
  })
  return readAgentTemplate(input.organizationId)
}
