import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import mysql from "mysql2/promise"
import { migrateLocalDatabase, localConnectionConfig } from "../scripts/dev-migrate.ts"
import { foundationSql, historyPrefix, inspectSchema, journalTable, loadMigrationPlan, record, stateTable } from "../scripts/migration-baseline.ts"
import { ensureSchemaRepairs, type Executor } from "../src/schema-repairs.ts"

const folder = new URL("../drizzle", import.meta.url).pathname
const plan = loadMigrationPlan(folder)
const databaseUrl = process.env.OPENWORK_MIGRATION_TEST_MYSQL_URL
const run = promisify(execFile)

// Explicitly opt in to disposable, loopback-only MySQL. Never use DATABASE_URL.
test("preserved-table startup on disposable MySQL", { skip: !databaseUrl, timeout: 180_000 }, async (t) => {
  assert.ok(databaseUrl)
  const baseUrl = databaseUrl
  const config = localConnectionConfig(baseUrl)
  assert.match(config.database ?? "", /^exp_/)
  const admin = await mysql.createConnection({ ...config, database: undefined, multipleStatements: true })
  let sequence = 0
  async function database(body: (executor: Executor, url: string) => Promise<void>) {
    const name = `exp_preserved_${process.pid}_${sequence++}`
    await admin.query(`CREATE DATABASE \`${name}\``)
    const connection = await mysql.createConnection({ ...config, database: name, multipleStatements: true })
    const url = new URL(baseUrl)
    url.pathname = `/${name}`
    const executor: Executor = { query: async (sql, args = []) => {
      const [rows] = await connection.query(sql, args)
      const result: unknown = rows
      return Array.isArray(result) ? result.filter(record) : []
    } }
    try { await body(executor, url.href) } finally {
      await connection.end()
      await admin.query(`DROP DATABASE \`${name}\``)
    }
  }
  async function replay(executor: Executor, count: number) {
    for (const sql of await foundationSql(plan)) await executor.query(sql)
    await executor.query(`CREATE TABLE \`${journalTable}\` (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint) ENGINE=InnoDB`)
    for (const entry of plan.slice(0, count)) {
      for (const sql of entry.sql) if (sql.trim()) await executor.query(sql)
      await executor.query(`INSERT INTO \`${journalTable}\` (hash, created_at) VALUES (?, ?)`, [entry.hash, entry.folderMillis])
    }
    if (count === plan.length) await ensureSchemaRepairs(executor)
  }
  async function receipts(executor: Executor) {
    return executor.query(`SELECT hash, created_at FROM \`${journalTable}\` ORDER BY id`)
  }
  try {
    const [server] = await admin.query<mysql.RowDataPacket[]>("SELECT VERSION() AS version, @@version_compile_os AS os, @@lower_case_table_names AS case_mode")
    assert.match(String(server[0]?.version), /^8\.4\./)
    assert.match(String(server[0]?.os), /Linux/i)
    assert.equal(Number(server[0]?.case_mode), 0)
    t.diagnostic(`witness: MySQL ${server[0]?.version}; ${server[0]?.os}; lower_case_table_names=${server[0]?.case_mode}`)

    await t.test("an empty database completes the real historical replay and a second checked startup", async () => database(async (executor) => {
      await migrateLocalDatabase(executor, plan)
      const before = await receipts(executor)
      assert.equal(historyPrefix(plan, before), plan.length)
      assert.deepEqual(await executor.query(`SELECT * FROM \`${stateTable}\``), [])
      const { shape } = await inspectSchema(executor)
      assert.ok(shape.has("table:dashboard"))
      assert.ok(shape.has("table:dashboard_access_grant"))
      await executor.query("INSERT INTO dashboard (id, organization_id, name, elements_json, created_by_org_membership_id) VALUES ('preserve', 'fixture', 'original', JSON_ARRAY(), 'fixture')")
      await executor.query("INSERT INTO dashboard_access_grant (id, organization_id, dashboard_id, role, created_by_org_membership_id) VALUES ('preserve', 'fixture', 'preserve', 'viewer', 'fixture')")
      await migrateLocalDatabase(executor, plan, true)
      assert.deepEqual(await receipts(executor), before)
      assert.equal((await executor.query("SELECT name FROM dashboard WHERE id='preserve'"))[0]?.name, "original")
      assert.equal((await executor.query("SELECT role FROM dashboard_access_grant WHERE id='preserve'"))[0]?.role, "viewer")
      t.diagnostic(`fresh replay + checked restart: ${before.length} exact receipts; both preserved rows unchanged; interruption marker empty`)
    }))

    await t.test("a recorded 0147 replay upgrades and remains checked-startup compatible", async () => database(async (executor) => {
      await replay(executor, 147)
      await migrateLocalDatabase(executor, plan)
      await migrateLocalDatabase(executor, plan, true)
      assert.equal(historyPrefix(plan, await receipts(executor)), plan.length)
    }))

    await t.test("fresh replay cannot silently switch to bootstrap if both preserved tables disappear before final verification", async () => database(async (_quarantine, quarantineUrl) => database(async (executor) => {
      const quarantine = new URL(quarantineUrl).pathname.slice(1)
      let moved = false
      await assert.rejects(migrateLocalDatabase({ query: async (sql, args) => {
        const rows = await executor.query(sql, args)
        if (sql === `UPDATE \`${stateTable}\` SET step='schema-repairs' WHERE id=1`) {
          await executor.query(`RENAME TABLE dashboard TO \`${quarantine}\`.dashboard, dashboard_access_grant TO \`${quarantine}\`.dashboard_access_grant`)
          moved = true
        }
        return rows
      } }, plan), /Replay schema differs from the final snapshot/)
      assert.equal(moved, true)
      assert.equal(historyPrefix(plan, await receipts(executor)), plan.length)
      assert.deepEqual(await executor.query(`SELECT * FROM \`${stateTable}\``), [{ id: 1, step: "schema-repairs" }])
      t.diagnostic("fresh-layout witness: both tables moved intact to disposable quarantine before final inspection; replay refused and kept its interruption marker")
    })))

    await t.test("the authentic compiled current-schema bootstrap without either table still checks", async () => database(async (executor, url) => {
      try {
        await run(process.execPath, [new URL("../dist/scripts/bootstrap.js", import.meta.url).pathname], {
          env: { ...process.env, DATABASE_URL: url, DEN_DB_ENCRYPTION_KEY: "disposable-migration-test-key-1234567890", DEN_DB_PERMISSION_RECONCILIATION: "0" },
          timeout: 90_000,
        })
      } catch { assert.fail("Compiled bootstrap failed (driver output withheld); build den-db before this test") }
      const { shape } = await inspectSchema(executor)
      assert.equal(shape.has("table:dashboard"), false)
      assert.equal(shape.has("table:dashboard_access_grant"), false)
      const before = await receipts(executor)
      await migrateLocalDatabase(executor, plan)
      await migrateLocalDatabase(executor, plan, true)
      assert.equal(historyPrefix(plan, before), plan.length)
      assert.deepEqual(await receipts(executor), before)
      t.diagnostic(`compiled bootstrap: ${before.length} exact receipts; neither preserved table; checked startup accepted`)
    }))

    await t.test("0097 still refuses a nonempty source before writes", async () => database(async (executor) => {
      await replay(executor, 96)
      await executor.query("INSERT INTO inference_providers (id, organization_id, created_by_org_membership_id, provider_id, name, provider_config, settings) VALUES ('fixture', 'fixture', 'fixture', 'fixture', 'preserve', JSON_OBJECT(), JSON_OBJECT())")
      const before = await receipts(executor)
      const statements: string[] = []
      await assert.rejects(migrateLocalDatabase({ query: async (sql, args) => {
        statements.push(sql)
        return executor.query(sql, args)
      } }, plan), /Preflight rejected nonempty inference_providers/)
      assert.equal(statements.some((sql) => /^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|RENAME)\b/i.test(sql)), false)
      assert.deepEqual(await receipts(executor), before)
      assert.equal((await executor.query("SELECT name FROM inference_providers WHERE id='fixture'"))[0]?.name, "preserve")
    }))

    await database(async (executor) => {
      await replay(executor, plan.length)
      const before = await receipts(executor)
      const malformed = [
        { name: "column type", change: "ALTER TABLE dashboard MODIFY name varchar(254) NOT NULL", restore: "ALTER TABLE dashboard MODIFY name varchar(255) NOT NULL" },
        { name: "column nullability", change: "ALTER TABLE dashboard MODIFY name varchar(255) NULL", restore: "ALTER TABLE dashboard MODIFY name varchar(255) NOT NULL" },
        { name: "column default", change: "ALTER TABLE dashboard_access_grant ALTER org_wide SET DEFAULT 1", restore: "ALTER TABLE dashboard_access_grant ALTER org_wide SET DEFAULT 0" },
        { name: "missing column", change: "ALTER TABLE dashboard RENAME COLUMN name TO exp_name", restore: "ALTER TABLE dashboard RENAME COLUMN exp_name TO name" },
        { name: "extra column", change: "ALTER TABLE dashboard ADD exp_extra int", restore: "ALTER TABLE dashboard DROP COLUMN exp_extra" },
        { name: "missing index", change: "ALTER TABLE dashboard RENAME INDEX dashboard_name TO exp_index", restore: "ALTER TABLE dashboard RENAME INDEX exp_index TO dashboard_name" },
        { name: "wrong index uniqueness", change: "ALTER TABLE dashboard DROP INDEX dashboard_name, ADD UNIQUE INDEX dashboard_name (name)", restore: "ALTER TABLE dashboard DROP INDEX dashboard_name, ADD INDEX dashboard_name (name)" },
        { name: "wrong table engine", change: "ALTER TABLE dashboard_access_grant ENGINE=MyISAM", restore: "ALTER TABLE dashboard_access_grant ENGINE=InnoDB" },
        { name: "only dashboard present", change: "RENAME TABLE dashboard_access_grant TO exp_grant", restore: "RENAME TABLE exp_grant TO dashboard_access_grant" },
        { name: "only access grant present", change: "RENAME TABLE dashboard TO exp_dashboard", restore: "RENAME TABLE exp_dashboard TO dashboard" },
        { name: "unknown extra table", change: "CREATE TABLE exp_unknown (id int)", restore: "DROP TABLE exp_unknown" },
        { name: "foreign key", change: "ALTER TABLE dashboard_access_grant ADD CONSTRAINT exp_fk FOREIGN KEY (dashboard_id) REFERENCES dashboard(id)", restore: "ALTER TABLE dashboard_access_grant DROP FOREIGN KEY exp_fk" },
        { name: "trigger", change: "CREATE TRIGGER exp_trigger BEFORE INSERT ON dashboard FOR EACH ROW SET NEW.name=NEW.name", restore: "DROP TRIGGER exp_trigger" },
      ]
      for (const fixture of malformed) await t.test(`checked startup rejects ${fixture.name} without writes`, async () => {
        await executor.query(fixture.change)
        try {
          const statements: string[] = []
          await assert.rejects(migrateLocalDatabase({ query: async (sql, args) => {
            statements.push(sql)
            return executor.query(sql, args)
          } }, plan, true), /Schema differs|Unexpected foreign key|Unexpected database triggers/)
          assert.equal(statements.some((sql) => /^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|RENAME)\b/i.test(sql)), false)
          assert.deepEqual(await receipts(executor), before)
        } finally { await executor.query(fixture.restore) }
      })
      await t.test("receipt hashes and timestamps still fail closed", async () => {
        await executor.query(`UPDATE \`${journalTable}\` SET hash=? WHERE id=1`, ["0".repeat(64)])
        await assert.rejects(migrateLocalDatabase(executor, plan, true), /exact hash\/timestamp prefix/)
        await executor.query(`UPDATE \`${journalTable}\` SET hash=? WHERE id=1`, [plan[0].hash])
        await executor.query(`UPDATE \`${journalTable}\` SET created_at=created_at+1 WHERE id=1`)
        await assert.rejects(migrateLocalDatabase(executor, plan, true), /exact hash\/timestamp prefix/)
        await executor.query(`UPDATE \`${journalTable}\` SET created_at=? WHERE id=1`, [plan[0].folderMillis])
        assert.deepEqual(await receipts(executor), before)
      })
      await t.test("an interruption marker still blocks a complete historical layout", async () => {
        await executor.query(`CREATE TABLE \`${stateTable}\` (id int PRIMARY KEY, step varchar(255) NOT NULL) ENGINE=InnoDB`)
        await executor.query(`INSERT INTO \`${stateTable}\` VALUES (1, 'fixture-interrupted')`)
        await assert.rejects(migrateLocalDatabase(executor, plan, true), /prior local migration\/repair was interrupted/)
        assert.deepEqual(await executor.query(`SELECT * FROM \`${stateTable}\``), [{ id: 1, step: "fixture-interrupted" }])
      })
    })
  } finally { await admin.end() }
})
