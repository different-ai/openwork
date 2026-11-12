import { and, count, gte, lt, max, sql } from "@openwork-ee/den-db/drizzle"
import { McpEventReceiptTable as Receipt } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { RECEIPT_RETENTION_MS } from "../mcp-events/repository.js"
import type { FeatureOutcomeReader, FeatureOutcomeStatus } from "./outcomes.js"

const statusOf = (status: string): FeatureOutcomeStatus => status === "delivered" ? "succeeded" : status === "skipped" ? "skipped" : status === "failed" ? "failed" : "running"
/** Delivered means the existing runner accepted the event turn, not that the model completed its instruction. */
export const readMcpEventOutcomes: FeatureOutcomeReader = async (range) => {
  const retained = new Date(range.to.getTime() - RECEIPT_RETENTION_MS)
  const from = retained > range.from ? retained : range.from
  const day = sql<string>`date_format(${Receipt.createdAt}, '%Y-%m-%d')`
  const rows = await db.select({ organizationId: Receipt.organizationId, day, status: Receipt.status, count: count(), lastAt: max(Receipt.createdAt) }).from(Receipt)
    .where(and(gte(Receipt.createdAt, from), lt(Receipt.createdAt, range.to))).groupBy(Receipt.organizationId, day, Receipt.status)
  return {
    unit: "message", limited: null, coverage: from > range.from ? { from, counts: "all" } : null,
    rows: rows.flatMap((row) => row.lastAt ? [{ ...row, lastAt: row.lastAt, count: Number(row.count), status: statusOf(row.status), reason: row.status === "failed" ? "delivery_failed" : row.status === "skipped" ? "subscription_unavailable" : null, delivered: row.status === "delivered" ? Number(row.count) : 0 }] : []),
  }
}
