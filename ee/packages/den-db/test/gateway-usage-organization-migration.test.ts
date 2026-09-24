import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"
import { localConnectionConfig, migrateLocalDatabase } from "../scripts/dev-migrate"
import { loadMigrationPlan, record } from "../scripts/migration-baseline"

const url = process.env.DEN_USAGE_ORGANIZATION_MIGRATION_DATABASE_URL
if (url && !/^\/usage_limits_test_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Use a fresh owned usage_limits_test_ database for the organization migration test.")

test("0108 preserves prior member/team assignments and enforces organization target constraints", {
  skip: !url ? "needs: fresh isolated loopback DEN_USAGE_ORGANIZATION_MIGRATION_DATABASE_URL" : false,
  timeout: 120_000,
}, async () => {
  assert.ok(url)
  const connection = await mysql.createConnection({
    ...localConnectionConfig(url),
    multipleStatements: true,
  })
  try {
    const [tables] = await connection.query("SHOW TABLES")
    assert.deepEqual(tables, [], "Migration verification requires a fresh empty database")
    const plan = loadMigrationPlan(fileURLToPath(new URL("../drizzle", import.meta.url)))
    const index = plan.findIndex((entry) => entry.tag === "0108_gateway_usage_organization_assignments")
    assert.ok(index > 0)
    const executor = {
      async query(query: string, args: unknown[] = []) {
        const [rows] = await connection.query(query, args)
        const result: unknown = rows
        return Array.isArray(result) ? result.filter(record) : []
      },
    }
    await migrateLocalDatabase(executor, plan.slice(0, index))
    await connection.query(
      "INSERT INTO gateway_usage_limit_assignment (id, policy_id, organization_id, member_id, team_id, created_at) VALUES ('legacy-member', 'policy-a', 'org-a', 'member-a', NULL, '2026-09-18 05:00:00'), ('legacy-team', 'policy-a', 'org-a', NULL, 'team-a', '2026-09-18 05:00:01')",
    )
    const previous = await executor.query("SELECT * FROM gateway_usage_limit_assignment ORDER BY id")
    await migrateLocalDatabase(executor, plan.slice(0, index + 1))
    const migrated = await executor.query("SELECT * FROM gateway_usage_limit_assignment ORDER BY id")
    assert.deepEqual(migrated, previous.map((row) => ({ ...row, organization: null })))
    async function insert(id: string, organizationId: string, policyId: string, target: number | null, memberId: string | null, teamId: string | null) {
      await connection.query(
        "INSERT INTO gateway_usage_limit_assignment (id, organization_id, policy_id, organization, member_id, team_id, created_at) VALUES (?, ?, ?, ?, ?, ?, '2026-09-18 05:00:02')",
        [id, organizationId, policyId, target, memberId, teamId],
      )
    }
    await insert("organization-a", "org-a", "policy-a", 1, null, null)
    await assert.rejects(insert("duplicate", "org-a", "policy-a", 1, null, null), { code: "ER_DUP_ENTRY" })
    await insert("organization-b", "org-b", "policy-a", 1, null, null)
    await insert("organization-policy-b", "org-a", "policy-b", 1, null, null)
    await insert("member-b", "org-a", "policy-a", null, "member-b", null)
    await insert("team-b", "org-a", "policy-a", null, null, "team-b")
    await assert.rejects(insert("duplicate-member", "org-a", "policy-a", null, "member-a", null), { code: "ER_DUP_ENTRY" })
    await assert.rejects(insert("duplicate-team", "org-a", "policy-a", null, null, "team-a"), { code: "ER_DUP_ENTRY" })
    const invalid: [number | null, string | null, string | null][] = [
      [null, null, null],
      [0, null, null],
      [2, null, null],
      [1, "mixed-member", null],
      [1, null, "mixed-team"],
      [null, "mixed-member", "mixed-team"],
      [0, "mixed-member", null],
    ]
    for (const [position, target] of invalid.entries())
      await assert.rejects(insert(`invalid-${position}`, "org-a", "policy-a", ...target), { code: "ER_CHECK_CONSTRAINT_VIOLATED" })
    const preserved = await executor.query("SELECT * FROM gateway_usage_limit_assignment ORDER BY id")
    assert.equal(preserved.length, 7)
    await migrateLocalDatabase(executor, plan.slice(0, index + 1))
    assert.deepEqual(await executor.query("SELECT * FROM gateway_usage_limit_assignment ORDER BY id"), preserved)
  } finally {
    await connection.end()
  }
})
