import { and, desc, eq, gte, inArray, isNotNull, isNull, min, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import {
  CapabilityUsageEventTable,
  CapabilityUsageRollupTable,
  ConfigObjectTable,
  ExternalMcpConnectionTable,
  MemberTable,
  PluginConfigObjectTable,
  PluginTable,
  TeamMemberTable,
  TeamTable,
  WorkflowRunTable,
  capabilityUsageSourceValues,
  type CapabilityUsageKind,
  type CapabilityUsageSource,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  buildLibraryUsageRows,
  countLabel,
  libraryUsageWindow,
  type LibraryItem,
  type LibraryUsageDimension,
  type LibraryUsageKind,
  type LibraryUsageReport,
  type LibraryUsageSourceCounts,
  type ItemUsageTotals,
} from "./capability-usage-rows.js"
import { db } from "./db.js"

export type { LibraryUsageKind, LibraryUsageReport, LibraryUsageRow } from "./capability-usage-rows.js"

function warn(stage: string, error: unknown) {
  console.warn("[library-usage]", { stage, message: error instanceof Error ? error.message : String(error) })
}

export type SkillUse = {
  organizationId: string
  orgMembershipId: DenTypeId<"member">
  pluginId: string
  configObjectId: string
  source: CapabilityUsageSource
}

/**
 * Records one skill load for the organization's Library usage view. Every load
 * is one row. Never throws and never delays the caller: usage is best effort,
 * the skill is served either way.
 */
export function recordSkillUse(use: SkillUse): void {
  void writeSkillUse(use).catch((error: unknown) => warn("record-skill", error))
}

async function writeSkillUse(use: SkillUse): Promise<void> {
  await db.insert(CapabilityUsageEventTable).values({
    id: createDenTypeId("capabilityUsageEvent"),
    organization_id: normalizeDenTypeId("organization", use.organizationId),
    org_membership_id: use.orgMembershipId,
    kind: "skill",
    plugin_id: normalizeDenTypeId("plugin", use.pluginId),
    config_object_id: normalizeDenTypeId("configObject", use.configObjectId),
    source: use.source,
  })
}

export type ConnectorUse = {
  organizationId: string
  orgMembershipId: DenTypeId<"member">
  /** The external_mcp_connection id, or the provider key of a legacy Google Workspace / Microsoft 365 connection. */
  connectionId: string
  ok: boolean
  source: CapabilityUsageSource
}

/** Records one connector tool call. Same guarantees as recordSkillUse; stores ids only, never the tool name, arguments or results. */
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
  await db.insert(CapabilityUsageEventTable).values({
    id: createDenTypeId("capabilityUsageEvent"),
    organization_id: normalizeDenTypeId("organization", use.organizationId),
    org_membership_id: use.orgMembershipId,
    kind: "connector_tool",
    connection_id: use.connectionId.slice(0, 64),
    source: use.source,
    outcome: use.ok ? "ok" : "error",
  })
}

// ---------------------------------------------------------------------------
// Reads. Recent uses are raw capability_usage_event rows; uses older than about
// two days were folded into daily capability_usage_rollups by the gateway's
// rollup job, which deletes the raw rows in the same transaction. Every read
// unions both stores in one statement, so a use is counted exactly once.
// ---------------------------------------------------------------------------

const raw = CapabilityUsageEventTable
const rollup = CapabilityUsageRollupTable
const workflowRun = WorkflowRunTable

/** Most rows one breakdown returns; a larger result asks the caller to narrow it. */
export const LIBRARY_USAGE_MAX_ROWS = 10_000

export class LibraryUsageTooManyRowsError extends Error {
  constructor() {
    super("library_usage_too_many_rows")
  }
}

export type LibraryUsageQuery = {
  organizationId: DenTypeId<"organization">
  kind: LibraryUsageKind
  days: number
  groupBy: readonly LibraryUsageDimension[]
  /** Only these members' uses; an empty list matches nobody. */
  memberIds?: readonly string[]
  itemId?: string
  now?: Date
  /** Most rows to return before failing with LibraryUsageTooManyRowsError; null for none (one row per live item). */
  maxRows?: number | null
}

export type LibraryUsageBreakdownRow = {
  itemId: string | null
  memberId: string | null
  date: string | null
  uses: number
  failures: number
  people: number
  lastUsedAt: Date | null
  sources: LibraryUsageSourceCounts
}

const usageKinds: Record<LibraryUsageKind, CapabilityUsageKind> = { skills: "skill", plugins: "skill", connectors: "connector_tool" }

// Epoch arithmetic gives UTC calendar dates even if a DB session is not UTC.
function utcDate(timestamp: SQL) {
  return sql<string>`date_format(timestampadd(day, floor(unix_timestamp(${timestamp}) / 86400), '1970-01-01'), '%Y-%m-%d')`
}

function sourceAlias(source: CapabilityUsageSource) {
  return `source_${source}`
}

function sourceColumns(count: (source: CapabilityUsageSource) => SQL) {
  return Object.fromEntries(capabilityUsageSourceValues.map((source) => [sourceAlias(source), sql<string>`${count(source)}`.as(sourceAlias(source))]))
}

function sourceCounts(row: Record<string, unknown>): LibraryUsageSourceCounts {
  const counts: LibraryUsageSourceCounts = {}
  for (const source of capabilityUsageSourceValues) {
    const value = Number(row[sourceAlias(source)] ?? 0)
    if (value > 0) counts[source] = value
  }
  return counts
}

/** Uses grouped by the requested dimensions, from raw rows, daily rollups and, for plugins, Workflow runs. */
export async function readLibraryUsageBreakdown(query: LibraryUsageQuery): Promise<LibraryUsageBreakdownRow[]> {
  if (query.memberIds && query.memberIds.length === 0) return []
  const { from } = libraryUsageWindow(query.days, query.now)
  const kind = usageKinds[query.kind]
  const memberIds = query.memberIds?.map((id) => normalizeDenTypeId("member", id))
  const item = (table: typeof raw | typeof rollup) => query.kind === "skills" ? table.config_object_id : query.kind === "plugins" ? table.plugin_id : table.connection_id

  const rawItem = item(raw)
  const rawQuery = db.select({
    itemId: sql<string>`${rawItem}`.as("item_id"),
    memberId: sql<string | null>`${raw.org_membership_id}`.as("member_id"),
    usageDate: utcDate(sql`${raw.created_at}`).as("usage_date"),
    uses: sql<string>`count(*)`.as("uses"),
    failures: sql<string>`sum(case when ${raw.outcome} = 'error' then 1 else 0 end)`.as("failures"),
    lastUsedAt: sql<string>`max(${raw.created_at})`.as("last_used_at"),
    ...sourceColumns((source) => sql`sum(case when ${raw.source} = ${source} then 1 else 0 end)`),
  }).from(raw).where(and(
    eq(raw.organization_id, query.organizationId),
    eq(raw.kind, kind),
    isNotNull(rawItem),
    gte(raw.created_at, from),
    memberIds ? inArray(raw.org_membership_id, memberIds) : undefined,
    query.itemId ? sql`${rawItem} = ${query.itemId}` : undefined,
  )).groupBy(sql`item_id`, sql`member_id`, sql`usage_date`)

  const rollupItem = item(rollup)
  const rollupQuery = db.select({
    itemId: sql<string>`${rollupItem}`.as("item_id"),
    memberId: sql<string | null>`${rollup.org_membership_id}`.as("member_id"),
    usageDate: utcDate(sql`${rollup.bucket_start}`).as("usage_date"),
    uses: sql<string>`sum(${rollup.use_count})`.as("uses"),
    failures: sql<string>`sum(${rollup.error_count})`.as("failures"),
    lastUsedAt: sql<string>`max(${rollup.last_used_at})`.as("last_used_at"),
    ...sourceColumns((source) => sql`sum(coalesce(cast(json_extract(${rollup.source_counts}, ${`$.${source}`}) as unsigned), 0))`),
  }).from(rollup).where(and(
    eq(rollup.organization_id, query.organizationId),
    eq(rollup.kind, kind),
    isNotNull(rollupItem),
    gte(rollup.bucket_start, from),
    memberIds ? inArray(rollup.org_membership_id, memberIds) : undefined,
    query.itemId ? sql`${rollupItem} = ${query.itemId}` : undefined,
  )).groupBy(sql`item_id`, sql`member_id`, sql`usage_date`)

  // A plugin is also used when one of its Workflows runs; Automation runs count as automation.
  const workflowQuery = db.select({
    itemId: sql<string>`${workflowRun.plugin_id}`.as("item_id"),
    memberId: sql<string | null>`${workflowRun.org_membership_id}`.as("member_id"),
    usageDate: utcDate(sql`${workflowRun.created_at}`).as("usage_date"),
    uses: sql<string>`count(*)`.as("uses"),
    failures: sql<string>`sum(case when ${workflowRun.status} = 'failed' then 1 else 0 end)`.as("failures"),
    lastUsedAt: sql<string>`max(${workflowRun.created_at})`.as("last_used_at"),
    ...sourceColumns((source) => source === "automation"
      ? sql`sum(case when ${workflowRun.automation_run_id} is not null then 1 else 0 end)`
      : source === "workflow" ? sql`sum(case when ${workflowRun.automation_run_id} is null then 1 else 0 end)` : sql`0`),
  }).from(workflowRun).where(and(
    eq(workflowRun.organization_id, query.organizationId),
    isNotNull(workflowRun.plugin_id),
    gte(workflowRun.created_at, from),
    memberIds ? inArray(workflowRun.org_membership_id, memberIds) : undefined,
    query.itemId ? sql`${workflowRun.plugin_id} = ${query.itemId}` : undefined,
  )).groupBy(sql`item_id`, sql`member_id`, sql`usage_date`)

  // A CTE, not a derived table: its UNION prevents merging, so MySQL reads each store once.
  const sources = db.$with("library_usage_sources").as(query.kind === "plugins"
    ? rawQuery.unionAll(rollupQuery).unionAll(workflowQuery)
    : rawQuery.unionAll(rollupQuery))

  const byItem = query.groupBy.includes("item")
  const byMember = query.groupBy.includes("member")
  const byDay = query.groupBy.includes("day")
  const groups = [byItem ? sources.itemId : null, byMember ? sources.memberId : null, byDay ? sources.usageDate : null].filter((column) => column !== null)
  const grouped = db.with(sources).select({
    itemId: byItem ? sql<string | null>`${sources.itemId}` : sql<string | null>`null`,
    memberId: byMember ? sql<string | null>`${sources.memberId}` : sql<string | null>`null`,
    usageDate: byDay ? sql<string | null>`${sources.usageDate}` : sql<string | null>`null`,
    uses: sql<string>`cast(sum(${sources.uses}) as char)`,
    failures: sql<string>`cast(coalesce(sum(${sources.failures}), 0) as char)`,
    people: sql<string>`cast(count(distinct ${sources.memberId}) as char)`,
    lastUsedAt: sql<string | null>`max(${sources.lastUsedAt})`,
    ...Object.fromEntries(capabilityUsageSourceValues.map((source) => [sourceAlias(source), sql<string>`cast(sum(${sql.identifier(sourceAlias(source))}) as char)`])),
  }).from(sources)
    .groupBy(...groups)
    .orderBy(...(byDay ? [sources.usageDate] : []), desc(sql`sum(${sources.uses})`))
    .$dynamic()
  const maxRows = query.maxRows === undefined ? LIBRARY_USAGE_MAX_ROWS : query.maxRows
  const rows = await (maxRows === null ? grouped : grouped.limit(maxRows + 1))
  if (maxRows !== null && rows.length > maxRows) throw new LibraryUsageTooManyRowsError()
  return rows.map((row) => ({
    itemId: row.itemId,
    memberId: row.memberId,
    date: row.usageDate,
    uses: Number(row.uses),
    failures: Number(row.failures),
    people: Number(row.people),
    lastUsedAt: parseDatabaseTimestamp(row.lastUsedAt),
    sources: sourceCounts(row),
  }))
}

/** MAX() over a union comes back as the driver's raw text, always UTC under drizzle's session assumption. */
function parseDatabaseTimestamp(value: string | Date | null): Date | null {
  if (value === null) return null
  if (value instanceof Date) return value
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Current members of one of the organization's teams, for a team view; null when the team is not in this organization. */
export async function libraryUsageTeamMemberIds(organizationId: DenTypeId<"organization">, teamId: string): Promise<string[] | null> {
  const team = await db.select({ id: TeamTable.id }).from(TeamTable)
    .where(and(eq(TeamTable.id, normalizeDenTypeId("team", teamId)), eq(TeamTable.organizationId, organizationId))).limit(1)
  if (!team[0]) return null
  const rows = await db.select({ memberId: TeamMemberTable.orgMembershipId }).from(TeamMemberTable)
    .innerJoin(MemberTable, and(eq(MemberTable.id, TeamMemberTable.orgMembershipId), eq(MemberTable.organizationId, organizationId)))
    .where(eq(TeamMemberTable.teamId, team[0].id))
  return rows.flatMap((row) => row.memberId ? [row.memberId] : [])
}

/** When the organization's first recorded use happened, across raw rows and rollups; null before any. */
export async function libraryUsageTrackingSince(organizationId: DenTypeId<"organization">): Promise<Date | null> {
  const [first, firstRollup] = await Promise.all([
    db.select({ at: min(raw.created_at) }).from(raw).where(eq(raw.organization_id, organizationId)),
    db.select({ at: min(rollup.bucket_start) }).from(rollup).where(eq(rollup.organization_id, organizationId)),
  ])
  const dates = [first[0]?.at, firstRollup[0]?.at].filter((value): value is Date => value instanceof Date)
  return dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : null
}

/** Legacy native connections have no row; their id is the provider key. */
const legacyNativeConnectionNames: Record<string, string> = {
  "google-workspace": "Google Workspace",
  "microsoft-365": "Microsoft 365",
}

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

async function libraryItems(organizationId: DenTypeId<"organization">, kind: LibraryUsageKind, usedItemIds: ReadonlySet<string>): Promise<LibraryItem[]> {
  if (kind === "skills") {
    const items = new Map<string, LibraryItem>()
    // A skill can sit in several plugins; list it once, under the first plugin by name.
    for (const row of await skillItems(organizationId)) {
      if (!items.has(row.skillId)) items.set(row.skillId, { id: row.skillId, name: row.skillName, detail: row.pluginName, pluginId: row.pluginId, tracksFailures: false })
    }
    return [...items.values()]
  }
  if (kind === "plugins") {
    const [plugins, skills] = await Promise.all([
      db.select({ id: PluginTable.id, name: PluginTable.name }).from(PluginTable)
        .where(and(eq(PluginTable.organizationId, organizationId), eq(PluginTable.status, "active"), isNull(PluginTable.deletedAt))),
      skillItems(organizationId),
    ])
    const skillCounts = new Map<string, number>()
    for (const skill of skills) skillCounts.set(skill.pluginId, (skillCounts.get(skill.pluginId) ?? 0) + 1)
    return plugins.map((plugin) => {
      const skillCount = skillCounts.get(plugin.id) ?? 0
      return { id: plugin.id, name: plugin.name, detail: skillCount > 0 ? countLabel(skillCount, "skill") : null, pluginId: null, tracksFailures: true }
    })
  }
  const connections = await db.select({ id: ExternalMcpConnectionTable.id, name: ExternalMcpConnectionTable.name })
    .from(ExternalMcpConnectionTable)
    .where(eq(ExternalMcpConnectionTable.organizationId, organizationId))
  const items: LibraryItem[] = connections.map((connection) => ({ id: connection.id, name: connection.name, detail: null, pluginId: null, tracksFailures: true }))
  const known = new Set(items.map((item) => item.id))
  for (const [key, name] of Object.entries(legacyNativeConnectionNames)) {
    if (!known.has(key) && usedItemIds.has(key)) items.push({ id: key, name, detail: null, pluginId: null, tracksFailures: true })
  }
  return items
}

/** Every live skill, plugin or connector with its usage over the window; unused items come back with zeros. */
export async function readLibraryUsage(organizationId: DenTypeId<"organization">, kind: LibraryUsageKind, days: number, now = new Date()): Promise<LibraryUsageReport> {
  // One row per item (people counted distinct across sources by the database), so
  // the report never grows with members x items; it is bounded by the live library.
  const [breakdown, trackingSince] = await Promise.all([
    readLibraryUsageBreakdown({ organizationId, kind, days, groupBy: ["item"], now, maxRows: null }),
    libraryUsageTrackingSince(organizationId),
  ])
  const totals: ItemUsageTotals[] = breakdown.flatMap((row) => row.itemId
    ? [{ itemId: row.itemId, uses: row.uses, people: row.people, failures: row.failures, lastUsedAt: row.lastUsedAt }]
    : [])
  const items = await libraryItems(organizationId, kind, new Set(totals.map((entry) => entry.itemId)))
  return {
    kind,
    days,
    trackingSince: trackingSince ? trackingSince.toISOString() : null,
    items: buildLibraryUsageRows(items, totals),
  }
}
