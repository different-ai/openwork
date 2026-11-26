import { and, count, eq, gte, isNotNull, lt, max, sql } from "@openwork-ee/den-db/drizzle"
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
  cancelled: "skipped",
  skipped: "skipped",
}

function reasonOf(status: RunStatus, code: string | null): string | null {
  if (status === "cancelled") return "cancelled"
  if (status === "failed") return code ?? "unknown"
  if (status === "skipped") return code ?? "previous_run_active"
  return null
}

export function automationRunOutcomes(kind: Extract<AutomationScheduleKind, "interval" | "calendar"> | "personal_agent", unit: FeatureOutcomeUnit): FeatureOutcomeReader {
  return async (range) => {
    const day = sql<string>`date_format(${AutomationRunTable.created_at}, '%Y-%m-%d')`
    const code = sql<string | null>`json_unquote(json_extract(${AutomationRunTable.error}, '$.code'))`
    const runs = db
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
    const filtered = kind === "personal_agent"
      ? runs.where(isNotNull(AutomationTable.agent_id))
      : runs.innerJoin(AutomationRevisionTable, eq(AutomationRevisionTable.id, AutomationRunTable.revision_id))
        .where(eq(AutomationRevisionTable.schedule_kind, kind))
    const rows = await filtered.groupBy(AutomationTable.organization_id, day, AutomationRunTable.status, code)
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
