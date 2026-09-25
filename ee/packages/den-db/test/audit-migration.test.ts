import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { generateMySQLDrizzleJson, generateMySQLMigration } from "drizzle-kit/api"
import { getTableConfig } from "drizzle-orm/mysql-core"
import { AuditEventTable, AuditEventResourceTable, AuditOperationTable, AuditOperationStepTable, AuditPolicyTable, AuditStateTable, AuditUsageFactTable } from "../src/schema"
import * as schema from "../src/schema"
import { loadMigrationPlan } from "../scripts/migration-baseline"
import { fileURLToPath } from "node:url"

const tables = [AuditEventTable, AuditEventResourceTable, AuditOperationTable, AuditOperationStepTable, AuditPolicyTable, AuditStateTable, AuditUsageFactTable]

test("audit schemas preserve legacy columns, nullable additions and references without cascades", () => {
  for (const table of tables) assert.equal(getTableConfig(table).foreignKeys.length, 0)
  assert.equal(AuditEventTable.actor_user_id.notNull, false)
  assert.equal(AuditEventTable.operation_id.notNull, false)
  assert.equal(AuditEventTable.sequence.notNull, false)
  assert.equal(AuditEventTable.envelope.notNull, false)
  assert.equal(AuditEventTable.payload.name, "payload")
  assert.equal(AuditPolicyTable.enabled.default, false)
  assert.equal(AuditOperationTable.outcome.default, "unknown")
  assert.equal(AuditOperationTable.retention_state.default, "retained")
})

test("binding, operation idempotency, sequence and usage transitions have database-enforced uniqueness", () => {
  const indexes = tables.flatMap((table) => getTableConfig(table).indexes)
  for (const name of ["audit_operation_binding", "audit_event_idempotency", "audit_event_org_sequence", "audit_usage_operation_transition"]) {
    const found = indexes.find((index) => index.config.name === name)
    assert.ok(found)
    assert.equal(found.config.unique, true)
  }
  assert.deepEqual(getTableConfig(AuditEventTable).indexes.find((index) => index.config.name === "audit_event_idempotency")?.config.columns.map((column) => "name" in column ? column.name : null), ["org_id", "operation_id", "idempotency_key"])
})

test("generated audit migration is additive and does not backfill, delete, enable capture or settle billing", async () => {
  const sql = await readFile(new URL("../drizzle/0111_audit_operation_capture.sql", import.meta.url), "utf8")
  assert.match(sql, /CREATE TABLE `audit_operation`/)
  assert.match(sql, /ALTER TABLE `audit_event` MODIFY COLUMN `actor_user_id` varchar\(64\)/)
  assert.match(sql, /`enabled` boolean NOT NULL DEFAULT false/)
  assert.doesNotMatch(sql, /\b(?:DELETE|DROP|TRUNCATE|INSERT|UPDATE|FOREIGN KEY|CASCADE)\b(?! CURRENT_TIMESTAMP)/i)
  for (const match of sql.matchAll(/(?:CREATE TABLE|ALTER TABLE| ON) `([^`]+)`/g)) assert.match(match[1], /^audit_/)
})

test("workflow step claims have a tenant-local composite primary key and additive migration", async () => {
  const config = getTableConfig(AuditOperationStepTable)
  assert.deepEqual(config.primaryKeys[0].columns.map((column) => column.name), ["organization_id", "operation_id", "step_hash"])
  const sql = await readFile(new URL("../drizzle/0112_audit_operation_steps.sql", import.meta.url), "utf8")
  assert.match(sql, /CREATE TABLE `audit_operation_step`/)
  assert.match(sql, /`request_id` varchar\(128\) NOT NULL/)
  assert.doesNotMatch(sql, /\b(?:ALTER|DELETE|DROP|TRUNCATE|INSERT|UPDATE|FOREIGN KEY|CASCADE)\b/i)
})

test("committed snapshot and journal reproduce the actual Drizzle schema without a new migration", async () => {
  const plan = loadMigrationPlan(fileURLToPath(new URL("../drizzle", import.meta.url)))
  const saved = plan.at(-1)?.snapshot
  assert.ok(saved)
  const generated = await generateMySQLDrizzleJson(schema, saved.prevId)
  const normalized = JSON.parse(JSON.stringify(generated))
  assert.deepEqual(normalized.tables, saved.tables)
  assert.deepEqual(await generateMySQLMigration(saved, normalized), [])
  const audit = plan.find((entry) => entry.tag === "0111_audit_operation_capture")
  assert.ok(audit)
  assert.ok(audit.folderMillis > plan[plan.indexOf(audit) - 1].folderMillis)
})
