import { and, desc, eq, gte, lt, sql } from "@openwork-ee/den-db/drizzle"
import { DesktopStartupReportTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { DesktopDiagnostics, DesktopStartupReport } from "@openwork/types/den/diagnostics"
import { db } from "../db.js"
import {
  DESKTOP_STARTUP_AGGREGATE_LIMIT,
  DESKTOP_STARTUP_RETENTION_MS,
  DESKTOP_STARTUP_WINDOW_MS,
  desktopStartupObservedAtAccepted,
  summarizeDesktopStartups,
} from "./desktop-startup-summary.js"

const PRUNE_BATCH = 500

export type DesktopStartupWriteResult = "recorded" | "ignored"

/**
 * Stores one launch report for the caller. Idempotent on (organization, attemptId):
 * a resend never changes the first row. Launches outside the accepted time window
 * are ignored rather than rejected so the app never retries them.
 */
export async function recordDesktopStartup(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  report: DesktopStartupReport
  now?: number
}): Promise<DesktopStartupWriteResult> {
  const now = input.now ?? Date.now()
  const observedAt = new Date(input.report.observedAt)
  if (!desktopStartupObservedAtAccepted(observedAt, now)) return "ignored"
  const { report } = input
  await db.insert(DesktopStartupReportTable).values({
    id: createDenTypeId("desktopStartupReport"),
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    attemptId: report.attemptId.toLowerCase(),
    appVersion: report.appVersion,
    platform: report.platform,
    success: report.success,
    failedStep: report.failedStep,
    failureReason: report.reason,
    windowMs: report.steps.window,
    engineMs: report.steps.engine,
    signedInMs: report.steps.signed_in,
    orgToolsMs: report.steps.org_tools,
    observedAt,
  }).onDuplicateKeyUpdate({ set: { id: sql`${DesktopStartupReportTable.id}` } })
  // Opportunistic, bounded retention: never fail an ingest because pruning did.
  await db.delete(DesktopStartupReportTable)
    .where(and(eq(DesktopStartupReportTable.organizationId, input.organizationId), lt(DesktopStartupReportTable.observedAt, new Date(now - DESKTOP_STARTUP_RETENTION_MS))))
    .limit(PRUNE_BATCH)
    .catch(() => undefined)
  return "recorded"
}

/** Desktop section for the organization's launches in the last 24 hours. */
export async function desktopStartupDiagnostics(organizationId: DenTypeId<"organization">, now = Date.now()): Promise<DesktopDiagnostics> {
  const rows = await db.select({
    orgMembershipId: DesktopStartupReportTable.orgMembershipId,
    appVersion: DesktopStartupReportTable.appVersion,
    success: DesktopStartupReportTable.success,
    failedStep: DesktopStartupReportTable.failedStep,
    failureReason: DesktopStartupReportTable.failureReason,
    windowMs: DesktopStartupReportTable.windowMs,
    engineMs: DesktopStartupReportTable.engineMs,
    signedInMs: DesktopStartupReportTable.signedInMs,
    orgToolsMs: DesktopStartupReportTable.orgToolsMs,
    observedAt: DesktopStartupReportTable.observedAt,
  })
    .from(DesktopStartupReportTable)
    .where(and(eq(DesktopStartupReportTable.organizationId, organizationId), gte(DesktopStartupReportTable.observedAt, new Date(now - DESKTOP_STARTUP_WINDOW_MS))))
    .orderBy(desc(DesktopStartupReportTable.observedAt))
    .limit(DESKTOP_STARTUP_AGGREGATE_LIMIT)
  return summarizeDesktopStartups(rows, now)
}
