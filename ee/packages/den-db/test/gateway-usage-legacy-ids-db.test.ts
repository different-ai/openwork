import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import {
  createDenTypeId,
  denTypeIdFromLegacyUuid,
  isLegacyUuid,
} from "@openwork-ee/utils/typeid"
import type { GatewayUsagePolicyWrite } from "@openwork/types/den/gateway-usage-limits"
import {
  convertGatewayUsageLegacyIds,
  createGatewayUsageLimits,
  startGatewayUsageLog,
  type GatewayUsageDb,
  type GatewayUsageScope,
} from "../src/gateway-usage-limits"
import { migrateLocalDatabase, localConnectionConfig } from "../scripts/dev-migrate"
import { loadMigrationPlan, record } from "../scripts/migration-baseline"
import { AuthUserTable, MemberTable, OrganizationTable, GatewayRequestLogTable as Log } from "../src/schema"
import { legacyUuidOf } from "./legacy-uuid-fixture"

const url = process.env.DEN_USAGE_TEST_DATABASE_URL
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !/^\/usage_limits_test(?:_[a-z0-9_]+)?$/.test(new URL(url).pathname))
)
  throw new Error("Use the owned disposable loopback usage_limits_test database only.")
const plan = loadMigrationPlan(fileURLToPath(new URL("../drizzle", import.meta.url)))
const pool = url ? mysql.createPool({ ...localConnectionConfig(url), connectionLimit: 12 }) : null
const db: GatewayUsageDb | null = pool
  ? (drizzle(pool, { mode: "default" }) as unknown as GatewayUsageDb)
  : null
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn)

before(async () => {
  if (!url) return
  const connection = await mysql.createConnection({ ...localConnectionConfig(url), multipleStatements: true })
  try {
    await migrateLocalDatabase(
      {
        query: async (query, args = []) => {
          const [rows] = await connection.query(query, args)
          const result: unknown = rows
          return Array.isArray(result) ? result.filter(record) : []
        },
      },
      plan,
    )
  } finally {
    await connection.end()
  }
})
after(async () => {
  await pool?.end()
})

type Row = Record<string, unknown>
async function query(sql: string, args: unknown[] = []): Promise<Row[]> {
  assert.ok(pool)
  const [rows] = await pool.query(sql, args)
  const result: unknown = rows
  return Array.isArray(result) ? result.filter(record) : []
}
const strings = (rows: Row[], column: string) => rows.map((row) => String(row[column]))

// Every column that held a legacy UUID before the TypeID cutover.
const LEGACY_COLUMNS: [table: string, column: string][] = [
  ["gateway_usage_limit_policy", "id"],
  ["gateway_usage_limit_entry", "policy_id"],
  ["gateway_usage_limit_assignment", "id"],
  ["gateway_usage_limit_assignment", "policy_id"],
  ["gateway_usage_bucket", "policy_id"],
  ["gateway_usage_bucket_charge", "policy_id"],
  ["gateway_usage_reset_request", "id"],
  ["gateway_usage_reset_request", "policy_id"],
  ["gateway_usage_audit", "id"],
  ["gateway_usage_audit", "subject_id"],
]

async function organizationIds(organizationId: string) {
  const ids = async (table: string) =>
    strings(await query(`select id from ${table} where organization_id = ?`, [organizationId]), "id")
  return {
    policies: await ids("gateway_usage_limit_policy"),
    assignments: await ids("gateway_usage_limit_assignment"),
    resets: await ids("gateway_usage_reset_request"),
    audits: await ids("gateway_usage_audit"),
    buckets: await ids("gateway_usage_bucket"),
  }
}

/** Rewrites stored TypeIDs back to the UUIDs rows held before the cutover, everywhere they appear. */
async function makeLegacy(values: string[]) {
  for (const value of values)
    for (const [table, column] of LEGACY_COLUMNS)
      await query(`update ${table} set ${column} = ? where ${column} = ?`, [legacyUuidOf(value), value])
}

/** Every stored row of the organization in the converted tables, for exact before/after comparison. */
async function storedRows(organizationId: string, policyIds: string[], bucketIds: string[]) {
  const byOrganization = (table: string) =>
    query(`select * from ${table} where organization_id = ? order by id`, [organizationId])
  return {
    policies: await byOrganization("gateway_usage_limit_policy"),
    limits: policyIds.length
      ? await query(
          "select * from gateway_usage_limit_entry where policy_id in (?) order by policy_id, timeframe",
          [policyIds],
        )
      : [],
    assignments: await byOrganization("gateway_usage_limit_assignment"),
    buckets: await byOrganization("gateway_usage_bucket"),
    charges: bucketIds.length
      ? await query(
          "select * from gateway_usage_bucket_charge where bucket_id in (?) order by event_id, bucket_id",
          [bucketIds],
        )
      : [],
    resets: await byOrganization("gateway_usage_reset_request"),
    audits: await byOrganization("gateway_usage_audit"),
  }
}

async function noLegacyValues() {
  for (const [table, column] of LEGACY_COLUMNS) {
    const rows = await query(`select ${column} as value from ${table}`)
    const legacy = strings(rows, "value").filter(isLegacyUuid)
    assert.deepEqual(legacy, [], `${table}.${column} still holds legacy UUIDs`)
  }
}

const policyBody = (name: string): GatewayUsagePolicyWrite => ({
  name,
  hardLimit: true,
  allowRequestReset: true,
  limits: [
    { timeframe: "day", costUsd: "1" },
    { timeframe: "month", costUsd: "5" },
  ],
})

async function fixture() {
  assert.ok(db)
  const database = db
  const now = new Date("2026-09-15T12:00:00Z")
  const service = createGatewayUsageLimits(database, () => now)
  const organizationId = createDenTypeId("organization")
  await database
    .insert(OrganizationTable)
    .values({ id: organizationId, name: "Legacy ID fixture", slug: randomUUID() })
  async function addMember(role: string): Promise<GatewayUsageScope> {
    const userId = createDenTypeId("user")
    const memberId = createDenTypeId("member")
    await database.insert(AuthUserTable).values({ id: userId, name: "Fixture", email: `${userId}@example.test` })
    await database.insert(MemberTable).values({ id: memberId, userId, organizationId, role })
    return { organizationId, memberId }
  }
  const admin = await addMember("owner")
  const member = await addMember("member")
  async function spend(costMicroUsd: number) {
    const row: typeof Log.$inferInsert = {
      id: createDenTypeId("inferenceRequestLog"),
      organization_id: organizationId,
      org_membership_id: member.memberId,
      openwork_request_id: randomUUID().replaceAll("-", ""),
      route: "org_provider",
      protocol: "openai_chat",
      upstream_provider_id: "openai",
      upstream_host: "example.test",
      upstream_path: "/chat/completions",
      method: "POST",
      stream: false,
      started_at: now,
      completed_at: now,
      outcome: "ok",
      usage_source: "json",
      cost_micro_usd: costMicroUsd,
      metadata: { cost_source: "upstream", cost_complete: true },
    }
    const admission = await service.admit(member, row.openwork_request_id, true, row.started_at)
    row.metadata = { ...row.metadata, gateway_usage: admission.snapshot }
    await database.transaction((tx) =>
      startGatewayUsageLog(tx, { ...row, completed_at: null, cost_micro_usd: null }, now),
    )
    await service.record(row)
  }
  /** A policy assigned to the member, spend past its daily limit, and a pending increase request. */
  async function populate() {
    const policy = await service.savePolicy(admin, policyBody(`Policy ${randomUUID()}`))
    await service.assign(admin, policy.id, { memberId: member.memberId })
    await spend(2_000_000)
    const day = (await service.getStatus(member)).buckets.find((bucket) => bucket.timeframe === "day")
    assert.ok(day?.canRequestReset)
    const reset = await service.submitReset(member, day.id, "Need more for a release")
    return { policy, reset }
  }
  return { database, service, organizationId, admin, member, spend, populate }
}

dbTest("legacy rows keep enforcing limits and convert back to the identical TypeID rows", async () => {
  assert.ok(db)
  const f = await fixture()
  const { policy, reset } = await f.populate()
  const ids = await organizationIds(f.organizationId)
  const before = await storedRows(f.organizationId, ids.policies, ids.buckets)
  assert.ok(before.charges.length > 0)

  await makeLegacy([...ids.policies, ...ids.assignments, ...ids.resets, ...ids.audits])
  const [stored] = await query("select id from gateway_usage_limit_policy where organization_id = ?", [
    f.organizationId,
  ])
  assert.ok(stored && isLegacyUuid(String(stored.id)))

  // Unconverted rows: admission and status still enforce through SQL joins, and the
  // app sees the TypeIDs it would after conversion.
  const status = await f.service.getStatus(f.member)
  const day = status.buckets.find((bucket) => bucket.timeframe === "day")
  assert.equal(status.state, "blocked")
  assert.equal(day?.policyId, policy.id)
  assert.equal(day?.allowanceMicroUsd, 1_000_000)
  assert.equal((await f.service.admit(f.member, randomUUID(), true)).admitted, false)
  const pending = await f.service.listResets(f.admin, false)
  assert.deepEqual(pending.requests.map((request) => request.id), [reset.id])

  const result = await convertGatewayUsageLegacyIds(db)
  assert.equal(result.remaining, false)
  assert.ok(result.converted > 0)
  assert.deepEqual(await storedRows(f.organizationId, ids.policies, ids.buckets), before)
  await noLegacyValues()

  assert.deepEqual(await convertGatewayUsageLegacyIds(db), { converted: 0, remaining: false })
  const listed = (await f.service.listPolicies(f.admin)).policies.find((row) => row.id === policy.id)
  assert.equal(listed?.limits.length, 2)
  assert.equal(listed?.assignments.length, 1)
  assert.equal((await f.service.reviewReset(f.admin, reset.id, "approved")).status, "approved")
})

dbTest("concurrent converters agree and leave no legacy values", async () => {
  assert.ok(db)
  const database = db
  const f = await fixture()
  for (let i = 0; i < 12; i++) {
    const policy = await f.service.savePolicy(f.admin, policyBody(`Bulk ${i}`))
    await f.service.assign(f.admin, policy.id, { memberId: f.member.memberId })
  }
  await f.populate()
  const ids = await organizationIds(f.organizationId)
  const before = await storedRows(f.organizationId, ids.policies, ids.buckets)
  await makeLegacy([...ids.policies, ...ids.assignments, ...ids.resets, ...ids.audits])

  const results = await Promise.all(
    Array.from({ length: 4 }, () => convertGatewayUsageLegacyIds(database)),
  )
  for (const result of results) assert.equal(result.remaining, false)
  assert.deepEqual(await storedRows(f.organizationId, ids.policies, ids.buckets), before)
  await noLegacyValues()
})

dbTest("rows written by the previous release during a rollout are converted by a later run", async () => {
  assert.ok(db)
  const f = await fixture()
  const { policy } = await f.populate()
  assert.equal((await convertGatewayUsageLegacyIds(db)).remaining, false)

  // The previous release creates a policy, its limits and an assignment with UUIDs,
  // and settles a request admitted before conversion with the old policy reference.
  const policyUuid = randomUUID()
  const assignmentUuid = randomUUID()
  const now = new Date("2026-09-15T12:00:00Z")
  await query(
    "insert into gateway_usage_limit_policy (id, organization_id, name, hard_limit, allow_request_reset, revision, created_at, updated_at, member_id) values (?, ?, 'Old release', 1, 1, 1, ?, ?, ?)",
    [policyUuid, f.organizationId, now, now, f.admin.memberId],
  )
  await query(
    "insert into gateway_usage_limit_entry (policy_id, timeframe, cost_limit_micro_usd) values (?, 'week', 3000000)",
    [policyUuid],
  )
  await query(
    "insert into gateway_usage_limit_assignment (id, policy_id, organization_id, member_id, created_at) values (?, ?, ?, ?, ?)",
    [assignmentUuid, policyUuid, f.organizationId, f.member.memberId, now],
  )
  const [bucket] = await query("select id from gateway_usage_bucket where organization_id = ? limit 1", [
    f.organizationId,
  ])
  assert.ok(bucket)
  const policyIdUuid = legacyUuidOf(policy.id)
  await query(
    "insert into gateway_usage_bucket_charge (event_id, bucket_id, amount, unpriced_requests, incomplete_requests, policy_id, policy_revision) values (?, ?, 0, 0, 0, ?, 1)",
    [randomUUID().replaceAll("-", ""), bucket.id, policyIdUuid],
  )

  // Enforced before conversion: the old-release week limit applies through joins.
  const week = (await f.service.getStatus(f.member)).buckets.find((row) => row.timeframe === "week")
  assert.equal(week?.policyId, denTypeIdFromLegacyUuid("gatewayUsagePolicy", policyUuid))

  const result = await convertGatewayUsageLegacyIds(db)
  assert.equal(result.remaining, false)
  assert.ok(result.converted >= 3)
  await noLegacyValues()
  const converted = denTypeIdFromLegacyUuid("gatewayUsagePolicy", policyUuid)
  assert.deepEqual(
    strings(await query("select policy_id from gateway_usage_limit_entry where policy_id = ?", [converted]), "policy_id"),
    [converted],
  )
  assert.deepEqual(
    strings(await query("select id from gateway_usage_limit_assignment where policy_id = ?", [converted]), "id"),
    [denTypeIdFromLegacyUuid("gatewayUsageAssignment", assignmentUuid)],
  )
})

dbTest("a policy locked by another transaction is skipped, reported, and converted later", async () => {
  assert.ok(db && pool)
  const f = await fixture()
  const first = await f.populate()
  const second = await f.service.savePolicy(f.admin, policyBody("Second"))
  await f.service.assign(f.admin, second.id, { memberId: f.member.memberId })
  const ids = await organizationIds(f.organizationId)
  await makeLegacy([...ids.policies, ...ids.assignments, ...ids.resets, ...ids.audits])

  const holder = await pool.getConnection()
  try {
    await holder.query("start transaction")
    await holder.query("select id from gateway_usage_limit_policy where id = ? for update", [
      legacyUuidOf(first.policy.id),
    ])
    const result = await convertGatewayUsageLegacyIds(db)
    assert.equal(result.remaining, true)
    // The locked group stays consistent: policy, limits and assignment all still legacy.
    const legacyId = legacyUuidOf(first.policy.id)
    assert.equal((await query("select 1 from gateway_usage_limit_policy where id = ?", [legacyId])).length, 1)
    assert.equal((await query("select 1 from gateway_usage_limit_entry where policy_id = ?", [legacyId])).length, 2)
    assert.equal((await query("select 1 from gateway_usage_limit_assignment where policy_id = ?", [legacyId])).length, 1)
    // The unlocked policy was converted with its references.
    assert.equal((await query("select 1 from gateway_usage_limit_policy where id = ?", [second.id])).length, 1)
    assert.equal((await query("select 1 from gateway_usage_limit_entry where policy_id = ?", [second.id])).length, 2)
    await holder.query("commit")
  } finally {
    holder.release()
  }
  assert.equal((await convertGatewayUsageLegacyIds(db)).remaining, false)
  await noLegacyValues()
})
