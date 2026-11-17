import { sql } from "@openwork-ee/den-db/drizzle"
import { db } from "./db.js"

export async function checkDatabaseReadiness(): Promise<void> {
  await db.execute(sql`select 1`)
}
