import { and, count, eq, gte, inArray, isNotNull, isNull, max, min, sql } from "@openwork-ee/den-db/drizzle"
import {
  CapabilityUsageEventTable,
  ConfigObjectTable,
  ExternalMcpConnectionTable,
  PluginConfigObjectTable,
  PluginTable,
  WorkflowRunTable,
  type CapabilityUsageVia,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  buildLibraryUsageRows,
  countLabel,
  skillUseDedupeKey,
  type LibraryItem,
  type LibraryUsageKind,
  type LibraryUsageReport,
  type UsageFact,
} from "./capability-usage-rows.js"
import { db } from "./db.js"
import { organizationFeatureEnabled } from "./features.js"

export type { LibraryUsageKind, LibraryUsageReport, LibraryUsageRow } from "./capability-usage-rows.js"

function warn(stage: string, error: unknown) {
  console.warn("[library-usage]", { stage, message: error instanceof Error ? error.message : String(error) })
}

export type SkillUse = {
  organizationId: string
  orgMembershipId: DenTypeId<"member">
  pluginId: string
  configObjectId: string
  via: CapabilityUsageVia
  at?: Date
}

/**
 * Records one skill load for the organization's Library usage view. Never
 * throws and never delays the caller: usage is best effort, the skill is
 * served either way. Does nothing while `libraryUsage` is off.
 */
export function recordSkillUse(use: SkillUse): void {
  void writeSkillUse(use).catch((error: unknown) => warn("record-skill", error))
}

async function writeSkillUse(use: SkillUse): Promise<void> {
  if (!(await organizationFeatureEnabled(use.organizationId, "libraryUsage"))) return
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

export type ConnectorUse = {
  organizationId: string
  orgMembershipId: DenTypeId<"member">
  /** The external_mcp_connection id, or the provider key of a legacy Google Workspace / Microsoft 365 connection. */
  connectionId: string
  toolName: string
  ok: boolean
  via: CapabilityUsageVia
}

/** Records one connector tool call. Same guarantees as recordSkillUse; never stores arguments or results. */
export function recordConnectorUse(use: ConnectorUse): void {
  void writeConnectorUse(use).catch((error: unknown) => warn("record-connector", error))
}

/** An MCP CallToolResult that reports a tool-level error (`isError: true`). */
export function toolCallFailed(result: unknown): boolean {
  return typeof result === "object" && result !== null && "isError" in result && result.isError === true
}

/** Records when a tool call settles, without changing what the caller awaits or sees. */
export function recordConnectorCall<T>(call: Promise<T>, use: Omit<ConnectorUse, "ok">, failed: (result: T) => boolean): void {
  call.then(
    (result) => recordConnectorUse({ ...use, ok: !failed(result) }),
    () => recordConnectorUse({ ...use, ok: false }),
  )
}

async function writeConnectorUse(use: ConnectorUse): Promise<void> {
  if (!(await organizationFeatureEnabled(use.organizationId, "libraryUsage"))) return
  const id = createDenTypeId("capabilityUsageEvent")
  await db.insert(CapabilityUsageEventTable).values({
    id,
    organization_id: normalizeDenTypeId("organization", use.organizationId),
    org_membership_id: use.orgMembershipId,
    kind: "connector_tool",
    connection_id: use.connectionId.slice(0, 64),
    tool_name: use.toolName.slice(0, 255),
    via: use.via,
    dedupe_key: id,
    outcome: use.ok ? "ok" : "error",
  })
}

/** Legacy native connections have no row; their id is the provider key. */
const legacyNativeConnectionNames: Record<string, string> = {
  "google-workspace": "Google Workspace",
  "microsoft-365": "Microsoft 365",
}

type Window = { organizationId: DenTypeId<"organization">; since: Date }

async function skillItems(organizationId: DenTypeId<"organization">) {
  const rows = await db.select({
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
  return rows.sort((a, b) => a.pluginName.localeCompare(b.pluginName))
}

async function skillFacts({ organizationId, since }: Window, skillIds: string[]): Promise<UsageFact[]> {
  if (skillIds.length === 0) return []
  const rows = await db.select({
    itemId: CapabilityUsageEventTable.config_object_id,
    memberId: CapabilityUsageEventTable.org_membership_id,
    uses: count(),
    lastUsedAt: max(CapabilityUsageEventTable.created_at),
  })
    .from(CapabilityUsageEventTable)
    .where(and(
      eq(CapabilityUsageEventTable.organization_id, organizationId),
      eq(CapabilityUsageEventTable.kind, "skill"),
      inArray(CapabilityUsageEventTable.config_object_id, skillIds.map((id) => normalizeDenTypeId("configObject", id))),
      gte(CapabilityUsageEventTable.created_at, since),
    ))
    .groupBy(CapabilityUsageEventTable.config_object_id, CapabilityUsageEventTable.org_membership_id)
  return rows.flatMap((row) => row.itemId
    ? [{ itemId: row.itemId, memberId: row.memberId, uses: Number(row.uses), failures: 0, lastUsedAt: row.lastUsedAt ?? null }]
    : [])
}

async function readSkills(window: Window): Promise<{ items: LibraryItem[]; facts: UsageFact[] }> {
  const items = new Map<string, LibraryItem>()
  // A skill can sit in several plugins; list it once, under the first plugin by name.
  for (const row of await skillItems(window.organizationId)) {
    if (!items.has(row.skillId)) items.set(row.skillId, { id: row.skillId, name: row.skillName, detail: row.pluginName, pluginId: row.pluginId, tracksFailures: false })
  }
  return { items: [...items.values()], facts: await skillFacts(window, [...items.keys()]) }
}

/** A plugin is used when one of its skills is loaded or one of its Workflows runs. */
async function readPlugins(window: Window): Promise<{ items: LibraryItem[]; facts: UsageFact[] }> {
  const { organizationId, since } = window
  const [plugins, skills, skillUses, workflowRuns] = await Promise.all([
    db.select({ id: PluginTable.id, name: PluginTable.name }).from(PluginTable)
      .where(and(eq(PluginTable.organizationId, organizationId), eq(PluginTable.status, "active"), isNull(PluginTable.deletedAt))),
    skillItems(organizationId),
    db.select({
      itemId: CapabilityUsageEventTable.plugin_id,
      memberId: CapabilityUsageEventTable.org_membership_id,
      uses: count(),
      lastUsedAt: max(CapabilityUsageEventTable.created_at),
    }).from(CapabilityUsageEventTable)
      .where(and(
        eq(CapabilityUsageEventTable.organization_id, organizationId),
        eq(CapabilityUsageEventTable.kind, "skill"),
        isNotNull(CapabilityUsageEventTable.plugin_id),
        gte(CapabilityUsageEventTable.created_at, since),
      ))
      .groupBy(CapabilityUsageEventTable.plugin_id, CapabilityUsageEventTable.org_membership_id),
    db.select({
      itemId: WorkflowRunTable.plugin_id,
      memberId: WorkflowRunTable.org_membership_id,
      uses: count(),
      failures: sql<number>`sum(case when ${WorkflowRunTable.status} = 'failed' then 1 else 0 end)`,
      lastUsedAt: max(WorkflowRunTable.created_at),
    }).from(WorkflowRunTable)
      .where(and(
        eq(WorkflowRunTable.organization_id, organizationId),
        isNotNull(WorkflowRunTable.plugin_id),
        gte(WorkflowRunTable.created_at, since),
      ))
      .groupBy(WorkflowRunTable.plugin_id, WorkflowRunTable.org_membership_id),
  ])
  const skillCounts = new Map<string, number>()
  for (const skill of skills) skillCounts.set(skill.pluginId, (skillCounts.get(skill.pluginId) ?? 0) + 1)
  const items = plugins.map((plugin) => {
    const skillCount = skillCounts.get(plugin.id) ?? 0
    return { id: plugin.id, name: plugin.name, detail: skillCount > 0 ? countLabel(skillCount, "skill") : null, pluginId: null, tracksFailures: true }
  })
  const facts: UsageFact[] = [
    ...skillUses.flatMap((row) => row.itemId ? [{ itemId: row.itemId, memberId: row.memberId, uses: Number(row.uses), failures: 0, lastUsedAt: row.lastUsedAt ?? null }] : []),
    ...workflowRuns.flatMap((row) => row.itemId ? [{ itemId: row.itemId, memberId: row.memberId ?? null, uses: Number(row.uses), failures: Number(row.failures ?? 0), lastUsedAt: row.lastUsedAt ?? null }] : []),
  ]
  return { items, facts }
}

async function readConnectors({ organizationId, since }: Window): Promise<{ items: LibraryItem[]; facts: UsageFact[] }> {
  const [connections, calls] = await Promise.all([
    db.select({ id: ExternalMcpConnectionTable.id, name: ExternalMcpConnectionTable.name, kind: ExternalMcpConnectionTable.kind })
      .from(ExternalMcpConnectionTable)
      .where(eq(ExternalMcpConnectionTable.organizationId, organizationId)),
    db.select({
      itemId: CapabilityUsageEventTable.connection_id,
      memberId: CapabilityUsageEventTable.org_membership_id,
      uses: count(),
      failures: sql<number>`sum(case when ${CapabilityUsageEventTable.outcome} = 'error' then 1 else 0 end)`,
      lastUsedAt: max(CapabilityUsageEventTable.created_at),
    }).from(CapabilityUsageEventTable)
      .where(and(
        eq(CapabilityUsageEventTable.organization_id, organizationId),
        eq(CapabilityUsageEventTable.kind, "connector_tool"),
        gte(CapabilityUsageEventTable.created_at, since),
      ))
      .groupBy(CapabilityUsageEventTable.connection_id, CapabilityUsageEventTable.org_membership_id),
  ])
  const items: LibraryItem[] = connections.map((connection) => ({
    id: connection.id, name: connection.name, detail: null, pluginId: null, tracksFailures: true,
  }))
  const known = new Set(items.map((item) => item.id))
  for (const [key, name] of Object.entries(legacyNativeConnectionNames)) {
    if (!known.has(key) && calls.some((call) => call.itemId === key)) items.push({ id: key, name, detail: null, pluginId: null, tracksFailures: true })
  }
  const facts = calls.flatMap((row) => row.itemId
    ? [{ itemId: row.itemId, memberId: row.memberId, uses: Number(row.uses), failures: Number(row.failures ?? 0), lastUsedAt: row.lastUsedAt ?? null }]
    : [])
  return { items, facts }
}

export async function readLibraryUsage(organizationId: DenTypeId<"organization">, kind: LibraryUsageKind, days: number): Promise<LibraryUsageReport> {
  const window = { organizationId, since: new Date(Date.now() - days * 86_400_000) }
  const [{ items, facts }, first] = await Promise.all([
    kind === "skills" ? readSkills(window) : kind === "plugins" ? readPlugins(window) : readConnectors(window),
    db.select({ at: min(CapabilityUsageEventTable.created_at) })
      .from(CapabilityUsageEventTable)
      .where(eq(CapabilityUsageEventTable.organization_id, organizationId)),
  ])
  return {
    kind,
    days,
    trackingSince: first[0]?.at ? first[0].at.toISOString() : null,
    items: buildLibraryUsageRows(items, facts),
  }
}
