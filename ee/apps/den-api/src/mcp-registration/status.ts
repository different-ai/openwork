import { and, desc, eq, gte, inArray, sql } from "@openwork-ee/den-db/drizzle"
import { McpRegistrationEventTable, McpRegistrationStatusTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { McpRegistrationOutcome, McpRegistrationSource, McpRegistrationStatus } from "@openwork/types/den/mcp-registration"
import { db } from "../db.js"
import { appLogger } from "../observability/logger.js"
import { type McpRegistrationFacts, nextMcpRegistrationStatus, normalizeIssuer, redactEndpoint } from "./status-rules.js"

const logger = appLogger.child({ component: "mcp_registration" })

export type McpRegistrationObservation = McpRegistrationFacts & {
  issuer: string
  outcome: McpRegistrationOutcome
  source: McpRegistrationSource
  presetId?: string | null
  serverUrl?: string | null
  registrationEndpoint?: string | null
  organizationId?: DenTypeId<"organization"> | null
  connectionId?: string | null
  httpStatus?: number | null
  diagnosticCode?: string | null
  reference?: string | null
  at?: Date
}

const ACCEPTED: ReadonlySet<McpRegistrationOutcome> = new Set(["registered_client_metadata", "registered_dynamic"])

/**
 * Records one observation: appends the event and moves the issuer's status. Best effort: never throws, so a sign-in
 * is never failed or delayed by reporting.
 */
export async function recordMcpRegistrationObservation(observation: McpRegistrationObservation): Promise<void> {
  const issuer = normalizeIssuer(observation.issuer)
  if (!issuer) return
  const at = observation.at ?? new Date()
  const accepted = ACCEPTED.has(observation.outcome)
  const refused = observation.outcome === "refused"
  try {
    await db.insert(McpRegistrationEventTable).values({
      id: createDenTypeId("mcpRegistrationEvent"),
      issuer,
      presetId: observation.presetId ?? null,
      source: observation.source,
      outcome: observation.outcome,
      organizationId: observation.organizationId ?? null,
      connectionId: observation.connectionId ?? null,
      httpStatus: observation.httpStatus ?? null,
      diagnosticCode: observation.diagnosticCode?.slice(0, 96) ?? null,
      reference: observation.reference?.slice(0, 96) ?? null,
      createdAt: at,
    })

    const [current] = await db.select({ status: McpRegistrationStatusTable.status })
      .from(McpRegistrationStatusTable).where(eq(McpRegistrationStatusTable.issuer, issuer)).limit(1)
    const status = nextMcpRegistrationStatus(current?.status ?? null, observation.outcome, observation)
    const facts = {
      status,
      lastSource: observation.source,
      lastHttpStatus: observation.httpStatus ?? null,
      lastDiagnosticCode: observation.diagnosticCode?.slice(0, 96) ?? null,
      lastReference: observation.reference?.slice(0, 96) ?? null,
      lastObservedAt: at,
      updatedAt: at,
      ...(observation.presetId ? { presetId: observation.presetId } : {}),
      ...(observation.serverUrl ? { serverUrl: redactEndpoint(observation.serverUrl) } : {}),
      ...(observation.registrationEndpoint ? { registrationEndpoint: redactEndpoint(observation.registrationEndpoint) } : {}),
      ...(typeof observation.clientMetadataSupported === "boolean" ? { clientMetadataSupported: observation.clientMetadataSupported } : {}),
      ...(typeof observation.dynamicRegistrationSupported === "boolean" ? { dynamicRegistrationSupported: observation.dynamicRegistrationSupported } : {}),
      ...(observation.source === "probe" ? { lastProbedAt: at } : {}),
      ...(accepted ? { lastAcceptedAt: at } : {}),
      ...(refused ? { lastRefusedAt: at } : {}),
    }
    await db.insert(McpRegistrationStatusTable).values({
      id: createDenTypeId("mcpRegistrationStatus"),
      issuer,
      acceptedCount: accepted ? 1 : 0,
      refusedCount: refused ? 1 : 0,
      createdAt: at,
      ...facts,
    }).onDuplicateKeyUpdate({
      set: {
        ...facts,
        acceptedCount: accepted ? sql`${McpRegistrationStatusTable.acceptedCount} + 1` : sql`${McpRegistrationStatusTable.acceptedCount}`,
        refusedCount: refused ? sql`${McpRegistrationStatusTable.refusedCount} + 1` : sql`${McpRegistrationStatusTable.refusedCount}`,
      },
    })
  } catch (error) {
    logger.warn("mcp_registration_record_failed", {
      issuer,
      outcome: observation.outcome,
      source: observation.source,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export type McpRegistrationStatusRow = typeof McpRegistrationStatusTable.$inferSelect

/** Current status for each issuer, most recently observed first. */
export async function listMcpRegistrationStatuses(): Promise<McpRegistrationStatusRow[]> {
  return db.select().from(McpRegistrationStatusTable).orderBy(desc(McpRegistrationStatusTable.lastObservedAt))
}

/** Statuses for the given issuers, for annotating presets. Empty on any database error. */
export async function mcpRegistrationStatusByIssuer(issuers: readonly string[]): Promise<Map<string, McpRegistrationStatus>> {
  const normalized = [...new Set(issuers.map(normalizeIssuer).filter((value): value is string => value !== null))]
  const result = new Map<string, McpRegistrationStatus>()
  if (normalized.length === 0) return result
  try {
    const rows = await db.select({ issuer: McpRegistrationStatusTable.issuer, status: McpRegistrationStatusTable.status })
      .from(McpRegistrationStatusTable).where(inArray(McpRegistrationStatusTable.issuer, normalized))
    for (const row of rows) result.set(row.issuer, row.status)
  } catch (error) {
    logger.warn("mcp_registration_read_failed", { message: error instanceof Error ? error.message : String(error) })
  }
  return result
}

/** Statuses keyed by preset id, for the catalog. Empty on any database error. */
export async function mcpRegistrationStatusByPreset(): Promise<Map<string, McpRegistrationStatus>> {
  const result = new Map<string, McpRegistrationStatus>()
  try {
    const rows = await db.select({ presetId: McpRegistrationStatusTable.presetId, status: McpRegistrationStatusTable.status })
      .from(McpRegistrationStatusTable)
    for (const row of rows) if (row.presetId) result.set(row.presetId, row.status)
  } catch (error) {
    logger.warn("mcp_registration_read_failed", { message: error instanceof Error ? error.message : String(error) })
  }
  return result
}

export type McpRegistrationEventCount = { issuer: string; outcome: McpRegistrationOutcome; source: McpRegistrationSource; count: number }

/** How often each issuer saw each outcome since a date, for reports. */
export async function countMcpRegistrationEvents(since: Date): Promise<McpRegistrationEventCount[]> {
  const rows = await db.select({
    issuer: McpRegistrationEventTable.issuer,
    outcome: McpRegistrationEventTable.outcome,
    source: McpRegistrationEventTable.source,
    count: sql<number>`count(*)`,
  }).from(McpRegistrationEventTable)
    .where(and(gte(McpRegistrationEventTable.createdAt, since)))
    .groupBy(McpRegistrationEventTable.issuer, McpRegistrationEventTable.outcome, McpRegistrationEventTable.source)
  return rows.map((row) => ({ ...row, count: Number(row.count) }))
}

/**
 * Claims an issuer for the scheduled check: false when another replica holds it or it was checked within
 * minIntervalMs, so restarts and replicas never re-register with a provider more than once per interval.
 */
export async function claimMcpRegistrationProbe(issuer: string, leaseMs: number, minIntervalMs: number, now = new Date()): Promise<boolean> {
  const normalized = normalizeIssuer(issuer)
  if (!normalized) return false
  const leaseUntil = new Date(now.getTime() + leaseMs)
  const probedBefore = new Date(now.getTime() - minIntervalMs)
  try {
    await db.insert(McpRegistrationStatusTable).values({
      id: createDenTypeId("mcpRegistrationStatus"), issuer: normalized, status: "unknown", createdAt: now, updatedAt: now,
    }).onDuplicateKeyUpdate({ set: { issuer: sql`${McpRegistrationStatusTable.issuer}` } })
    const result = await db.update(McpRegistrationStatusTable)
      .set({ probeLeaseUntil: leaseUntil })
      .where(and(
        eq(McpRegistrationStatusTable.issuer, normalized),
        sql`(${McpRegistrationStatusTable.probeLeaseUntil} is null or ${McpRegistrationStatusTable.probeLeaseUntil} < ${now})`,
        sql`(${McpRegistrationStatusTable.lastProbedAt} is null or ${McpRegistrationStatusTable.lastProbedAt} < ${probedBefore})`,
      ))
    return affectedRows(result) > 0
  } catch (error) {
    logger.warn("mcp_registration_claim_failed", { issuer: normalized, message: error instanceof Error ? error.message : String(error) })
    return false
  }
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}
