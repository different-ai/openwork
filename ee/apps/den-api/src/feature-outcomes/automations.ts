import { and, count, eq, gte, lt, max, sql } from "@openwork-ee/den-db/drizzle"
import { AutomationRevisionTable, AutomationRunTable, AutomationTable } from "@openwork-ee/den-db/schema"
import type { AutomationScheduleKind } from "@openwork/types/automations"
import { db } from "../db.js"
import { type FeatureOutcomeReader, type FeatureOutcomeStatus, type FeatureOutcomeUnit } from "./outcomes.js"

type RunStatus = (typeof AutomationRunTable.$inferSelect)["status"]

const OUTCOME: Record<RunStatus, FeatureOutcomeStatus> = {
  queued: "running",
  claimed: "running",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  // The owner stopped it: it did not run, and nothing is wrong.
  cancelled: "skipped",
  skipped: "skipped",
}

/**
 * Why a run did not succeed, from the receipt automation_run already holds:
 * the error code (`AutomationError["code"]`) for failed and skipped runs.
 * A skip without one is the overlap receipt repository.claim writes when the
 * previous occurrence is still running.
 *
 * TODO(calendar skip reasons): the calendar-trigger change in flight writes
 * `skipped` receipts with typed reasons the owner can fix (calendar-trigger.ts,
 * calendar-trigger-source.ts). Once it lands, read its reason field here and
 * keep error.code as the fallback.
 */
function reasonOf(status: RunStatus, code: string | null): string | null {
  if (status === "cancelled") return "cancelled"
  if (status === "failed") return code ?? "unknown"
  if (status === "skipped") return code ?? "previous_run_active"
  return null
}

/**
 * Runs of Automations whose run used this kind of schedule, per organization,
 * UTC day, status and reason. Indexed: per Automation, a range on
 * automation_run_history (automation_id, created_at), forced so a large run
 * table is never scanned; the run's revision is a primary-key lookup. Reads
 * no instructions, results or meeting context (trigger_context).
 */
export function automationRunOutcomes(kind: Extract<AutomationScheduleKind, "interval" | "calendar">, unit: FeatureOutcomeUnit): FeatureOutcomeReader {
  return async (range) => {
    // Drizzle writes timestamps as UTC wall-clock time, so formatting in the session's zone gives the UTC day.
    const day = sql<string>`date_format(${AutomationRunTable.created_at}, '%Y-%m-%d')`
    const code = sql<string | null>`json_unquote(json_extract(${AutomationRunTable.error}, '$.code'))`
    const rows = await db
      .select({
        organizationId: AutomationTable.organization_id,
        day,
        status: AutomationRunTable.status,
        code,
        runs: count(),
        lastAt: max(AutomationRunTable.created_at),
      })
      .from(AutomationTable)
      .innerJoin(AutomationRunTable, and(
        eq(AutomationRunTable.automation_id, AutomationTable.id),
        gte(AutomationRunTable.created_at, range.from),
        lt(AutomationRunTable.created_at, range.to),
      ), { forceIndex: "automation_run_history" })
      .innerJoin(AutomationRevisionTable, eq(AutomationRevisionTable.id, AutomationRunTable.revision_id))
      .where(eq(AutomationRevisionTable.schedule_kind, kind))
      .groupBy(AutomationTable.organization_id, day, AutomationRunTable.status, code)
    return {
      unit,
      limited: null,
      coverage: null,
      rows: rows.flatMap((row) => row.lastAt ? [{
        organizationId: row.organizationId,
        day: String(row.day),
        status: OUTCOME[row.status],
        reason: reasonOf(row.status, row.code),
        count: Number(row.runs),
        delivered: null,
        lastAt: row.lastAt,
      }] : []),
    }
  }
}
