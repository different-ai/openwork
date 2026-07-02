/**
 * Stage 1 proof harness (TASK-1). Verifies, against a real database, that the memory
 * schema, typeids, and FULLTEXT index are actually in place — the claims that must hold
 * on a freshly bootstrapped DB where migration-only indexes are silently dropped (B2).
 *
 * Usage:
 *   DATABASE_URL=mysql://root:password@127.0.0.1:3306/openwork_den \
 *     node --import tsx scripts/verify-memory-schema.ts
 *
 * Exits non-zero on the first failed assertion so it can gate CI.
 */
import "../src/load-env.ts"
import mysql from "mysql2/promise"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  assertMemoryFulltextIndexExists,
  ensureMemoryFulltextIndex,
  type FulltextIndexExecutor,
} from "../src/fulltext.ts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (e.g. mysql://root:password@127.0.0.1:3306/openwork_den)")
  }

  const connection = await mysql.createConnection(databaseUrl)
  const executor: FulltextIndexExecutor = {
    query: async (sql, args = []) => {
      const [rows] = await connection.query(sql, args)
      return Array.isArray(rows) ? rows.filter(isRecord) : []
    },
  }

  const marker = createDenTypeId("memory")
  const passed: string[] = []

  function check(label: string, condition: boolean): void {
    if (!condition) {
      throw new Error(`FAIL: ${label}`)
    }
    passed.push(label)
  }

  try {
    // 1. Tables exist.
    const tables = await executor.query(
      `SELECT table_name FROM information_schema.TABLES
       WHERE table_schema = DATABASE() AND table_name IN ('memory','memory_context')`,
    )
    const tableNames = tables
      .map((row) => Object.values(row).find((value) => typeof value === "string"))
      .filter((value): value is string => Boolean(value))
    check("memory table exists", tableNames.includes("memory"))
    check("memory_context table exists", tableNames.includes("memory_context"))

    // 2. FULLTEXT index exists (direct information_schema read — independent of ensure code).
    const indexRows = await executor.query(
      `SELECT index_type FROM information_schema.STATISTICS
       WHERE table_schema = DATABASE() AND table_name = 'memory'
         AND index_name = 'memory_content_fulltext'`,
    )
    check("memory_content_fulltext index present", indexRows.length > 0)
    check(
      "index type is FULLTEXT",
      indexRows.some((row) => row.index_type === "FULLTEXT" || row.INDEX_TYPE === "FULLTEXT"),
    )
    // The exported assertion agrees.
    await assertMemoryFulltextIndexExists(executor)
    passed.push("assertMemoryFulltextIndexExists passes")

    // 3. Insert memory + 2 contexts (typeid round-trip) with content that MATCH can find.
    const content = `User deploys via den-worker-proxy into a Daytona sandbox [${marker}]`
    const orgId = createDenTypeId("org")
    const userId = createDenTypeId("user")
    await executor.query(
      `INSERT INTO memory (id, user_id, org_id, scope, content, source) VALUES (?, ?, ?, 'user', ?, 'chat')`,
      [marker, userId, orgId, content],
    )
    const ctx1 = createDenTypeId("memctx")
    const ctx2 = createDenTypeId("memctx")
    await executor.query(
      `INSERT INTO memory_context (id, memory_id, snippet, origin) VALUES (?, ?, 'excerpt one', 'active_conversation')`,
      [ctx1, marker],
    )
    await executor.query(
      `INSERT INTO memory_context (id, memory_id, snippet, origin) VALUES (?, ?, 'excerpt two', 'searched_conversation')`,
      [ctx2, marker],
    )
    const readBack = await executor.query(`SELECT id, scope FROM memory WHERE id = ?`, [marker])
    check("memory id round-trips through denTypeIdColumn", readBack[0]?.id === marker)
    check("scope defaults/stores 'user'", readBack[0]?.scope === "user")

    // 4. NL search matches on the FULLTEXT index.
    const matched = await executor.query(
      `SELECT id FROM memory WHERE MATCH(content) AGAINST (? IN NATURAL LANGUAGE MODE) AND id = ?`,
      ["Daytona", marker],
    )
    check("MATCH ... AGAINST finds the inserted memory", matched.length === 1)

    // 5. Explicit cascade (the exact tx Stage 2's delete handler will use).
    await connection.beginTransaction()
    await connection.query(`DELETE FROM memory_context WHERE memory_id = ?`, [marker])
    await connection.query(`DELETE FROM memory WHERE id = ?`, [marker])
    await connection.commit()
    const orphans = await executor.query(`SELECT id FROM memory_context WHERE memory_id = ?`, [marker])
    check("explicit cascade leaves 0 orphaned context rows", orphans.length === 0)

    // 6. Idempotency: ensure is a no-op when the index already exists.
    const second = await ensureMemoryFulltextIndex(executor)
    check("ensureMemoryFulltextIndex is idempotent (no re-create)", second.created === false)

    console.log(`\n✅ Stage 1 schema verified (${passed.length} checks):`)
    for (const label of passed) {
      console.log(`   • ${label}`)
    }
  } finally {
    // Roll back first: if an assertion threw inside step 5's open transaction, cleanup must
    // run with autocommit restored, else connection.end() discards it and leaks marker rows.
    await connection.rollback().catch(() => {})
    // Best-effort cleanup in case an assertion failed mid-way.
    await connection.query(`DELETE FROM memory_context WHERE memory_id = ?`, [marker]).catch(() => {})
    await connection.query(`DELETE FROM memory WHERE id = ?`, [marker]).catch(() => {})
    await connection.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
