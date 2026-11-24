import { sql } from "drizzle-orm"
import type { createDenDb } from "./client"
import { FreeAutoOrgFounderTable } from "./schema/inference"

type Db = ReturnType<typeof createDenDb>["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Founder = typeof FreeAutoOrgFounderTable.$inferInsert

export async function recordFreeAutoFounder(database: Db | Tx, organizationId: Founder["organization_id"], userId: Founder["founder_user_id"]) {
  await database.insert(FreeAutoOrgFounderTable).values({ organization_id: organizationId, founder_user_id: userId })
    .onDuplicateKeyUpdate({ set: { founder_user_id: sql`${FreeAutoOrgFounderTable.founder_user_id}` } })
}
