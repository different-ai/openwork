import { sql } from "./db/drizzle.js"
import { db } from "./db/index.js"
import { AdminAllowlistTable } from "./db/schema.js"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

const ADMIN_ALLOWLIST_SEEDS = [
  {
    email: "ben@openworklabs.com",
    note: "Seeded internal admin",
  },
  {
    email: "jan@openworklabs.com",
    note: "Seeded internal admin",
  },
  {
    email: "omar@openworklabs.com",
    note: "Seeded internal admin",
  },
  {
    email: "berk@openworklabs.com",
    note: "Seeded internal admin",
  },
] as const

let ensureAdminAllowlistSeededPromise: Promise<void> | null = null

async function seedAdminAllowlist() {
  for (const entry of ADMIN_ALLOWLIST_SEEDS) {
    await db
      .insert(AdminAllowlistTable)
      .values({
        id: createDenTypeId("adminAllowlist"),
        ...entry,
      })
      .onDuplicateKeyUpdate({
        set: {
          note: entry.note,
          updated_at: sql`CURRENT_TIMESTAMP(3)`,
        },
      })
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
