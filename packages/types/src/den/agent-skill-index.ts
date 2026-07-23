import { z } from "zod"

/**
 * OpenWork's authenticated MCP resource for remote Agent Skill discovery.
 *
 * This wire profile reuses the Agent Skills discovery 0.2 name, description,
 * type, and URL fields, then adds an OpenWork capability pointer and uses
 * authenticated `skill://` resources. It is not the public well-known
 * distribution profile and does not claim artifact-digest compatibility.
 */
export const OPENWORK_AGENT_SKILL_INDEX_URI = "skill://index.json" as const
export const OPENWORK_AGENT_SKILL_DISCOVERY_SCHEMA_URI =
  "https://schemas.agentskills.io/discovery/0.2.0/schema.json" as const
export const OPENWORK_AGENT_SKILL_INDEX_MAX_ENTRIES = 100
export const OPENWORK_AGENT_SKILL_INDEX_MAX_SERIALIZED_BYTES = 240 * 1_024

export const openworkAgentSkillCapabilitySchema = z.string()
  .regex(/^(?:skill:[^:\s]+|plugin:[^:\s]+:[^:\s]+)$/)
  .max(256)

export const openworkAgentSkillIndexEntrySchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  title: z.string().max(255).optional(),
  type: z.literal("skill-md"),
  description: z.string().max(1_024),
  url: z.string().startsWith("skill://").max(2_048),
  capability: openworkAgentSkillCapabilitySchema,
  marketplaceName: z.string().max(255).optional(),
  pluginName: z.string().max(255).optional(),
}).passthrough()

export const openworkAgentSkillIndexMetadataSchema = z.object({
  totalSkills: z.number().int().nonnegative().max(1_000_000),
  truncated: z.boolean(),
  truncationReason: z.enum(["entry-count", "serialized-bytes"]).optional(),
}).passthrough()

export const openworkAgentSkillIndexSchema = z.object({
  $schema: z.literal(OPENWORK_AGENT_SKILL_DISCOVERY_SCHEMA_URI),
  skills: z.array(openworkAgentSkillIndexEntrySchema),
  openwork: openworkAgentSkillIndexMetadataSchema.optional(),
}).passthrough()

export type OpenWorkAgentSkillIndexUri = typeof OPENWORK_AGENT_SKILL_INDEX_URI
export type OpenWorkAgentSkillDiscoverySchemaUri =
  typeof OPENWORK_AGENT_SKILL_DISCOVERY_SCHEMA_URI
export type OpenWorkAgentSkillCapability =
  z.infer<typeof openworkAgentSkillCapabilitySchema>
export type OpenWorkAgentSkillIndexEntry =
  z.infer<typeof openworkAgentSkillIndexEntrySchema>
export type OpenWorkAgentSkillIndex =
  z.infer<typeof openworkAgentSkillIndexSchema>

export function buildOpenWorkMarketplaceSkillCapabilityName(
  pluginId: string,
  configObjectId: string,
): `plugin:${string}:${string}` {
  return `plugin:${pluginId}:${configObjectId}`
}
