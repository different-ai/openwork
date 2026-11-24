import { createDenDb } from "../src/client.ts"
import { reconcileDefaultPermissionSets, type ReconcilePermissionSetsResult } from "../src/permissions.ts"

function createDatabaseFromEnv() {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl) return createDenDb({ databaseUrl, mode: "mysql" })

  const host = process.env.DATABASE_HOST?.trim()
  const username = process.env.DATABASE_USERNAME?.trim()
  const password = process.env.DATABASE_PASSWORD ?? ""
  if (!host || !username) {
    throw new Error("Provide DATABASE_URL, or DATABASE_HOST/DATABASE_USERNAME/DATABASE_PASSWORD.")
  }
  return createDenDb({ mode: "planetscale", planetscale: { host, username, password } })
}

export async function reconcilePermissionsFromEnv(): Promise<ReconcilePermissionSetsResult> {
  const { db, client } = createDatabaseFromEnv()
  try {
    const result = await reconcileDefaultPermissionSets(db)
    console.log(`[den-db] permission sets reconciled: ${result.setsChecked} checked, ${result.setsChanged} changed, ${result.rowsInserted} rows added`)
    return result
  } finally {
    if ("end" in client) await client.end()
  }
}
