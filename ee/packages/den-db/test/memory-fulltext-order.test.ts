import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"
import {
  ensureMemoryFulltextIndex,
  type FulltextIndexExecutor,
} from "../src/fulltext.ts"

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..")

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

test("memory schema and migration use portable created_at defaults before fulltext creation", async () => {
  const schema = await readFile(join(packageDir, "src/schema/memory.ts"), "utf8")
  assert.match(schema, /default\(sql`CURRENT_TIMESTAMP\(3\)`\)/)
  assert.doesNotMatch(schema, /timestamps\.created_at/)

  const snapshot = await readFile(join(packageDir, "drizzle/meta/0041_snapshot.json"), "utf8")
  assert.match(snapshot, /"memory_context": \{[\s\S]*"created_at": \{[\s\S]*"default": "CURRENT_TIMESTAMP\(3\)"/)
  assert.match(snapshot, /"memory": \{[\s\S]*"created_at": \{[\s\S]*"default": "CURRENT_TIMESTAMP\(3\)"/)

  const migration = await readFile(join(packageDir, "drizzle/0041_spicy_silk_fever.sql"), "utf8")
  assert.equal((migration.match(/MODIFY COLUMN `created_at` timestamp\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\)/g) ?? []).length, 2)
  assert.ok(migration.indexOf("ALTER TABLE `memory_context`") < migration.indexOf("ALTER TABLE `memory`"))
  assert.doesNotMatch(migration, /\bUPDATE\b/i)
  assert.doesNotMatch(migration, /sql_mode/i)
})

test("ensureMemoryFulltextIndex normalizes memory timestamps before CREATE FULLTEXT", async () => {
  const calls: string[] = []
  const portableDefaults = new Set<string>()
  const executor: FulltextIndexExecutor = {
    query: async (sql, args = []) => {
      const normalized = normalizeSql(sql)
      calls.push(normalized)

      if (normalized.includes("information_schema.COLUMNS")) {
        const table = args[0]
        if (typeof table !== "string") return []
        return [{ default_value: portableDefaults.has(table) ? "CURRENT_TIMESTAMP(3)" : "(now())" }]
      }

      if (normalized.startsWith("ALTER TABLE `memory_context`")) {
        portableDefaults.add("memory_context")
        return []
      }

      if (normalized.startsWith("ALTER TABLE `memory`")) {
        portableDefaults.add("memory")
        return []
      }

      if (normalized.includes("information_schema.STATISTICS")) {
        return []
      }

      return []
    },
  }

  await ensureMemoryFulltextIndex(executor)

  const contextAlter = calls.findIndex((sql) => sql.startsWith("ALTER TABLE `memory_context`"))
  const memoryAlter = calls.findIndex((sql) => sql.startsWith("ALTER TABLE `memory`"))
  const createFulltext = calls.findIndex((sql) => sql.startsWith("CREATE FULLTEXT INDEX"))
  assert.ok(contextAlter !== -1)
  assert.ok(memoryAlter !== -1)
  assert.ok(createFulltext !== -1)
  assert.ok(contextAlter < createFulltext)
  assert.ok(memoryAlter < createFulltext)
  assert.equal(calls.some((sql) => /sql_mode/i.test(sql)), false)
})

const mysqlUrl = process.env.DEN_DB_MYSQL_TEST_URL?.trim()

test("normalization preserves existing row timestamps on MySQL", { skip: !mysqlUrl }, async () => {
  if (!mysqlUrl) return

  const connection = await mysql.createConnection(mysqlUrl)
  const executor: FulltextIndexExecutor = {
    query: async (sql, args = []) => {
      const [rows] = await connection.query(sql, args)
      return Array.isArray(rows) ? rows.filter(isRecord) : []
    },
  }

  try {
    await connection.query("DROP TABLE IF EXISTS `memory_context`")
    await connection.query("DROP TABLE IF EXISTS `memory`")
    await connection.query("SET SESSION sql_mode = CONCAT_WS(',', @@SESSION.sql_mode, 'NO_ZERO_DATE', 'NO_ZERO_IN_DATE')")

    try {
      await createLegacyTables(connection, "DEFAULT (now())")
    } catch {
      await connection.query("DROP TABLE IF EXISTS `memory_context`")
      await connection.query("DROP TABLE IF EXISTS `memory`")
      await createLegacyTables(connection, "")
    }

    await connection.query(
      `INSERT INTO memory (id, user_id, org_id, scope, content, source, created_at, updated_at)
       VALUES ('mem_preserve', 'user_preserve', 'org_preserve', 'user', 'Fulltext strict timestamp proof', 'test', '2024-01-02 03:04:05.123', '2024-01-02 03:04:05.123')`,
    )
    await connection.query(
      `INSERT INTO memory_context (id, memory_id, snippet, created_at)
       VALUES ('ctx_preserve', 'mem_preserve', 'Preserve this timestamp', '2024-02-03 04:05:06.789')`,
    )

    const result = await ensureMemoryFulltextIndex(executor)
    assert.equal(result.created, true)

    const defaults = await executor.query(
      `SELECT table_name AS table_name, column_default AS column_default FROM information_schema.COLUMNS
       WHERE table_schema = DATABASE()
         AND table_name IN ('memory', 'memory_context')
         AND column_name = 'created_at'
       ORDER BY table_name`,
    )
    assert.deepEqual(defaults.map((row) => row.column_default), ["CURRENT_TIMESTAMP(3)", "CURRENT_TIMESTAMP(3)"])

    const memoryRows = await executor.query("SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at FROM memory WHERE id = 'mem_preserve'")
    const contextRows = await executor.query("SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at FROM memory_context WHERE id = 'ctx_preserve'")
    assert.equal(memoryRows[0]?.created_at, "2024-01-02 03:04:05.123000")
    assert.equal(contextRows[0]?.created_at, "2024-02-03 04:05:06.789000")

    const fulltextRows = await executor.query(
      `SELECT index_type AS index_type FROM information_schema.STATISTICS
       WHERE table_schema = DATABASE()
         AND table_name = 'memory'
         AND index_name = 'memory_content_fulltext'`,
    )
    assert.equal(fulltextRows[0]?.index_type, "FULLTEXT")
  } finally {
    await connection.query("DROP TABLE IF EXISTS `memory_context`").catch(() => {})
    await connection.query("DROP TABLE IF EXISTS `memory`").catch(() => {})
    await connection.end()
  }
})

async function createLegacyTables(
  connection: mysql.Connection,
  createdAtDefault: string,
) {
  await connection.query(`
    CREATE TABLE memory_context (
      id varchar(64) NOT NULL,
      memory_id varchar(64) NOT NULL,
      citation json,
      snippet text NOT NULL,
      origin enum('active_conversation','searched_conversation'),
      created_at timestamp(3) NOT NULL ${createdAtDefault},
      PRIMARY KEY (id)
    )
  `)
  await connection.query(`
    CREATE TABLE memory (
      id varchar(64) NOT NULL,
      user_id varchar(64) NOT NULL,
      org_id varchar(64) NOT NULL,
      scope enum('user','org') NOT NULL DEFAULT 'user',
      content text NOT NULL,
      source varchar(64) NOT NULL,
      tags json,
      created_at timestamp(3) NOT NULL ${createdAtDefault},
      updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id)
    )
  `)
}
