import { and, desc, eq, type SQL } from "@openwork-ee/den-db/drizzle"
import { WorkerTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { keysetAfter, keysetPage, type KeysetCursor } from "../list-pagination.js"

type WorkerRow = typeof WorkerTable.$inferSelect

/** One page of an organization's workers ordered by (created_at desc, id desc). */
export async function listWorkersPage(input: {
  orgId: WorkerRow["org_id"]
  limit: number
  cursor?: KeysetCursor
}): Promise<{ items: WorkerRow[]; nextCursor: string | null }> {
  const limit = Math.min(50, Math.max(1, input.limit))
  const conditions: Array<SQL | undefined> = [eq(WorkerTable.org_id, input.orgId)]
  if (input.cursor) conditions.push(keysetAfter({ at: WorkerTable.created_at, id: WorkerTable.id }, input.cursor))
  const rows = await db
    .select()
    .from(WorkerTable)
    .where(and(...conditions))
    .orderBy(desc(WorkerTable.created_at), desc(WorkerTable.id))
    .limit(limit + 1)
  return keysetPage(rows, limit, (row) => ({ at: row.created_at, id: row.id }))
}
