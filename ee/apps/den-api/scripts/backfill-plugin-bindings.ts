import { and, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectTable,
  ConfigObjectVersionTable,
  PluginConfigObjectTable,
  PluginMcpServerInstanceTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../src/db.js"

type ConfigObjectId = typeof ConfigObjectTable.$inferSelect.id
type ExternalMcpConnectionId = typeof PluginMcpServerInstanceTable.$inferSelect.externalMcpConnectionId
type SkillId = typeof ConfigObjectTable.$inferSelect.denSkillId

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128)
}

function readSkillId(payload: Record<string, unknown> | null): SkillId {
  if (!payload || typeof payload.denSkillId !== "string") return null
  try {
    return normalizeDenTypeId("skill", payload.denSkillId)
  } catch {
    return null
  }
}

function readConnectionId(payload: Record<string, unknown>): ExternalMcpConnectionId | null {
  if (payload.openworkManaged !== "den_external_mcp" || typeof payload.externalMcpConnectionId !== "string") {
    return null
  }
  try {
    return normalizeDenTypeId("externalMcpConnection", payload.externalMcpConnectionId)
  } catch {
    return null
  }
}

function readMcpConnectionEntries(payload: Record<string, unknown> | null, fallbackName: string) {
  if (!payload) return []
  const direct = readConnectionId(payload)
  const entries: Array<{ connectionId: ExternalMcpConnectionId; serverKey: string }> = []
  for (const key of ["mcpServers", "mcp"]) {
    const container = payload[key]
    if (!isRecord(container)) continue
    for (const [name, value] of Object.entries(container)) {
      if (!isRecord(value)) continue
      const connectionId = readConnectionId(value)
      if (!connectionId) continue
      entries.push({ connectionId, serverKey: slugify(name) || slugify(fallbackName) })
    }
  }
  if (entries.length === 0 && direct) {
    entries.push({ connectionId: direct, serverKey: slugify(fallbackName) || "mcp" })
  }
  return entries
}

async function latestVersions(configObjectIds: ConfigObjectId[]) {
  if (configObjectIds.length === 0) return new Map<ConfigObjectId, typeof ConfigObjectVersionTable.$inferSelect>()
  const rows = await db
    .select()
    .from(ConfigObjectVersionTable)
    .where(inArray(ConfigObjectVersionTable.configObjectId, configObjectIds))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
  const latest = new Map<ConfigObjectId, typeof ConfigObjectVersionTable.$inferSelect>()
  for (const row of rows) {
    if (!latest.has(row.configObjectId)) latest.set(row.configObjectId, row)
  }
  return latest
}

async function main() {
  const rows = await db
    .select({
      configObjectId: PluginConfigObjectTable.configObjectId,
      createdByOrgMembershipId: PluginConfigObjectTable.createdByOrgMembershipId,
      denSkillId: ConfigObjectTable.denSkillId,
      objectType: ConfigObjectTable.objectType,
      organizationId: PluginConfigObjectTable.organizationId,
      pluginId: PluginConfigObjectTable.pluginId,
      title: ConfigObjectTable.title,
    })
    .from(PluginConfigObjectTable)
    .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, PluginConfigObjectTable.configObjectId))
    .where(and(
      isNull(PluginConfigObjectTable.removedAt),
      inArray(ConfigObjectTable.objectType, ["mcp", "skill"]),
    ))
  const versions = await latestVersions(rows.map((row) => row.configObjectId))
  let skillBackfillCount = 0
  let instanceBackfillCount = 0

  for (const row of rows) {
    const version = versions.get(row.configObjectId)
    const payload = version?.normalizedPayloadJson ?? null
    if (row.objectType === "skill" && !row.denSkillId) {
      const denSkillId = readSkillId(payload)
      if (denSkillId) {
        await db.update(ConfigObjectTable).set({ denSkillId }).where(eq(ConfigObjectTable.id, row.configObjectId))
        skillBackfillCount += 1
      }
      continue
    }
    if (row.objectType !== "mcp" || !row.createdByOrgMembershipId) continue
    for (const entry of readMcpConnectionEntries(payload, row.title)) {
      const existing = await db
        .select({ id: PluginMcpServerInstanceTable.id })
        .from(PluginMcpServerInstanceTable)
        .where(eq(PluginMcpServerInstanceTable.externalMcpConnectionId, entry.connectionId))
        .limit(1)
      if (existing[0]) continue
      await db.insert(PluginMcpServerInstanceTable).values({
        configObjectId: row.configObjectId,
        createdByOrgMembershipId: row.createdByOrgMembershipId,
        externalMcpConnectionId: entry.connectionId,
        id: createDenTypeId("pluginMcpServerInstance"),
        instanceLabel: row.title,
        organizationId: row.organizationId,
        pluginId: row.pluginId,
        serverKey: entry.serverKey,
      })
      instanceBackfillCount += 1
    }
  }

  console.log(JSON.stringify({ instanceBackfillCount, skillBackfillCount }))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
