import { and, desc, eq, gte, lt, lte, sql } from "@openwork-ee/den-db/drizzle"
import { ProcessTimingRunTable } from "@openwork-ee/den-db/schema"
import type { ProcessTimingReport } from "@openwork/types/den/diagnostics"
import { db } from "../db.js"
import { summarizeProcessTimings } from "./process-timing-summary.js"

const DAY_MS = 86_400_000

export async function recordProcessTiming(report: ProcessTimingReport, now = Date.now()) {
  await db.insert(ProcessTimingRunTable).values({
    ...report,
    runId: report.runId.toLowerCase(),
    startedAt: new Date(report.startedAt).toISOString(),
    receivedAt: new Date(now),
  }).onDuplicateKeyUpdate({ set: { runId: sql`${ProcessTimingRunTable.runId}` } })
  await db.delete(ProcessTimingRunTable)
    .where(lt(ProcessTimingRunTable.receivedAt, new Date(now - 90 * DAY_MS)))
    .limit(500)
    .catch(() => undefined)
}

export async function readProcessTimings(input: {
  days: number
  process?: ProcessTimingReport["process"]
  environment?: ProcessTimingReport["environment"]
  reportingEnabled: boolean
}, now = Date.now()) {
  const rows = await db.select().from(ProcessTimingRunTable).where(and(
    gte(ProcessTimingRunTable.startedAt, new Date(now - input.days * DAY_MS).toISOString()),
    lte(ProcessTimingRunTable.startedAt, new Date(now).toISOString()),
    input.process ? eq(ProcessTimingRunTable.process, input.process) : undefined,
    input.environment ? eq(ProcessTimingRunTable.environment, input.environment) : undefined,
  )).orderBy(desc(ProcessTimingRunTable.startedAt))
  return summarizeProcessTimings(rows.map((row) => ({
    ...row,
    version: 1,
    startedAt: row.startedAt,
    receivedAt: row.receivedAt.toISOString(),
  })), input.days, input.reportingEnabled)
}
