/**
 * Smoke check for the dry-run workflow: the restored branch answers through
 * Den's database client and the tables most risky changes read are present.
 * Prints yes/no per table only.
 */
import { sql } from "@openwork-ee/den-db/drizzle"
import { dryRunDb, fail, finish, report } from "./connect.js"

const TABLES = ["organization", "member", "org_subscriptions", "feature_rollout", "organization_feature"] as const

const { db } = dryRunDb()

for (const table of TABLES) {
  try {
    await db.execute(sql.raw(`SELECT 1 FROM \`${table}\` LIMIT 1`))
    report(`${table} readable`, true)
  } catch {
    report(`${table} readable`, false)
    fail(`${table} could not be read`)
  }
}

finish("Dry run: smoke check")
