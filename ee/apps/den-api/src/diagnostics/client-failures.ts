import { and, desc, gte, lt, lte, sql } from "@openwork-ee/den-db/drizzle"
import { ClientFailureReportTable as table } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { ClientFailureReport, ClientFailureSummary } from "@openwork/types/den/diagnostics"
import { db } from "../db.js"

const DAY = 86_400_000

export async function recordClientFailures(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  reports: ClientFailureReport[]
}, now = Date.now()) {
  const rows = input.reports.filter((report) => {
    const at = Date.parse(report.occurredAt)
    return at >= now - 14 * DAY && at <= now + 300_000
  }).map((report) => ({
    ...report,
    reportId: report.reportId.toLowerCase(),
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    occurredAt: new Date(report.occurredAt),
    receivedAt: new Date(now),
  }))
  if (rows.length) await db.insert(table).values(rows).onDuplicateKeyUpdate({ set: { reportId: sql`${table.reportId}` } })
  await db.delete(table).where(lt(table.occurredAt, new Date(now - 90 * DAY))).limit(500).catch(() => undefined)
}

export async function readClientFailures(days: number, now = Date.now()): Promise<ClientFailureSummary> {
  const window = and(gte(table.occurredAt, new Date(now - days * DAY)), lte(table.occurredAt, new Date(now)))
  const totals = {
    reports: sql<number>`count(*)`.mapWith(Number),
    failures: sql<number>`sum(${table.count})`.mapWith(Number),
    organizations: sql<number>`count(distinct ${table.organizationId})`.mapWith(Number),
    latestOccurrence: sql<Date>`max(${table.occurredAt})`.mapWith(table.occurredAt),
  }
  const [components, versions, latest] = await Promise.all([
    db.select({ component: table.component, reason: table.reason, ...totals }).from(table).where(window)
      .groupBy(table.component, table.reason).orderBy(desc(sql`sum(${table.count})`)),
    db.select({ appVersion: table.appVersion, ...totals }).from(table).where(window)
      .groupBy(table.appVersion).orderBy(desc(sql`sum(${table.count})`)),
    db.select().from(table).where(window).orderBy(desc(table.occurredAt)).limit(100),
  ])
  return {
    days,
    components: components.map((row) => ({ ...row, latestOccurrence: row.latestOccurrence.toISOString() })),
    versions: versions.map((row) => ({ ...row, latestOccurrence: row.latestOccurrence.toISOString() })),
    latest: latest.map(({ orgMembershipId: _, exitCode, httpStatus, ...row }) => ({
      ...row,
      occurredAt: row.occurredAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
      ...(exitCode === null ? {} : { exitCode }),
      ...(httpStatus === null ? {} : { httpStatus }),
    })),
  }
}
