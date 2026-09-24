import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { generateMySQLDrizzleJson, generateMySQLMigration } from "drizzle-kit/api"
import { loadMigrationPlan, snapshotShape } from "../scripts/migration-baseline"
import * as schema from "../src/schema"

const plan = loadMigrationPlan(fileURLToPath(new URL("../drizzle", import.meta.url)))
test("usage migration snapshot is the real Drizzle serialization with no outstanding schema diff", async () => {
  const saved = plan.at(-1)?.snapshot
  assert.ok(saved)
  const generated = await generateMySQLDrizzleJson(schema, saved.prevId)
  const tables: unknown = JSON.parse(JSON.stringify(generated.tables))
  assert.deepEqual(tables, saved.tables)
  assert.deepEqual(await generateMySQLMigration(saved, generated), [])
})
test("MySQL usage CHECK serialization normalizes without accepting weakened checks", () => {
  const saved = plan.at(-1)?.snapshot
  assert.ok(saved)
  const mysql = structuredClone(saved)
  const checks = [
    ["gateway_usage_tracking", "gateway_usage_tracking_pending_safe", "(`pending_requests` between 0 and 9007199254740991)"],
    ["gateway_usage_limit_entry", "gateway_usage_allowance_safe", "((`cost_limit_micro_usd` >= 0) and (`cost_limit_micro_usd` <= 7205759403792792))"],
    ["gateway_usage_limit_assignment", "gateway_usage_assignment_target", "(((`organization` is null) and ((`member_id` is null) <> (`team_id` is null))) or ((`organization` is not null) and (`organization` = 1) and (`member_id` is null) and (`team_id` is null)))"],
    ["gateway_usage_bucket", "gateway_usage_bucket_money_safe", "((`used_micro_usd` between 0 and 9007199254740991) and ((`base_allowance_micro_usd` + `extension_micro_usd`) between 0 and 9007199254740991))"],
    ["gateway_usage_consumption_event", "gateway_usage_event_money_safe", "((`cost_micro_usd` is null) or (`cost_micro_usd` between 0 and 9007199254740991))"],
  ]
  for (const [table, name, value] of checks) mysql.tables[table].checkConstraint[name].value = value
  assert.deepEqual(snapshotShape(mysql), snapshotShape(saved))
  for (const value of [
    "organization is null or organization = 1",
    "(organization is null and (member_id is null)) <> ((team_id is null) or organization = 1)",
    "(organization is null and ((member_id is null) <> (team_id is null))) or (organization = 1 and member_id is null and team_id is null)",
  ]) {
    const weakened = structuredClone(saved)
    weakened.tables.gateway_usage_limit_assignment.checkConstraint.gateway_usage_assignment_target.value = value
    assert.notDeepEqual(snapshotShape(weakened), snapshotShape(saved))
  }
  mysql.tables.gateway_usage_limit_entry.checkConstraint.gateway_usage_allowance_safe.value = "cost_limit_micro_usd >= 0 or cost_limit_micro_usd <= 7205759403792792"
  assert.notDeepEqual(snapshotShape(mysql), snapshotShape(saved))
})
