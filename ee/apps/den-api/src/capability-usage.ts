import { and, count, countDistinct, eq, gte, inArray, isNull, max, min, sql } from "@openwork-ee/den-db/drizzle"
import {
  CapabilityUsageEventTable,
  ConfigObjectTable,
  PluginConfigObjectTable,
  PluginTable,
  type CapabilityUsageVia,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { buildSkillUsageRows, skillUseDedupeKey, type SkillRef, type SkillUsageReport, type UsageAggregate } from "./capability-usage-rows.js"
import { db } from "./db.js"
import { organizationFeatureEnabled } from "./features.js"

export type { SkillUsageReport, SkillUsageRow } from "./capability-usage-rows.js"

export type SkillUse = {
  organizationId: string
  orgMembershipId: DenTypeId<"member">
  pluginId: string
  configObjectId: string
  via: CapabilityUsageVia
  at?: Date
}

/**
 * Records one skill load for the organization's Skill usage view. Never
 * throws and never delays the caller: usage is best effort, the skill is
 * served either way. Does nothing while `skillUsage` is off.
 */
export function recordSkillUse(use: SkillUse): void {
  void writeSkillUse(use).catch((error: unknown) => {
    console.warn("[skill-usage]", { stage: "record", message: error instanceof Error ? error.message : String(error) })
  })
}

async function writeSkillUse(use: SkillUse): Promise<void> {
  if (!(await organizationFeatureEnabled(use.organizationId, "skillUsage"))) return
  const at = use.at ?? new Date()
  await db.insert(CapabilityUsageEventTable).values({
    id: createDenTypeId("capabilityUsageEvent"),
    organization_id: normalizeDenTypeId("organization", use.organizationId),
    org_membership_id: use.orgMembershipId,
    kind: "skill",
    plugin_id: normalizeDenTypeId("plugin", use.pluginId),
    config_object_id: normalizeDenTypeId("configObject", use.configObjectId),
    via: use.via,
    dedupe_key: skillUseDedupeKey({ ...use, at }),
    created_at: at,
  }).onDuplicateKeyUpdate({ set: { dedupe_key: sql`dedupe_key` } })
}

export async function readSkillUsage(organizationId: DenTypeId<"organization">, days: number): Promise<SkillUsageReport> {
  const since = new Date(Date.now() - days * 86_400_000)
  const skills = await db.select({
    skillId: ConfigObjectTable.id,
    skillName: ConfigObjectTable.title,
    pluginId: PluginTable.id,
    pluginName: PluginTable.name,
  })
    .from(PluginConfigObjectTable)
    .innerJoin(PluginTable, eq(PluginTable.id, PluginConfigObjectTable.pluginId))
    .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, PluginConfigObjectTable.configObjectId))
    .where(and(
      eq(PluginConfigObjectTable.organizationId, organizationId),
      isNull(PluginConfigObjectTable.removedAt),
      eq(PluginTable.status, "active"),
      isNull(PluginTable.deletedAt),
      eq(ConfigObjectTable.objectType, "skill"),
      eq(ConfigObjectTable.status, "active"),
      isNull(ConfigObjectTable.deletedAt),
    ))
  // A skill can sit in several plugins; list it once, under the first plugin by name.
  const unique = new Map<string, SkillRef>()
  for (const skill of [...skills].sort((a, b) => a.pluginName.localeCompare(b.pluginName))) {
    if (!unique.has(skill.skillId)) unique.set(skill.skillId, skill)
  }
  const skillIds = [...unique.keys()].map((id) => normalizeDenTypeId("configObject", id))
  const [usage, first] = await Promise.all([
    skillIds.length === 0 ? Promise.resolve([]) : db.select({
      skillId: CapabilityUsageEventTable.config_object_id,
      uses: count(),
      people: countDistinct(CapabilityUsageEventTable.org_membership_id),
      lastUsedAt: max(CapabilityUsageEventTable.created_at),
    })
      .from(CapabilityUsageEventTable)
      .where(and(
        eq(CapabilityUsageEventTable.organization_id, organizationId),
        eq(CapabilityUsageEventTable.kind, "skill"),
        inArray(CapabilityUsageEventTable.config_object_id, skillIds),
        gte(CapabilityUsageEventTable.created_at, since),
      ))
      .groupBy(CapabilityUsageEventTable.config_object_id),
    db.select({ at: min(CapabilityUsageEventTable.created_at) })
      .from(CapabilityUsageEventTable)
      .where(and(eq(CapabilityUsageEventTable.organization_id, organizationId), eq(CapabilityUsageEventTable.kind, "skill"))),
  ])
  const aggregates: UsageAggregate[] = usage.flatMap((row) => row.skillId
    ? [{ skillId: row.skillId, uses: Number(row.uses), people: Number(row.people), lastUsedAt: row.lastUsedAt ?? null }]
    : [])
  return {
    days,
    trackingSince: first[0]?.at ? first[0].at.toISOString() : null,
    skills: buildSkillUsageRows([...unique.values()], aggregates),
  }
}
