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
