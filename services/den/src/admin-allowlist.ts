import { inArray, sql } from "drizzle-orm"
import { db } from "./db/index.js"
import { AdminAllowlistTable } from "./db/schema.js"

const ADMIN_ALLOWLIST_SEEDS = [
  {
    id: "admin-ben-openworklabs-com",
    email: "ben@openworklabs.com",
    note: "Seeded internal admin",
  },
  {
    id: "admin-berk-openworklabs-com",
    email: "berk@openworklabs.com",
    note: "Seeded internal admin",
  },
] as const

const MANAGED_ADMIN_ALLOWLIST_IDS = [
  "admin-ben-openworklabs-com",
  "admin-jan-openworklabs-com",
  "admin-omar-openworklabs-com",
  "admin-berk-openworklabs-com",
] as const

let ensureAdminAllowlistSeededPromise: Promise<void> | null = null

async function seedAdminAllowlist() {
  for (const entry of ADMIN_ALLOWLIST_SEEDS) {
    await db
      .insert(AdminAllowlistTable)
      .values(entry)
      .onDuplicateKeyUpdate({
        set: {
          note: entry.note,
          updated_at: sql`CURRENT_TIMESTAMP(3)`,
        },
      })
  }

  const activeSeedIds = new Set<string>(ADMIN_ALLOWLIST_SEEDS.map((entry) => entry.id))
  const staleSeedIds = MANAGED_ADMIN_ALLOWLIST_IDS.filter((id) => !activeSeedIds.has(id))

  if (staleSeedIds.length > 0) {
    await db.delete(AdminAllowlistTable).where(inArray(AdminAllowlistTable.id, staleSeedIds))
  }
}

export async function ensureAdminAllowlistSeeded() {
  if (!ensureAdminAllowlistSeededPromise) {
    ensureAdminAllowlistSeededPromise = seedAdminAllowlist().catch((error) => {
      ensureAdminAllowlistSeededPromise = null
      throw error
    })
  }

  await ensureAdminAllowlistSeededPromise
}
