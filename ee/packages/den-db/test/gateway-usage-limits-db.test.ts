import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { createServer, connect, type Socket } from "node:net"
import { fileURLToPath } from "node:url"
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { and, eq, inArray, sql } from "drizzle-orm"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  createGatewayUsageLimits,
  reconcileGatewayUsageBatch,
  recoverGatewayUsageRequests,
  listPendingGatewayUsageRequests,
  rotateGatewayUsageEpoch,
  startGatewayUsageLog,
  deleteGatewayUsageForOrganization,
  GatewayUsageError,
  type GatewayUsageDb,
  type GatewayUsageScope,
} from "../src/gateway-usage-limits"
import { projectedBucket } from "../src/gateway-usage-read"
import {
  createUsageWriteQueue,
  UsageWriteAdmissionError,
} from "../../../apps/gateway/src/usage-write-queue"
import { withGatewayUsageEntitlementMutation } from "../src/gateway-usage-entitlements"
import { isGatewayUsageDeadlock } from "../src/gateway-usage-errors"
import { migrateLocalDatabase, localConnectionConfig } from "../scripts/dev-migrate"
import { loadMigrationPlan, record } from "../scripts/migration-baseline"
import {
  AuthUserTable,
  MemberTable,
  OrganizationTable,
  TeamTable,
  TeamMemberTable,
  GatewayRequestLogTable as Log,
  GatewayUsageAssignmentTable as A,
  GatewayUsageBucketTable as B,
  GatewayUsageEventTable as E,
  GatewayUsageChargeTable as C,
  GatewayUsageSubjectTable as S,
  GatewayUsageResetTable as R,
  GatewayUsageQuarantineTable as Q,
  GatewayUsageTrackingTable as T,
  GatewayRollupLockTable,
} from "../src/schema"
import {
  gatewayUsageStatusSchema,
  type GatewayUsagePolicyWrite,
} from "@openwork/types/den/gateway-usage-limits"

const url = process.env.DEN_USAGE_TEST_DATABASE_URL
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !/^\/usage_limits_test(?:_[a-z0-9_]+)?$/.test(new URL(url).pathname))
)
  throw new Error("Use the owned disposable loopback usage_limits_test database only.")
const plan = loadMigrationPlan(fileURLToPath(new URL("../drizzle", import.meta.url)))
const witness = new AsyncLocalStorage<string[]>()
const pool = url ? mysql.createPool({ ...localConnectionConfig(url), connectionLimit: 10 }) : null
function database(client: mysql.Pool): GatewayUsageDb {
  return drizzle(client, {
    mode: "default",
    logger: {
      logQuery(query) {
        witness.getStore()?.push(query)
      },
    },
  }) as unknown as GatewayUsageDb
}
const db = pool ? database(pool) : null
async function migration(connection: mysql.Connection, through = plan.length) {
  await migrateLocalDatabase(
    {
      query: async (query, args = []) => {
        const [rows] = await connection.query(query, args)
        const result: unknown = rows
        return Array.isArray(result) ? result.filter(record) : []
      },
    },
    plan.slice(0, through),
  )
}
before(async () => {
  if (!url) return
  const connection = await mysql.createConnection({
    ...localConnectionConfig(url),
    multipleStatements: true,
  })
  try {
    await migration(connection)
  } finally {
    await connection.end()
  }
})
after(async () => {
  await pool?.end()
})
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn)

async function fixture() {
  assert.ok(db)
  const database = db
  let now = new Date("2026-09-15T12:00:00Z")
  const service = createGatewayUsageLimits(database, () => now)
  const organizationId = createDenTypeId("organization")
  await database
    .insert(OrganizationTable)
    .values({ id: organizationId, name: "Incremental fixture", slug: randomUUID() })
  async function addMember(role = "member"): Promise<GatewayUsageScope> {
    const userId = createDenTypeId("user"),
      memberId = createDenTypeId("member")
    await database
      .insert(AuthUserTable)
      .values({ id: userId, name: "Fixture", email: `${userId}@example.test` })
    await database.insert(MemberTable).values({ id: memberId, userId, organizationId, role })
    return { organizationId, memberId }
  }
  const admin = await addMember("owner"),
    member = await addMember()
  const body: GatewayUsagePolicyWrite = {
    name: "Standard",
    hardLimit: true,
    allowRequestReset: true,
    limits: [
      { timeframe: "day", costUsd: "1" },
      { timeframe: "week", costUsd: "2" },
      { timeframe: "month", costUsd: "3" },
    ],
  }
  async function assigned(input = body, target = member) {
    const policy = await service.savePolicy(admin, input)
    await service.assign(admin, policy.id, { memberId: target.memberId })
    return policy
  }
  function raw(cost: number | null, target = member): typeof Log.$inferInsert {
    return {
      id: createDenTypeId("inferenceRequestLog"),
      organization_id: organizationId,
      org_membership_id: target.memberId,
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
      cost_micro_usd: cost,
      metadata: {
        cost_source: cost === null ? "unknown" : "upstream",
        cost_complete: cost !== null,
      },
    }
  }
  async function prepare(
    cost: number | null,
    target = member,
    scheduled?: { db: GatewayUsageDb; queue: ReturnType<typeof createUsageWriteQueue> },
  ) {
    const row = raw(cost, target)
    const admission = await service.admit(target, row.openwork_request_id, true, row.started_at)
    row.metadata = { ...row.metadata, gateway_usage: admission.snapshot }
    const write = () =>
      (scheduled?.db ?? database).transaction((tx) =>
        startGatewayUsageLog(tx, { ...row, completed_at: null, cost_micro_usd: null }, now),
      )
    if (scheduled) await scheduled.queue.start(target.memberId, row.openwork_request_id, write)
    else await write()
    return row
  }
  async function spend(cost: number | null, target = member) {
    const row = await prepare(cost, target)
    await service.record(row)
    return row
  }
  return {
    db: database,
    service,
    admin,
    member,
    body,
    assigned,
    addMember,
    raw,
    prepare,
    spend,
    setTime(value: string) {
      now = new Date(value)
    },
  }
}
async function observed<T>(run: () => Promise<T>) {
  const queries: string[] = []
  const start = performance.now()
  const result = await witness.run(queries, run)
  return { result, queries, ms: performance.now() - start }
}
function assertReadOnly(queries: string[]) {
  assert.ok(queries.length > 0)
  for (const query of queries) {
    assert.match(query, /^(select|begin|commit)/i)
    assert.doesNotMatch(
      query,
      /for (update|share)|gateway_request_logs|gateway_usage_rollups|gateway_usage_consumption_event|gateway_usage_bucket_charge|gateway_usage_subject|sum\(/i,
    )
  }
}
async function whileLocked(
  lock: (tx: Parameters<Parameters<GatewayUsageDb["transaction"]>[0]>[0]) => Promise<unknown>,
  run: () => Promise<unknown>,
  timeoutMs = 2000,
) {
  assert.ok(db)
  let ready = () => {},
    release = () => {}
  const locked = new Promise<void>((resolve) => {
    ready = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const holder = db.transaction(async (tx) => {
    await lock(tx)
    ready()
    await released
  })
  await locked
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Independent usage waited on unrelated lock")),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
    release()
    await holder
  }
}

dbTest("organization grants are unique, dynamic, tenant-scoped and retain all winning sources", async () => {
  const f = await fixture()
  const other = await fixture()
  const policy = await f.service.savePolicy(f.admin, f.body)
  await Promise.all([
    f.service.assign(f.admin, policy.id, { organization: true }),
    f.service.assign(f.admin, policy.id, { organization: true }),
  ])
  const assigned = (await f.service.listPolicies(f.admin)).policies.find((row) => row.id === policy.id)
  assert.ok(assigned)
  assert.equal(assigned.assignments.length, 1)
  const assignment = assigned.assignments[0]
  assert.ok(assignment)
  assert.deepEqual(assignment, { id: assignment.id, organization: true, memberId: null, teamId: null })
  const future = await f.addMember()
  for (const member of [f.admin, f.member, future]) {
    const status = gatewayUsageStatusSchema.parse(await f.service.getStatus(member))
    assert.equal(status.buckets.length, 3)
    assert.deepEqual(status.buckets[0]?.provenance, [{ kind: "organization", assignmentId: assignment.id, memberId: null, teamId: null }])
  }
  assert.equal((await other.service.getStatus(other.member)).state, "unlimited")
  const teamId = createDenTypeId("team")
  await f.db.insert(TeamTable).values({ id: teamId, organizationId: f.admin.organizationId, name: "Usage team" })
  await f.db.insert(TeamMemberTable).values({ id: createDenTypeId("teamMember"), teamId, orgMembershipId: f.member.memberId })
  await f.service.assign(f.admin, policy.id, { memberId: f.member.memberId })
  await f.service.assign(f.admin, policy.id, { teamId })
  assert.deepEqual((await f.service.getStatus(f.member)).buckets[0]?.provenance?.map((row) => row.kind).sort(), ["direct", "organization", "team"])
  const larger = await f.assigned({ ...f.body, limits: [{ timeframe: "day", costUsd: "2" }] })
  assert.equal((await f.service.getStatus(f.member)).buckets[0]?.policyId, larger.id)
  assert.equal((await f.service.getStatus(future)).buckets[0]?.policyId, policy.id)
  await f.service.unassign(f.admin, policy.id, assignment.id)
  assert.equal((await f.service.getStatus(future)).state, "unlimited")
  assert.equal((await f.service.getStatus(f.member)).buckets.length, 3)
})

dbTest("organization assignment CHECK and unique index reject ambiguous and duplicate targets", async () => {
  const f = await fixture()
  const policy = await f.service.savePolicy(f.admin, f.body)
  const base = { policyId: policy.id, organizationId: f.admin.organizationId, createdAt: new Date() }
  for (const target of [
    { memberId: null, teamId: null, organization: null },
    { memberId: null, teamId: null, organization: false },
    { memberId: f.member.memberId, teamId: null, organization: true },
    { memberId: null, teamId: createDenTypeId("team"), organization: true },
    { memberId: f.member.memberId, teamId: createDenTypeId("team"), organization: null },
  ]) await assert.rejects(f.db.insert(A).values({ ...base, ...target, id: randomUUID() }))
  await f.db.insert(A).values({ ...base, id: randomUUID(), organization: true })
  await assert.rejects(f.db.insert(A).values({ ...base, id: randomUUID(), organization: true }))
  for (const memberId of [f.admin.memberId, f.member.memberId])
    await f.db.insert(A).values({ ...base, id: randomUUID(), memberId })
  assert.equal((await f.db.select().from(A).where(eq(A.policyId, policy.id))).length, 3)
})

dbTest("organization transitions revoke stale extensions and pending resets without clearing spend", async () => {
  const f = await fixture()
  const second = await f.addMember()
  const policy = await f.assigned()
  await f.service.assign(f.admin, policy.id, { memberId: second.memberId })
  await f.spend(1_000_000)
  await f.spend(1_000_000, second)
  const firstBucket = (await f.service.getStatus(f.member)).buckets[0]
  const secondBucket = (await f.service.getStatus(second)).buckets[0]
  assert.ok(firstBucket && secondBucket)
  const approved = await f.service.submitReset(f.member, firstBucket.id, "Extension")
  await f.service.reviewReset(f.admin, approved.id, "approved")
  const pending = await f.service.submitReset(second, secondBucket.id, "Extension")
  const assignment = (await f.service.assign(f.admin, policy.id, { organization: true })).assignments.find((row) => row.organization)
  assert.ok(assignment)
  assert.equal((await f.service.getStatus(f.member)).buckets[0]?.extensionMicroUsd, 0)
  assert.equal((await f.service.getStatus(f.member)).buckets[0]?.usedMicroUsd, 1_000_000)
  assert.equal((await f.service.reviewReset(f.admin, pending.id, "approved")).status, "expired")
  const next = await f.service.submitReset(second, secondBucket.id, "Current sources")
  assert.equal((await f.service.listResets(f.admin, false)).requests.find((row) => row.id === next.id)?.status, "pending")
  await f.service.assign(f.admin, policy.id, { organization: true })
  assert.equal((await f.service.listResets(f.admin, false)).requests.find((row) => row.id === next.id)?.status, "pending")
  await f.service.unassign(f.admin, policy.id, assignment.id)
  assert.equal((await f.service.reviewReset(f.admin, next.id, "approved")).status, "expired")
})

dbTest("organization policy edits, member removal, archive and deletion preserve usage lifecycle", async () => {
  const f = await fixture()
  const policy = await f.service.savePolicy(f.admin, f.body)
  await f.service.assign(f.admin, policy.id, { organization: true })
  const future = await f.addMember()
  await f.spend(1_000_000, future)
  const bucket = (await f.service.getStatus(future)).buckets[0]
  assert.ok(bucket)
  const first = await f.service.submitReset(future, bucket.id, "Before policy edit")
  assert.equal((await f.service.listResets(f.admin, false)).requests.find((row) => row.id === first.id)?.status, "pending")
  const updated = await f.service.savePolicy(f.admin, { ...f.body, name: "Revised" }, policy.id, policy.revision)
  assert.equal((await f.service.reviewReset(f.admin, first.id, "approved")).status, "expired")
  const second = await f.service.submitReset(future, bucket.id, "Before removal")
  await f.db.transaction((tx) => withGatewayUsageEntitlementMutation(tx, future.organizationId, async () => {
    await tx.update(MemberTable).set({ removedAt: new Date() }).where(eq(MemberTable.id, future.memberId))
  }, [future.memberId]))
  assert.equal((await f.service.reviewReset(f.admin, second.id, "approved")).status, "expired")
  await assert.rejects(f.service.getStatus(future), (error: unknown) => error instanceof GatewayUsageError && error.code === "member_not_found")
  await f.service.archivePolicy(f.admin, policy.id, updated.revision)
  assert.equal((await f.service.getStatus(f.member)).state, "unlimited")
  assert.equal((await f.db.select().from(B).where(eq(B.memberId, future.memberId)))[0]?.usedMicroUsd, 1_000_000)
  await f.db.transaction((tx) => deleteGatewayUsageForOrganization(tx, future.organizationId))
  assert.equal((await f.db.select().from(A).where(eq(A.organizationId, future.organizationId))).length, 0)
})

dbTest("restoring an archived policy brings back its assignments and limits", async () => {
  const f = await fixture()
  const policy = await f.service.savePolicy(f.admin, f.body)
  const assigned = await f.service.assign(f.admin, policy.id, { organization: true })
  assert.notEqual((await f.service.getStatus(f.member)).state, "unlimited")
  const archived = await f.service.archivePolicy(f.admin, policy.id, assigned.revision)
  assert.equal((await f.service.getStatus(f.member)).state, "unlimited")
  await assert.rejects(f.service.restorePolicy(f.admin, policy.id, assigned.revision), (error: unknown) => error instanceof GatewayUsageError && error.code === "policy_revision_conflict")
  const restored = await f.service.restorePolicy(f.admin, policy.id, archived.revision)
  assert.equal(restored.archivedAt, null)
  assert.equal(restored.revision, archived.revision + 1)
  assert.deepEqual(restored.assignments.map((row) => row.organization), [true])
  assert.notEqual((await f.service.getStatus(f.member)).state, "unlimited")
})

dbTest(
  "fresh and 0104-applied databases migrate; old E/C/S/R and spend survive unchanged",
  async () => {
    assert.ok(url)
    const setup = await mysql.createConnection({
      ...localConnectionConfig(url),
      multipleStatements: true,
    })
    const upgradedUrl = new URL(url)
    upgradedUrl.pathname = "/usage_limits_test_upgrade"
    await setup.query("DROP DATABASE IF EXISTS usage_limits_test_upgrade")
    await setup.query("CREATE DATABASE usage_limits_test_upgrade")
    await setup.end()
    const conn = await mysql.createConnection({
      ...localConnectionConfig(upgradedUrl.toString()),
      multipleStatements: true,
    })
    try {
      await migration(conn, plan.findIndex((entry) => entry.tag.startsWith("0104_")) + 1)
      await conn.query(
        "INSERT INTO gateway_usage_bucket (id,organization_id,member_id,timeframe,start_at,reset_at,policy_id,policy_name,policy_revision,base_allowance_micro_usd,extension_micro_usd,used_micro_usd,extension_used,hard_limit,allow_request_reset) VALUES ('old','org_old','om_old','day','2026-09-15 05:00:00','2026-09-16 05:00:00','p','Old',7,1000,250,1234,1,1,1)",
      )
      await conn.query(
        "INSERT INTO gateway_usage_consumption_event (id,organization_id,member_id,admitted_at,cost_micro_usd,unpriced_requests,complete,finalized,source) VALUES ('old','org_old','om_old','2026-09-15 06:00:00',1234,0,1,1,'upstream')",
      )
      await conn.query(
        "INSERT INTO gateway_usage_bucket_charge (event_id,bucket_id,amount,policy_id,policy_revision) VALUES ('old','old',1234,'p',7)",
      )
      await conn.query(
        "INSERT INTO gateway_usage_subject VALUES ('om_old','org_old','2026-09-01 05:00:00','2026-09-15 06:00:00')",
      )
      await conn.query(
        "INSERT INTO gateway_usage_reset_request (id,organization_id,member_id,bucket_id,policy_id,policy_revision,timeframe,policy_name,reason,status,base_allowance_micro_usd,allowance_micro_usd,used_micro_usd,reset_at,created_at) VALUES ('old','org_old','om_old','old','p',7,'day','Old','fixture','approved',1000,1250,1234,'2026-09-16 05:00:00','2026-09-15 06:00:00')",
      )
      const tables = [
        "gateway_usage_bucket",
        "gateway_usage_consumption_event",
        "gateway_usage_bucket_charge",
        "gateway_usage_subject",
        "gateway_usage_reset_request",
      ]
      const before = await Promise.all(
        tables.map(async (table) => (await conn.query(`SELECT * FROM ${table}`))[0]),
      )
      await migration(conn)
      await migration(conn)
      for (const [i, table] of tables.entries()) {
        const [rows] = await conn.query(`SELECT * FROM ${table}`)
        assert.ok(Array.isArray(rows))
        const clean = rows.map((row) => {
          assert.ok(record(row))
          const copy = { ...row }
          if (table === "gateway_usage_bucket" || table === "gateway_usage_bucket_charge") {
            assert.equal(copy.unpriced_requests, 0)
            delete copy.unpriced_requests
            assert.equal(copy.incomplete_requests, 0)
            delete copy.incomplete_requests
            if (table === "gateway_usage_bucket") {
              assert.equal(copy.history_unknown, 1)
              delete copy.history_unknown
            }
          }
          if (table === "gateway_usage_consumption_event") {
            assert.equal(copy.request_started_at, null)
            assert.equal(copy.admission_snapshot, null)
            assert.equal(copy.pending_counted, 0)
            assert.equal(copy.tracking_version, null)
            delete copy.request_started_at
            delete copy.admission_snapshot
            delete copy.pending_counted
            delete copy.tracking_version
          }
          return copy
        })
        assert.deepEqual(clean, before[i])
      }
    } finally {
      await conn.end()
    }
  },
)

dbTest(
  "10000 raw rows: first status/admission/list/member reads are bounded SELECT-only; no-policy bypass",
  async () => {
    const f = await fixture()
    for (let batch = 0; batch < 20; batch++)
      await f.db.insert(Log).values(Array.from({ length: 500 }, () => f.raw(10)))
    const unlimited = await observed(() => f.service.admit(f.member, randomUUID(), false))
    assert.equal(unlimited.result.usage.state, "unlimited")
    assertReadOnly(unlimited.queries)
    assert.ok(
      unlimited.queries.every(
        (query) => !/gateway_usage_bucket|gateway_usage_reset|gateway_usage_subject/.test(query),
      ),
    )
    await f.assigned()
    for (const run of [
      () => f.service.getStatus(f.member),
      () => f.service.admit(f.member, randomUUID(), true),
      () => f.service.listPolicies(f.admin),
      () => f.service.members(f.admin),
    ]) {
      const measured = await observed<unknown>(run)
      assertReadOnly(measured.queries)
      assert.ok(measured.queries.length <= 10, measured.queries.join("\n"))
    }
    const status = await f.service.getStatus(f.member)
    assert.deepEqual(
      status.buckets.map((row) => row.usedMicroUsd),
      [0, 0, 0],
    )
    assert.equal(status.coverage.complete, false)
    assert.equal((await f.db.select().from(B).where(eq(B.memberId, f.member.memberId))).length, 0)
    assert.equal((await f.db.select().from(S).where(eq(S.memberId, f.member.memberId))).length, 0)
    const other = await f.addMember()
    const noPolicy = await f.prepare(13, other)
    const settlement = await observed(() => f.service.record(noPolicy))
    assert.ok(settlement.queries.every((query) => !/sum\(|gateway_usage_rollups/i.test(query)))
    assert.deepEqual(
      (await f.db.select().from(B).where(eq(B.memberId, other.memberId))).map(
        (bucket) => bucket.usedMicroUsd,
      ),
      [13, 13, 13],
    )
    const [canonical] = await f.db.select().from(Log).where(eq(Log.id, noPolicy.id))
    assert.equal(canonical.cost_micro_usd, 13)
  },
)

dbTest(
  "organization and global-rollup locks do not block admission, status or first settlement",
  async () => {
    const f = await fixture()
    await f.assigned()
    const row = await f.prepare(20)
    await f.db
      .insert(GatewayRollupLockTable)
      .values({ id: 1 })
      .onDuplicateKeyUpdate({ set: { id: 1 } })
    await whileLocked(
      async (tx) => {
        await tx
          .select()
          .from(OrganizationTable)
          .where(eq(OrganizationTable.id, f.member.organizationId))
          .for("update")
        await tx
          .select()
          .from(GatewayRollupLockTable)
          .where(eq(GatewayRollupLockTable.id, 1))
          .for("update")
      },
      async () => {
        await Promise.all([
          f.service.admit(f.member, randomUUID(), true),
          f.service.getStatus(f.member),
          f.service.record(row),
        ])
      },
    )
    assert.deepEqual(
      (await f.service.getStatus(f.member)).buckets.map((b) => b.usedMicroUsd),
      [20, 20, 20],
    )
  },
)

dbTest("member A bucket lock leaves member B independent and A reads nonblocking", async () => {
  const f = await fixture()
  const second = await f.addMember()
  const p = await f.assigned()
  await f.service.assign(f.admin, p.id, { memberId: second.memberId })
  await f.spend(1)
  const row = await f.prepare(21, second)
  const a = (await f.service.getStatus(f.member)).buckets[0]
  await whileLocked(
    (tx) =>
      tx
        .update(B)
        .set({ usedMicroUsd: sql`${B.usedMicroUsd}` })
        .where(eq(B.id, a.id)),
    async () => {
      await Promise.all([
        f.service.getStatus(f.member),
        f.service.admit(f.member, randomUUID(), true),
        f.service.record(row),
        f.service.getStatus(second),
      ])
    },
  )
  assert.equal((await f.service.getStatus(second)).buckets[0].usedMicroUsd, 21)
})

dbTest(
  "concurrent duplicate settlements once, distinct requests additive, canonical first price immutable",
  async () => {
    const f = await fixture()
    await f.assigned()
    const same = await f.prepare(101)
    await Promise.all(Array.from({ length: 12 }, () => f.service.record(same)))
    const rows = await Promise.all(Array.from({ length: 20 }, () => f.prepare(7)))
    const measured = await observed(() => Promise.all(rows.map((row) => f.service.record(row))))
    assert.ok(
      measured.queries.every(
        (query) => !/sum\(|gateway_usage_rollups|from `organization`.*for update/i.test(query),
      ),
    )
    const [canonical] = await f.db.select().from(Log).where(eq(Log.id, same.id))
    await f.service.record({ ...same, cost_micro_usd: 9000 })
    assert.equal(canonical.cost_micro_usd, 101)
    assert.deepEqual(
      (await f.service.getStatus(f.member)).buckets.map((row) => row.usedMicroUsd),
      [241, 241, 241],
    )
    assert.equal(
      (await f.db.select().from(C).where(eq(C.eventId, same.openwork_request_id))).length,
      3,
    )
    await f.db.delete(Log).where(eq(Log.id, same.id))
    await f.service.record({ ...same, cost_micro_usd: 9999 })
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 241)
  },
)

dbTest("unknown is explicit; delayed known promotion is atomic and happens once", async () => {
  const f = await fixture()
  await f.assigned()
  const row = await f.spend(null)
  assert.equal((await f.service.getStatus(f.member)).coverage.complete, false)
  assert.equal((await f.service.getStatus(f.member)).coverage.unpricedRequests, 1)
  assert.equal((await f.service.getStatus(f.member)).coverage.historicalCoverage, "unknown")
  const promoted = {
    ...row,
    cost_micro_usd: 50,
    metadata: { ...row.metadata, cost_source: "upstream", cost_complete: true },
  }
  await Promise.all(Array.from({ length: 8 }, () => f.service.record(promoted)))
  await f.service.record({ ...promoted, cost_micro_usd: 999 })
  const status = await f.service.getStatus(f.member)
  assert.equal(status.coverage.unpricedRequests, 0)
  assert.deepEqual(
    status.buckets.map((b) => b.usedMicroUsd),
    [50, 50, 50],
  )
  const [canonical] = await f.db.select().from(Log).where(eq(Log.id, row.id))
  const [event] = await f.db.select().from(E).where(eq(E.id, row.openwork_request_id))
  assert.equal(canonical.cost_micro_usd, 50)
  assert.equal(event.costMicroUsd, 50)
  assert.equal(event.source, "upstream")
})

dbTest(
  "original 05UTC day/week/month attribution survives boundary crossing and policy edit",
  async () => {
    const f = await fixture()
    const p = await f.assigned()
    let revision = p.revision
    for (const boundary of [
      "2026-09-16T05:00:00.000Z",
      "2026-09-21T05:00:00.000Z",
      "2026-10-01T05:00:00.000Z",
    ]) {
      const before = new Date(new Date(boundary).getTime() - 1).toISOString()
      f.setTime(before)
      const row = await f.prepare(70)
      const admission = await f.service.admit(
        f.member,
        row.openwork_request_id,
        true,
        row.started_at,
      )
      f.setTime(boundary)
      revision = (
        await f.service.savePolicy(
          f.admin,
          { ...f.body, name: `Revision ${revision + 1}` },
          p.id,
          revision,
        )
      ).revision
      await f.service.record(row)
      for (const target of admission.snapshot.buckets) {
        const [bucket] = await f.db.select().from(B).where(eq(B.id, target.id))
        assert.ok(bucket.usedMicroUsd >= 70)
        const [charge] = await f.db
          .select()
          .from(C)
          .where(and(eq(C.eventId, row.openwork_request_id), eq(C.bucketId, bucket.id)))
        assert.equal(charge.policyRevision, target.policyRevision)
        assert.notEqual(charge.policyRevision, revision)
      }
      const frame = boundary.includes("10-01")
        ? "month"
        : boundary.includes("09-21")
          ? "week"
          : "day"
      assert.equal(
        (await f.service.getStatus(f.member)).buckets.find((b) => b.timeframe === frame)
          ?.usedMicroUsd,
        0,
      )
    }
  },
)

dbTest(
  "legacy random IDs, charged events, pending receipts and subject cutover are not reset or replayed",
  async () => {
    const f = await fixture()
    const p = await f.assigned()
    const old = f.raw(41)
    const day = {
      ...projectedBucket(f.member, "day", old.started_at),
      id: randomUUID(),
      policyId: p.id,
      policyRevision: 1,
      usedMicroUsd: 500,
      baseAllowanceMicroUsd: 1000000,
      policyName: p.name,
      hardLimit: true,
      allowRequestReset: true,
    }
    await f.db.insert(B).values(day)
    await f.db.insert(S).values({
      ...f.member,
      trackingSince: new Date("2026-09-01T05:00:00Z"),
      initializedAt: old.started_at,
    })
    await f.db.insert(E).values({
      id: old.openwork_request_id,
      ...f.member,
      admittedAt: old.started_at,
      costMicroUsd: 41,
      finalized: true,
      source: "upstream",
      unpricedRequests: 0,
    })
    await f.db.insert(C).values({
      eventId: old.openwork_request_id,
      bucketId: day.id,
      amount: 41,
      policyId: p.id,
      policyRevision: 1,
    })
    await f.service.record(old)
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 500)
    const pending = f.raw(null)
    await f.db.insert(E).values({
      id: pending.openwork_request_id,
      ...f.member,
      admittedAt: pending.started_at,
      source: "pending",
    })
    await f.db.insert(C).values({
      eventId: pending.openwork_request_id,
      bucketId: day.id,
      amount: 0,
      policyId: p.id,
      policyRevision: 1,
    })
    await f.service.record({ ...pending, cost_micro_usd: 3 })
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 503)
    await f.spend(7)
    assert.equal((await f.service.getStatus(f.member)).buckets[0].id, day.id)
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 510)
    const historical = f.raw(10000)
    await f.db.insert(Log).values(historical)
    await f.service.record(historical)
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 510)
  },
)

dbTest("overflow rolls back canonical log, event and every bucket atomically", async () => {
  const f = await fixture()
  await f.assigned()
  const large = await f.prepare(Number.MAX_SAFE_INTEGER),
    tiny = await f.prepare(1)
  await f.service.record(large)
  await assert.rejects(f.service.record(tiny))
  const [pendingEvent] = await f.db.select().from(E).where(eq(E.id, tiny.openwork_request_id))
  assert.equal(pendingEvent.pendingCounted, true)
  assert.equal(pendingEvent.finalized, false)
  assert.equal(pendingEvent.costMicroUsd, null)
  const [canonical] = await f.db.select().from(Log).where(eq(Log.id, tiny.id))
  assert.equal(canonical.completed_at, null)
  assert.deepEqual(
    (await f.service.getStatus(f.member)).buckets.map((b) => b.usedMicroUsd),
    Array(3).fill(Number.MAX_SAFE_INTEGER),
  )
})

dbTest(
  "team individual allowance, highest winner, soft/no-policy and auth boundaries",
  async () => {
    const f = await fixture()
    const second = await f.addMember()
    const foreign = await fixture()
    const teamId = createDenTypeId("team")
    await f.db
      .insert(TeamTable)
      .values({ id: teamId, organizationId: f.member.organizationId, name: "Fixture team" })
    await f.db.insert(TeamMemberTable).values(
      [f.member, second].map((m) => ({
        id: createDenTypeId("teamMember"),
        teamId,
        orgMembershipId: m.memberId,
      })),
    )
    const p = await f.service.savePolicy(f.admin, f.body)
    await f.service.assign(f.admin, p.id, { teamId })
    await f.service.assign(f.admin, p.id, { memberId: f.member.memberId })
    await f.spend(1100000)
    const own = gatewayUsageStatusSchema.parse(await f.service.getStatus(f.member))
    assert.equal(own.state, "blocked")
    assert.equal(own.buckets[0].provenance?.length, 2)
    assert.equal((await f.service.getStatus(second)).buckets[0].usedMicroUsd, 0)
    assert.equal((await f.service.admit(second, randomUUID(), false)).accountingUnavailable, true)
    await f.assigned({
      ...f.body,
      hardLimit: false,
      limits: [
        { timeframe: "day", costUsd: "20" },
        { timeframe: "week", costUsd: "20" },
        { timeframe: "month", costUsd: "20" },
      ],
    })
    assert.equal((await f.service.admit(f.member, randomUUID(), false)).admitted, true)
    for (const run of [
      () => f.service.listPolicies(f.member),
      () => f.service.members(f.member),
      () => f.service.getStatus(f.member, second.memberId),
    ])
      await assert.rejects(run, (e) => e instanceof GatewayUsageError && e.status === 403)
    await assert.rejects(f.service.assign(f.admin, p.id, { memberId: foreign.member.memberId }))
    await assert.rejects(f.service.getStatus(f.admin, foreign.member.memberId))
  },
)

dbTest(
  "repeated 25% extensions accumulate, submit/review are idempotent, policy revisions and A-B-A invalidate pending requests",
  async () => {
    const f = await fixture()
    const p = await f.assigned({ ...f.body, limits: [{ timeframe: "day", costUsd: "0.000100" }] })
    await f.spend(100)
    const day = (await f.service.getStatus(f.member)).buckets[0]
    assert.equal(day.allowanceMicroUsd, 100)
    const history: Awaited<ReturnType<typeof f.service.reviewReset>>[] = []
    for (const increase of [1, 2]) {
      f.setTime(`2026-09-15T12:0${increase}:00Z`)
      const exhausted = (await f.service.getStatus(f.member)).buckets[0]
      assert.equal(exhausted.canRequestReset, true)
      assert.equal(exhausted.remainingMicroUsd, 0)
      assert.equal(exhausted.allowanceMicroUsd, 100 + 25 * (increase - 1))
      await assert.rejects(f.service.submitReset(f.member, day.id, "   "))
      const requests = await Promise.all([
        f.service.submitReset(f.member, day.id, `Increase ${increase}`),
        f.service.submitReset(f.member, day.id, `Increase ${increase}`),
      ])
      assert.equal(requests[0].id, requests[1].id)
      assert.ok(history.every((request) => request.id !== requests[0].id))
      const pending = (await f.service.getStatus(f.member)).buckets[0]
      assert.equal(pending.canRequestReset, false)
      assert.equal(pending.resetRequestStatus, "pending")
      for (const page of [
        await f.service.listResets(f.member, true),
        await f.service.listResets(f.admin, false),
      ]) {
        assert.equal(page.pendingCount, 1)
        assert.deepEqual(page.requests, [requests[0]])
        assert.equal(page.requests[0].status, "pending")
        assert.equal(page.requests[0].allowanceMicroUsd, exhausted.allowanceMicroUsd)
      }
      if (history[0]) {
        assert.deepEqual(await f.service.reviewReset(f.admin, history[0].id, "approved"), history[0])
        assert.equal((await f.service.getStatus(f.member)).buckets[0].allowanceMicroUsd, 125)
      }
      const reviews = await Promise.all([
        f.service.reviewReset(f.admin, requests[0].id, "approved"),
        f.service.reviewReset(f.admin, requests[0].id, "approved"),
      ])
      assert.deepEqual(reviews[0], reviews[1])
      history.unshift(reviews[0])
      const approved = (await f.service.getStatus(f.member)).buckets[0]
      assert.equal(approved.extensionMicroUsd, 25 * increase)
      assert.equal(approved.allowanceMicroUsd, 100 + 25 * increase)
      assert.equal(approved.usedMicroUsd, exhausted.usedMicroUsd)
      assert.equal(approved.resetAt, day.resetAt)
      assert.equal(approved.remainingMicroUsd, 25)
      assert.equal(approved.canRequestReset, false)
      assert.equal(approved.resetRequestStatus, "approved")
      await assert.rejects(f.service.submitReset(f.member, day.id, "Not exhausted"))
      assert.equal((await f.service.listResets(f.admin, false)).pendingCount, 0)
      assert.deepEqual((await f.service.listResets(f.admin, false, { view: "history" })).requests, history)
      assert.deepEqual((await f.service.listResets(f.member, true, { view: "history" })).requests, history)
      await f.spend(25)
    }
    f.setTime("2026-09-15T12:03:00Z")
    const stale = await f.service.submitReset(f.member, day.id, "Before policy revision")
    const p2 = await f.service.savePolicy(
      f.admin,
      { ...f.body, limits: [{ timeframe: "day", costUsd: "0.000100" }] },
      p.id,
      1,
    )
    assert.equal((await f.service.reviewReset(f.admin, stale.id, "approved")).status, "expired")
    const rebased = (await f.service.getStatus(f.member)).buckets[0]
    assert.equal(rebased.usedMicroUsd, 150)
    assert.equal(rebased.extensionMicroUsd, 0)
    assert.equal(rebased.resetAt, day.resetAt)
    assert.equal(rebased.canRequestReset, true)
    assert.deepEqual(
      (await f.service.listResets(f.member, true, { view: "history" })).requests.filter((request) => request.status === "approved"),
      history,
    )
    await assert.rejects(f.service.savePolicy(f.admin, f.body, p.id, 1))
    assert.equal(p2.revision, 2)

    const g = await fixture()
    const a = await g.assigned()
    await g.spend(1000000)
    const bucket = (await g.service.getStatus(g.member)).buckets[0]
    const request = await g.service.submitReset(g.member, bucket.id, "before transition")
    const higher = await g.assigned({ ...g.body, limits: [{ timeframe: "day", costUsd: "10" }] })
    const assignments = (await g.service.listPolicies(g.admin)).policies.find(
      (row) => row.id === higher.id,
    )?.assignments
    assert.ok(assignments)
    await g.service.unassign(g.admin, higher.id, assignments[0].id)
    assert.equal((await g.service.reviewReset(g.admin, request.id, "approved")).status, "expired")
    assert.equal((await g.service.getStatus(g.member)).buckets[0].policyId, a.id)
    assert.equal((await g.service.getStatus(g.member)).buckets[0].usedMicroUsd, 1000000)
  },
)

dbTest("repeated extensions round up from base and overflow rolls back approval", async () => {
  const f = await fixture()
  await f.assigned({ ...f.body, limits: [{ timeframe: "day", costUsd: "0.000005" }] })
  await f.spend(5)
  const day = (await f.service.getStatus(f.member)).buckets[0]
  for (const increase of [1, 2]) {
    f.setTime(`2026-09-15T12:0${increase}:00Z`)
    const request = await f.service.submitReset(f.member, day.id, "Rounded increase")
    await f.service.reviewReset(f.admin, request.id, "approved")
    const approved = (await f.service.getStatus(f.member)).buckets[0]
    assert.equal(approved.extensionMicroUsd, 2 * increase)
    assert.equal(approved.allowanceMicroUsd, 5 + 2 * increase)
    await f.spend(2)
  }
  await f.db.update(B).set({
    extensionMicroUsd: Number.MAX_SAFE_INTEGER - 5,
    usedMicroUsd: Number.MAX_SAFE_INTEGER,
  }).where(eq(B.id, day.id))
  f.setTime("2026-09-15T12:03:00Z")
  const request = await f.service.submitReset(f.member, day.id, "Overflow")
  const [before] = await f.db.select().from(B).where(eq(B.id, day.id))
  await assert.rejects(f.service.reviewReset(f.admin, request.id, "approved"), /safe integer range/)
  assert.deepEqual((await f.db.select().from(B).where(eq(B.id, day.id)))[0], before)
  assert.deepEqual((await f.service.listResets(f.admin, false)).requests, [request])
  assert.equal((await f.service.listResets(f.member, true, { view: "history" })).requests.length, 2)
})

dbTest(
  "policy-edit/approval race, elapsed period, member removal and reviewer authorization",
  async () => {
    const f = await fixture()
    const p = await f.assigned()
    await f.spend(1000000)
    const day = (await f.service.getStatus(f.member)).buckets[0]
    const request = await f.service.submitReset(f.member, day.id, "race")
    await assert.rejects(f.service.reviewReset(f.member, request.id, "approved"))
    const foreign = await fixture()
    await assert.rejects(f.service.reviewReset(foreign.admin, request.id, "approved"))
    await Promise.all([
      f.service.reviewReset(f.admin, request.id, "approved"),
      f.service.savePolicy(f.admin, { ...f.body, name: "Edited" }, p.id, 1),
    ])
    assert.equal((await f.service.getStatus(f.member)).buckets[0].extensionMicroUsd, 0)
    const g = await fixture()
    await g.assigned()
    await g.spend(1000000)
    const current = (await g.service.getStatus(g.member)).buckets[0]
    const first = await g.service.submitReset(g.member, current.id, "First increase")
    const approved = await g.service.reviewReset(g.admin, first.id, "approved")
    await g.spend(250000)
    g.setTime("2026-09-15T12:01:00Z")
    const pending = await g.service.submitReset(g.member, current.id, "elapsed repeat increase")
    g.setTime(current.resetAt)
    assert.equal((await g.service.reviewReset(g.admin, pending.id, "approved")).status, "expired")
    assert.deepEqual(await g.service.reviewReset(g.admin, first.id, "approved"), approved)
    const [expiredBucket] = await g.db.select().from(B).where(eq(B.id, current.id))
    assert.equal(expiredBucket.extensionMicroUsd, 250000)
    assert.equal(expiredBucket.usedMicroUsd, 1250000)
    await g.spend(1000000)
    const next = (await g.service.getStatus(g.member)).buckets[0]
    const removed = await g.service.submitReset(g.member, next.id, "removed")
    await g.db
      .update(MemberTable)
      .set({ removedAt: new Date() })
      .where(eq(MemberTable.id, g.member.memberId))
    assert.equal((await g.service.reviewReset(g.admin, removed.id, "approved")).status, "expired")
  },
)

dbTest(
  "explicit team-membership control-plane invalidates pending A-B-A without GET mutation",
  async () => {
    const f = await fixture()
    const teamId = createDenTypeId("team"),
      teamMemberId = createDenTypeId("teamMember")
    await f.db
      .insert(TeamTable)
      .values({ id: teamId, organizationId: f.member.organizationId, name: "Policy team" })
    const membership = { id: teamMemberId, teamId, orgMembershipId: f.member.memberId }
    await f.db.insert(TeamMemberTable).values(membership)
    const p = await f.service.savePolicy(f.admin, f.body)
    await f.service.assign(f.admin, p.id, { teamId })
    await f.spend(1000000)
    const day = (await f.service.getStatus(f.member)).buckets[0],
      request = await f.service.submitReset(
        f.member,
        (await f.service.getStatus(f.member)).buckets[0].id,
        "team",
      )
    await f.db.transaction((tx) =>
      withGatewayUsageEntitlementMutation(
        tx,
        f.member.organizationId,
        async () => {
          await tx.delete(TeamMemberTable).where(eq(TeamMemberTable.id, teamMemberId))
        },
        [f.member.memberId],
      ),
    )
    await f.db.insert(TeamMemberTable).values(membership)
    assert.equal((await f.service.reviewReset(f.admin, request.id, "approved")).status, "expired")
    assert.equal((await f.service.getStatus(f.member)).buckets[0].id, day.id)
    assertReadOnly((await observed(() => f.service.listResets(f.admin, false))).queries)
  },
)

dbTest(
  "explicit bounded reconciliation previews without writes, applies once and refuses ambiguous legacy history",
  async () => {
    const f = await fixture()
    await f.assigned()
    const raw = f.raw(300)
    await f.db.insert(Log).values(raw)
    const admission = await f.service.admit(f.member, raw.openwork_request_id, true, raw.started_at)
    const input = {
      actor: f.admin,
      entries: [
        {
          requestId: raw.openwork_request_id,
          startedAt: raw.started_at.toISOString(),
          snapshot: admission.snapshot,
        },
      ],
      uncoveredSince: "2026-09-15T10:00:00.000Z",
      reviewReference: "INTERNAL-5056",
    }
    const preview = await observed(() => reconcileGatewayUsageBatch(f.db, input))
    assert.ok(
      preview.queries.every(
        (query) => /^(select|begin|commit)/i.test(query) && !/for update|for share/i.test(query),
      ),
    )
    assert.equal(preview.result.results[0].status, "eligible")
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 0)
    assert.equal(
      (await reconcileGatewayUsageBatch(f.db, { ...input, apply: true })).results[0].status,
      "applied",
    )
    assert.equal(
      (await reconcileGatewayUsageBatch(f.db, { ...input, apply: true })).results[0].status,
      "already_attributed",
    )
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 300)
    assert.equal((await f.service.getStatus(f.member)).coverage.complete, false)
    await assert.rejects(
      reconcileGatewayUsageBatch(f.db, { ...input, actor: f.member, apply: true }),
    )
    await assert.rejects(
      reconcileGatewayUsageBatch(f.db, { ...input, entries: Array(101).fill(input.entries[0]) }),
    )
    const old = f.raw(10000)
    old.started_at = new Date("2026-09-15T11:00:00Z")
    await f.db.insert(Log).values(old)
    await f.db.insert(S).values({
      ...f.member,
      trackingSince: new Date("2026-09-01T05:00:00Z"),
      initializedAt: raw.started_at,
    })
    const legacy = {
      ...input,
      apply: true,
      entries: [
        {
          ...input.entries[0],
          requestId: old.openwork_request_id,
          startedAt: old.started_at.toISOString(),
        },
      ],
    }
    legacy.entries[0].snapshot = { version: 1, buckets: admission.snapshot.buckets }
    assert.equal((await reconcileGatewayUsageBatch(f.db, legacy)).results[0].status, "pre_cutover")
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 300)
  },
)

dbTest(
  "paused admission before canonical INSERT cannot resurrect permanently erased usage; late soft-offboard cost survives",
  async () => {
    const f = await fixture()
    await f.assigned()
    const row = f.raw(123)
    const admission = await f.service.admit(f.member, row.openwork_request_id, true)
    row.metadata = { ...row.metadata, gateway_usage: admission.snapshot }
    let resume = () => {},
      paused = () => {},
      dispatches = 0
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const ready = new Promise<void>((resolve) => {
      paused = resolve
    })
    const request = (async () => {
      paused()
      await gate
      await f.db.transaction((tx) => startGatewayUsageLog(tx, { ...row, completed_at: null }))
      dispatches++
    })()
    await ready
    await f.db.transaction(async (tx) => {
      await deleteGatewayUsageForOrganization(tx, f.member.organizationId)
      await tx.delete(Log).where(eq(Log.organization_id, f.member.organizationId))
      await tx.delete(MemberTable).where(eq(MemberTable.organizationId, f.member.organizationId))
      await tx.delete(OrganizationTable).where(eq(OrganizationTable.id, f.member.organizationId))
    })
    resume()
    await assert.rejects(request)
    assert.equal(await f.service.record({ ...row, outcome: "rejected" }), false)
    assert.equal(dispatches, 0)
    assert.equal(
      (await f.db.select().from(Log).where(eq(Log.organization_id, f.member.organizationId)))
        .length,
      0,
    )
    assert.equal(
      (await f.db.select().from(B).where(eq(B.organizationId, f.member.organizationId))).length,
      0,
    )
    assert.equal(
      (await f.db.select().from(E).where(eq(E.organizationId, f.member.organizationId))).length,
      0,
    )
    assert.equal(
      (await f.db.select().from(C).where(eq(C.eventId, row.openwork_request_id))).length,
      0,
    )
    assert.equal(
      (await f.db.select().from(T).where(eq(T.organizationId, f.member.organizationId))).length,
      0,
    )
    const soft = await fixture()
    const late = await soft.prepare(456)
    await soft.db
      .update(MemberTable)
      .set({ removedAt: new Date() })
      .where(eq(MemberTable.id, soft.member.memberId))
    assert.equal(await soft.service.record(late), true)
    assert.deepEqual(
      (await soft.db.select().from(B).where(eq(B.memberId, soft.member.memberId))).map(
        (bucket) => bucket.usedMicroUsd,
      ),
      [456, 456, 456],
    )
  },
)

dbTest(
  "unlimited response spend is materialized before first policy; history and settlement readiness are distinct",
  async () => {
    const f = await fixture()
    const initial = await f.service.getStatus(f.member)
    assert.equal(initial.coverage.historicalUnknownReason, "tracking_not_started")
    assert.equal(initial.coverage.pendingRequests, null)
    const row = await f.prepare(8_000_000)
    const pending = await f.service.getStatus(f.member)
    assert.equal(pending.coverage.pendingRequests, 1)
    assert.equal(pending.coverage.settlementReady, false)
    await Promise.all([
      f.db.transaction((tx) =>
        startGatewayUsageLog(tx, { ...row, completed_at: null, cost_micro_usd: null }),
      ),
      f.db.transaction((tx) =>
        startGatewayUsageLog(tx, { ...row, completed_at: null, cost_micro_usd: null }),
      ),
    ])
    assert.equal((await f.service.getStatus(f.member)).coverage.pendingRequests, 1)
    await Promise.all([f.service.record(row), f.service.record(row)])
    const settled = await f.service.getStatus(f.member)
    assert.equal(settled.coverage.pendingRequests, 0)
    assert.equal(settled.coverage.settlementReady, true)
    assert.equal(settled.coverage.historicalCoverage, "unknown")
    assert.equal(settled.coverage.complete, false)
    assert.equal(settled.coverage.lastSettlementRequestId, row.openwork_request_id)
    assert.ok(settled.coverage.lastSettlementAt)
    await f.assigned({ ...f.body, limits: [{ timeframe: "month", costUsd: "10" }] })
    const observedStatus = await observed(() => f.service.getStatus(f.member))
    assertReadOnly(observedStatus.queries)
    assert.equal(observedStatus.result.buckets[0].usedMicroUsd, 8_000_000)
    assert.equal(observedStatus.result.buckets[0].remainingMicroUsd, 2_000_000)
    f.setTime("2026-10-05T06:00:00.000Z")
    const next = await f.service.getStatus(f.member)
    assert.equal(next.coverage.historicalCoverage, "tracked_since_epoch")
    assert.equal(next.coverage.complete, true)
  },
)

dbTest(
  "slow request preparation crosses 05UTC: admission uses current period, completion retains that admission",
  async () => {
    const f = await fixture()
    await f.assigned()
    f.setTime("2026-09-15T04:59:59.000Z")
    const row = f.raw(55)
    f.setTime("2026-09-15T05:00:01.000Z")
    const admission = await f.service.admit(f.member, row.openwork_request_id, true, row.started_at)
    assert.equal(admission.snapshot.version, 2)
    assert.ok("admittedAt" in admission.snapshot)
    assert.equal(admission.snapshot.admittedAt, "2026-09-15T05:00:01.000Z")
    assert.equal(admission.snapshot.buckets[0].startAt, "2026-09-15T05:00:00.000Z")
    row.metadata = { ...row.metadata, gateway_usage: admission.snapshot }
    const admittedAt = new Date(admission.snapshot.admittedAt)
    await f.db.transaction((tx) =>
      startGatewayUsageLog(tx, { ...row, cost_micro_usd: null, completed_at: null }, admittedAt),
    )
    f.setTime("2026-09-16T05:00:01.000Z")
    await f.service.record({ ...row, completed_at: new Date("2026-09-16T05:00:01.000Z") })
    const [event] = await f.db.select().from(E).where(eq(E.id, row.openwork_request_id))
    assert.equal(event.admittedAt.toISOString(), admission.snapshot.admittedAt)
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 0)
    const [canonical] = await f.db.select().from(Log).where(eq(Log.id, row.id))
    assert.equal(canonical.started_at.toISOString(), "2026-09-15T04:59:59.000Z")
  },
)

dbTest(
  "reconciliation rejects aggregate-backed and unexplained counters without S; empty snapshots need receipt proof",
  async () => {
    for (const aggregate of [true, false]) {
      const f = await fixture()
      await f.assigned()
      const row = f.raw(80)
      row.metadata = { ...row.metadata, gateway_usage: { version: 1, buckets: [] } }
      await f.db.insert(Log).values(row)
      const admission = await f.service.admit(f.member, row.openwork_request_id, true)
      const target = admission.snapshot.buckets[0]
      await f.db.insert(B).values({
        ...target,
        startAt: new Date(target.startAt),
        resetAt: new Date(target.resetAt),
        usedMicroUsd: 80,
      })
      if (aggregate)
        await f.db.insert(E).values({
          id: `history:${randomUUID()}`,
          ...f.member,
          admittedAt: row.started_at,
          costMicroUsd: 80,
          source: "historical_rollup",
          finalized: true,
        })
      const input = {
        actor: f.admin,
        entries: [
          {
            requestId: row.openwork_request_id,
            startedAt: row.started_at.toISOString(),
            snapshot: admission.snapshot,
          },
        ],
        uncoveredSince: row.started_at.toISOString(),
        reviewReference: "INTERNAL-5056",
      }
      assert.equal(
        (await reconcileGatewayUsageBatch(f.db, input)).results[0].status,
        "indeterminate_overlap",
      )
      assert.equal(
        (await reconcileGatewayUsageBatch(f.db, { ...input, apply: true })).results[0].status,
        "indeterminate_overlap",
      )
      assert.equal((await f.db.select().from(B).where(eq(B.memberId, f.member.memberId))).length, 1)
      assert.equal((await f.db.select().from(B).where(eq(B.id, target.id)))[0].usedMicroUsd, 80)
      assert.equal(
        (await f.db.select().from(C).where(eq(C.eventId, row.openwork_request_id))).length,
        0,
      )
    }
    const f = await fixture()
    const row = f.raw(80)
    row.metadata = { ...row.metadata, gateway_usage: { version: 1, buckets: [] } }
    await f.db.insert(Log).values(row)
    const admission = await f.service.admit(f.member, row.openwork_request_id, true)
    const input = {
      actor: f.admin,
      entries: [
        {
          requestId: row.openwork_request_id,
          startedAt: row.started_at.toISOString(),
          snapshot: admission.snapshot,
        },
      ],
      uncoveredSince: row.started_at.toISOString(),
      reviewReference: "INTERNAL-5056",
      apply: true,
    }
    assert.equal((await reconcileGatewayUsageBatch(f.db, input)).results[0].status, "applied")
    assert.equal(
      (await reconcileGatewayUsageBatch(f.db, input)).results[0].status,
      "already_attributed",
    )
    assert.deepEqual(
      (await f.db.select().from(B).where(eq(B.memberId, f.member.memberId))).map(
        (bucket) => bucket.usedMicroUsd,
      ),
      [80, 80, 80],
    )
  },
)

dbTest(
  "entire reconciliation manifest is validated before writes, including later malformed period and injected counter fields",
  async () => {
    const f = await fixture()
    const rows = [f.raw(7), f.raw(8)]
    for (const row of rows) await f.db.insert(Log).values(row)
    const entries = await Promise.all(
      rows.map(async (row) => ({
        requestId: row.openwork_request_id,
        startedAt: row.started_at.toISOString(),
        snapshot: (await f.service.admit(f.member, row.openwork_request_id, true)).snapshot,
      })),
    )
    const input = {
      actor: f.admin,
      entries,
      uncoveredSince: rows[0].started_at.toISOString(),
      reviewReference: "INTERNAL-5056",
    }
    const invalidPeriod = structuredClone(input)
    invalidPeriod.entries[1].snapshot.buckets[2].resetAt = "not-a-date"
    const wrongPeriod = structuredClone(input)
    wrongPeriod.entries[1].snapshot.buckets[0].startAt = "2026-09-14T05:00:00.000Z"
    const injected = {
      ...input,
      entries: input.entries.map((entry, i) =>
        i
          ? {
              ...entry,
              snapshot: {
                ...entry.snapshot,
                buckets: entry.snapshot.buckets.map((bucket) => ({ ...bucket, usedMicroUsd: 99 })),
              },
            }
          : entry,
      ),
    }
    for (const manifest of [invalidPeriod, wrongPeriod, injected])
      for (const apply of [false, true])
        await assert.rejects(reconcileGatewayUsageBatch(f.db, { ...manifest, apply }))
    assert.equal((await f.db.select().from(E).where(eq(E.memberId, f.member.memberId))).length, 0)
    assert.equal((await f.db.select().from(B).where(eq(B.memberId, f.member.memberId))).length, 0)
  },
)

dbTest(
  "crash identity survives real raw retention, abandonment decrements once, and late cost promotes original windows",
  async () => {
    const f = await fixture()
    f.setTime("2026-06-01T12:15:00.000Z")
    await f.assigned()
    const row = await f.prepare(null)
    const { createDbRollupRepository, buildRollupRows } =
      await import("../../../apps/gateway/src/rollups")
    const repository = createDbRollupRepository(f.db)
    const compact = () =>
      repository.transaction(async (store) => {
        const hour = new Date("2026-06-01T12:00:00.000Z")
        const batch = await store.aggregateRawHour(hour, 100)
        await store.upsertRollups(buildRollupRows("hour", hour, batch.groups))
        await store.deleteRawIds(batch.ids)
      })
    await compact()
    assert.equal((await f.db.select().from(Log).where(eq(Log.id, row.id))).length, 0)
    const [durable] = await f.db.select().from(E).where(eq(E.id, row.openwork_request_id))
    assert.equal(durable.pendingCounted, true)
    assert.ok(durable.admissionSnapshot)
    assert.ok(durable.requestStartedAt)
    const pending = await listPendingGatewayUsageRequests(f.db, {
      actor: f.admin,
      memberId: f.member.memberId,
      before: "2026-06-02T12:00:00.000Z",
    })
    assert.ok(pending.some((entry) => entry.requestId === row.openwork_request_id))
    f.setTime("2026-06-02T12:00:00.000Z")
    const input = {
      actor: f.admin,
      requestIds: [row.openwork_request_id],
      abandonedBefore: "2026-06-02T00:00:00.000Z",
      reviewReference: "INTERNAL-RECOVERY",
    }
    const preview = await observed(() => recoverGatewayUsageRequests(f.db, input))
    assert.ok(
      preview.queries.every(
        (q) => /^(select|begin|commit)/i.test(q) && !/for update|for share/i.test(q),
      ),
    )
    assert.equal(
      (
        await recoverGatewayUsageRequests(
          f.db,
          { ...input, apply: true },
          () => new Date("2026-06-02T12:00:00.000Z"),
        )
      ).results[0].status,
      "recovered",
    )
    await recoverGatewayUsageRequests(f.db, { ...input, apply: true })
    const [recovered] = await f.db.select().from(E).where(eq(E.id, row.openwork_request_id))
    assert.equal(recovered.pendingCounted, false)
    assert.equal(recovered.finalized, true)
    assert.equal(recovered.costMicroUsd, null)
    assert.equal(recovered.complete, false)
    assert.equal((await f.service.getStatus(f.member)).coverage.pendingRequests, 0)
    assert.equal((await f.service.getStatus(f.member)).coverage.unpricedRequests, 1)
    const late = {
      ...row,
      completed_at: new Date("2026-06-02T12:01:00.000Z"),
      cost_micro_usd: 350,
      metadata: { ...row.metadata, cost_source: "upstream", cost_complete: true },
    }
    await Promise.all([f.service.record(late), f.service.record(late)])
    assert.equal((await f.db.select().from(Log).where(eq(Log.id, row.id))).length, 0)
    const old = await f.db.select().from(B).where(eq(B.memberId, f.member.memberId))
    assert.deepEqual(
      old.map((b) => b.usedMicroUsd),
      [350, 350, 350],
    )
    assert.equal(
      old.find((b) => b.timeframe === "day")?.startAt.toISOString(),
      "2026-06-01T05:00:00.000Z",
    )
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 0)
    assert.equal((await f.service.getStatus(f.member)).coverage.pendingRequests, 0)
    assert.equal((await f.service.getStatus(f.member)).coverage.unpricedRequests, 0)
  },
)

dbTest(
  "retention refuses a legacy pending row until explicit durable transfer/recovery; no pending tally is lost",
  async () => {
    const f = await fixture()
    f.setTime("2026-06-01T13:15:00.000Z")
    const row = f.raw(null),
      admission = await f.service.admit(f.member, row.openwork_request_id, true)
    await f.db.insert(T).values({
      ...f.member,
      trackingStartedAt: row.started_at,
      pendingRequests: 1,
      captureEnabled: true,
    })
    await f.db.insert(Log).values({
      ...row,
      completed_at: null,
      metadata: { gateway_usage: admission.snapshot, gateway_usage_pending: true },
    })
    const { createDbRollupRepository, buildRollupRows } =
      await import("../../../apps/gateway/src/rollups")
    const repository = createDbRollupRepository(f.db)
    const compact = () =>
      repository.transaction(async (store) => {
        const hour = new Date("2026-06-01T13:00:00.000Z"),
          batch = await store.aggregateRawHour(hour, 100)
        await store.upsertRollups(buildRollupRows("hour", hour, batch.groups))
        await store.deleteRawIds(batch.ids)
      })
    await assert.rejects(
      compact(),
      (error) => error instanceof GatewayUsageError && error.code === "pending_recovery_required",
    )
    assert.equal((await f.db.select().from(Log).where(eq(Log.id, row.id))).length, 1)
    const input = {
      actor: f.admin,
      requestIds: [row.openwork_request_id],
      abandonedBefore: "2026-06-02T00:00:00.000Z",
      reviewReference: "INTERNAL-LEGACY",
      apply: true,
    }
    await recoverGatewayUsageRequests(f.db, input)
    await compact()
    assert.equal((await f.db.select().from(Log).where(eq(Log.id, row.id))).length, 0)
    assert.equal(
      (await f.db.select().from(T).where(eq(T.memberId, f.member.memberId)))[0].pendingRequests,
      0,
    )
    assert.equal(
      (await f.db.select().from(E).where(eq(E.id, row.openwork_request_id)))[0].costMicroUsd,
      null,
    )
  },
)

dbTest(
  "explicit suspend/resume rotates capture version, fences stale starts and preserves spend without false completeness",
  async () => {
    const f = await fixture()
    await f.assigned()
    await f.spend(8)
    f.setTime("2026-10-05T06:00:00.000Z")
    await f.spend(3)
    const before = await f.service.getStatus(f.member)
    assert.equal(before.coverage.complete, true)
    const stale = f.raw(1),
      snapshot = (await f.service.admit(f.member, stale.openwork_request_id, true)).snapshot
    const input = {
      actor: f.admin,
      members: [{ memberId: f.member.memberId, expectedVersion: 1 }],
      action: "suspend",
      reviewReference: "INTERNAL-CUTOVER",
    } satisfies Parameters<typeof rotateGatewayUsageEpoch>[1]
    const preview = await observed(() => rotateGatewayUsageEpoch(f.db, input))
    assertReadOnly(preview.queries)
    const suspended = await rotateGatewayUsageEpoch(
      f.db,
      { ...input, apply: true },
      () => new Date("2026-10-05T06:01:00.000Z"),
    )
    assert.equal(suspended.results[0].epochVersion, 2)
    assert.equal((await f.service.admit(f.member, randomUUID(), true)).accountingUnavailable, true)
    await assert.rejects(rotateGatewayUsageEpoch(f.db, { ...input, action: "resume", apply: true }))
    await rotateGatewayUsageEpoch(
      f.db,
      {
        ...input,
        action: "resume",
        members: [{ memberId: f.member.memberId, expectedVersion: 2 }],
        apply: true,
      },
      () => new Date("2026-10-05T06:02:00.000Z"),
    )
    assert.equal((await f.service.getStatus(f.member)).coverage.trackingVersion, 3)
    assert.equal((await f.service.getStatus(f.member)).coverage.complete, false)
    assert.deepEqual(
      (await f.service.getStatus(f.member)).buckets.map((b) => b.usedMicroUsd),
      [3, 3, 3],
    )
    await assert.rejects(
      f.db.transaction((tx) =>
        startGatewayUsageLog(tx, {
          ...stale,
          completed_at: null,
          metadata: { gateway_usage: snapshot },
        }),
      ),
      (error) => error instanceof GatewayUsageError && error.code === "capture_epoch_changed",
    )
    f.setTime("2026-10-05T06:03:00.000Z")
    await f.spend(1)
    assert.equal((await f.service.getStatus(f.member)).coverage.complete, false)
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 4)
  },
)

dbTest(
  "operator CLI previews privately, refuses reused output before writes, and applies an explicit epoch version",
  async () => {
    assert.ok(url)
    const f = await fixture()
    await f.prepare(1)
    const folder = await mkdtemp(join(tmpdir(), "gateway-usage-operator-")),
      manifest = join(folder, "manifest.json"),
      preview = join(folder, "preview.json"),
      applied = join(folder, "applied.json")
    const input = {
      operation: "suspend",
      actor: f.admin,
      members: [{ memberId: f.member.memberId, expectedVersion: 1 }],
      reviewReference: "INTERNAL-CLI",
    }
    const run = (output: string, apply = false) =>
      promisify(execFile)(
        "pnpm",
        [
          "exec",
          "tsx",
          "--conditions=development",
          "scripts/gateway-usage-operations.ts",
          "--manifest",
          manifest,
          "--output",
          output,
          ...(apply ? ["--apply"] : []),
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            OPENWORK_DEN_DB_ENV_PATH: "/dev/null",
            DEN_USAGE_OPERATIONS_DATABASE_URL: url,
          },
          encoding: "utf8",
        },
      )
    try {
      await writeFile(manifest, JSON.stringify(input), { mode: 0o600 })
      const first = await run(preview)
      assert.equal(first.stdout.includes(f.member.memberId), false)
      assert.equal(first.stdout.includes(f.admin.organizationId), false)
      assert.equal((await stat(preview)).mode & 0o777, 0o600)
      assert.equal((await f.service.getStatus(f.member)).coverage.captureEnabled, true)
      await assert.rejects(run(preview, true))
      assert.equal((await f.service.getStatus(f.member)).coverage.trackingVersion, 1)
      await run(applied, true)
      const output: unknown = JSON.parse(await readFile(applied, "utf8"))
      assert.ok(record(output))
      assert.equal(output.applied, true)
      assert.equal((await f.service.getStatus(f.member)).coverage.captureEnabled, false)
      assert.equal((await f.service.getStatus(f.member)).coverage.trackingVersion, 2)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  },
)

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) =>
    Number((sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(2))
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) }
}
async function latencyProxy() {
  assert.ok(url)
  const target = new URL(url),
    sockets = new Set<Socket>()
  const upstreamPort = Number(target.port)
  const server = createServer((downstream) => {
    const upstream = connect({ host: target.hostname, port: upstreamPort })
    downstream.setNoDelay(true)
    upstream.setNoDelay(true)
    sockets.add(downstream)
    sockets.add(upstream)
    downstream.on("data", (data) => {
      setTimeout(() => {
        if (!upstream.destroyed) upstream.write(new Uint8Array(data))
      }, 2)
    })
    upstream.on("data", (data) => {
      setTimeout(() => {
        if (!downstream.destroyed) downstream.write(new Uint8Array(data))
      }, 2)
    })
    downstream.on("close", () => upstream.destroy())
    upstream.on("close", () => downstream.destroy())
    downstream.on("error", () => upstream.destroy())
    upstream.on("error", () => downstream.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  target.port = String(address.port)
  const client = mysql.createPool({
    ...localConnectionConfig(target.toString()),
    connectionLimit: 10,
  })
  const writerClient = mysql.createPool({
    ...localConnectionConfig(target.toString()),
    connectionLimit: 10,
  })
  return {
    db: database(client),
    writeDb: database(writerClient),
    async close() {
      try {
        await client.end()
        await writerClient.end()
      } catch {
        console.log("benchmark proxy pool already disconnected during teardown")
      } finally {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  }
}

dbTest(
  "measured concurrent seeded-history workload with optional 2ms per-direction TCP delay",
  async () => {
    const f = await fixture()
    const members = [
      f.member,
      ...(await Promise.all(Array.from({ length: 7 }, () => f.addMember()))),
    ]
    const p = await f.assigned({ ...f.body, hardLimit: false })
    for (const member of members.slice(1))
      await f.service.assign(f.admin, p.id, { memberId: member.memberId })
    for (let batch = 0; batch < 20; batch++)
      await f.db.insert(Log).values(Array.from({ length: 500 }, () => f.raw(10)))
    for (const member of members) await f.spend(1, member)
    const proxy = await latencyProxy()
    assert.ok(url)
    const writerPool = mysql.createPool({ ...localConnectionConfig(url), connectionLimit: 10 })
    try {
      for (const [label, readDb, writeDb] of [
        ["loopback_split_pool10", f.db, database(writerPool)],
        ["tcp_delay_2ms_each_direction_split_pool10", proxy.db, proxy.writeDb],
      ] satisfies [string, GatewayUsageDb, GatewayUsageDb][]) {
        const service = createGatewayUsageLimits(readDb, () => new Date("2026-09-15T12:00:00Z"))
        const writer = createGatewayUsageLimits(writeDb, () => new Date("2026-09-15T12:00:00Z"))
        const queue = createUsageWriteQueue(8)
        const results: Record<string, { ms: number[]; queries: number[] }> = {
          admit: { ms: [], queries: [] },
          status: { ms: [], queries: [] },
          settle: { ms: [], queries: [] },
        }
        for (let batch = 0; batch < 12; batch++) {
          const rows = await Promise.all(
            members.map((member) => f.prepare(2, member, { db: writeDb, queue })),
          )
          await Promise.all(
            members.flatMap((member, i) =>
              [
                ["admit", () => service.admit(member, randomUUID(), true)],
                ["status", () => service.getStatus(member)],
                [
                  "settle",
                  () =>
                    queue.settle(rows[i].org_membership_id, rows[i].openwork_request_id, () =>
                      writer.record(rows[i]),
                    ),
                ],
              ].map(async ([kind, run]) => {
                assert.equal(typeof kind, "string")
                assert.equal(typeof run, "function")
                if (typeof kind !== "string" || typeof run !== "function")
                  throw new Error("Invalid benchmark operation")
                const measurement = await observed<unknown>(run)
                if (kind !== "settle") assertReadOnly(measurement.queries)
                results[kind].ms.push(measurement.ms)
                results[kind].queries.push(measurement.queries.length)
              }),
            ),
          )
        }
        console.log(
          JSON.stringify({
            benchmark: label,
            rawHistory: 10000,
            members: 8,
            concurrency: 24,
            readPool: 10,
            writePool: 10,
            writerConcurrency: 8,
            operations: Object.fromEntries(
              Object.entries(results).map(([kind, data]) => [
                kind,
                {
                  n: data.ms.length,
                  latencyMs: percentiles(data.ms),
                  sqlCount: percentiles(data.queries),
                },
              ]),
            ),
          }),
        )
      }
    } finally {
      await writerPool.end()
      await proxy.close()
    }
  },
)

dbTest(
  "exact pool-10 burst: one held member bucket cannot consume admission connections or starve other writers",
  async () => {
    assert.ok(url)
    const f = await fixture()
    const others = await Promise.all(Array.from({ length: 4 }, () => f.addMember()))
    const policy = await f.assigned({ ...f.body, hardLimit: false })
    for (const member of others)
      await f.service.assign(f.admin, policy.id, { memberId: member.memberId })
    for (let batch = 0; batch < 20; batch++)
      await f.db.insert(Log).values(Array.from({ length: 500 }, () => f.raw(1)))
    await f.spend(1)
    const held = (await f.service.getStatus(f.member)).buckets[0]
    const writerPool = mysql.createPool({ ...localConnectionConfig(url), connectionLimit: 10 })
    const writeDb = database(writerPool)
    const writer = createGatewayUsageLimits(writeDb, () => new Date("2026-09-15T12:00:00.000Z"))
    const queue = createUsageWriteQueue(8)
    const blockedRows: Awaited<ReturnType<typeof f.prepare>>[] = [],
      otherRows: Awaited<ReturnType<typeof f.prepare>>[] = []
    for (let i = 0; i < 40; i++)
      blockedRows.push(await f.prepare(1, f.member, { db: writeDb, queue }))
    for (const member of others)
      for (let i = 0; i < 8; i++) otherRows.push(await f.prepare(2, member, { db: writeDb, queue }))
    const fresh = await Promise.all(
      [
        ...Array.from({ length: 8 }, () => f.member),
        ...others.flatMap((member) => Array.from({ length: 5 }, () => member)),
      ].map(async (member) => {
        const row = f.raw(1, member)
        const admission = await f.service.admit(member, row.openwork_request_id, true)
        return { ...row, metadata: { ...row.metadata, gateway_usage: admission.snapshot } }
      }),
    )
    let blocked: Promise<unknown>[] = []
    const measurements: Record<string, { ms: number[]; queries: number[] }> = {
      admit: { ms: [], queries: [] },
      status: { ms: [], queries: [] },
      settle: { ms: [], queries: [] },
      start: { ms: [], queries: [] },
    }
    try {
      await whileLocked(
        (tx) =>
          tx
            .update(B)
            .set({ usedMicroUsd: sql`${B.usedMicroUsd}` })
            .where(eq(B.id, held.id)),
        async () => {
          blocked = blockedRows.map((row) =>
            queue.settle(row.org_membership_id, row.openwork_request_id, () => writer.record(row)),
          )
          const start = (row: (typeof fresh)[number]) =>
            writeDb.transaction((tx) =>
              startGatewayUsageLog(
                tx,
                { ...row, completed_at: null, cost_micro_usd: null },
                row.started_at,
              ),
            )
          blocked.push(
            ...fresh
              .filter((row) => row.org_membership_id === f.member.memberId)
              .map((row) =>
                queue.start(row.org_membership_id, row.openwork_request_id, () => start(row)),
              ),
          )
          const starts = fresh
            .filter((row) => row.org_membership_id !== f.member.memberId)
            .map(async (row) => {
              const result = await observed(() =>
                queue.start(row.org_membership_id, row.openwork_request_id, () => start(row)),
              )
              measurements.start.ms.push(result.ms)
              measurements.start.queries.push(result.queries.length)
              await queue.settle(row.org_membership_id, row.openwork_request_id, () =>
                writer.record(row),
              )
            })
          const writes = otherRows.map(async (row) => {
            const result = await observed(() =>
              queue.settle(row.org_membership_id, row.openwork_request_id, () =>
                writer.record(row),
              ),
            )
            measurements.settle.ms.push(result.ms)
            measurements.settle.queries.push(result.queries.length)
          })
          const reads = others
            .flatMap((member) =>
              Array.from({ length: 20 }, (_, i) => ({ member, kind: i % 2 ? "admit" : "status" })),
            )
            .map(async ({ member, kind }) => {
              const result = await observed<unknown>(() =>
                kind === "admit"
                  ? f.service.admit(member, randomUUID(), true)
                  : f.service.getStatus(member),
              )
              assertReadOnly(result.queries)
              measurements[kind].ms.push(result.ms)
              measurements[kind].queries.push(result.queries.length)
            })
          await Promise.all([...reads, ...writes, ...starts])
          assert.equal(queue.state().activeMembers, 1)
          assert.ok(queue.state().queued >= 39)
          assert.ok(queue.state().active <= 8)
          console.log(
            JSON.stringify({
              benchmark: "held_member_pool10",
              readPool: 10,
              writePool: 10,
              writerConcurrency: 8,
              blockedMemberReceipts: 40,
              rawHistory: 10000,
              operations: Object.fromEntries(
                Object.entries(measurements).map(([kind, data]) => [
                  kind,
                  {
                    n: data.ms.length,
                    latencyMs: percentiles(data.ms),
                    sqlCount: percentiles(data.queries),
                  },
                ]),
              ),
            }),
          )
        },
      )
      await Promise.all(blocked)
      assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 41)
      await Promise.all(
        fresh
          .filter((row) => row.org_membership_id === f.member.memberId)
          .map((row) =>
            queue.settle(row.org_membership_id, row.openwork_request_id, () => writer.record(row)),
          ),
      )
    } finally {
      await Promise.allSettled(blocked)
      await writerPool.end()
    }
  },
)

dbTest(
  "production pool-10 start overload is bounded/cancellable while reserved known-cost settlement and other members continue",
  async () => {
    assert.ok(url)
    const f = await fixture(),
      other = await f.addMember()
    await f.assigned({ ...f.body, hardLimit: false })
    await f.spend(1)
    const writePool = mysql.createPool({ ...localConnectionConfig(url), connectionLimit: 10 }),
      writeDb = database(writePool)
    const queue = createUsageWriteQueue(8),
      writer = createGatewayUsageLimits(writeDb, () => new Date("2026-09-15T12:00:00.000Z"))
    const held = (await f.service.getStatus(f.member)).buckets[0]
    const a = await f.prepare(1, f.member, { db: writeDb, queue }),
      b = await f.prepare(17, other, { db: writeDb, queue })
    await assert.rejects(
      queue.settle(other.memberId, b.openwork_request_id, () => {
        throw new Error("synthetic pre-write failure")
      }),
    )
    assert.equal(queue.state().reservations, 2)
    const snapshotA = (await f.service.admit(f.member, randomUUID(), true)).snapshot
    const extra = await Promise.all(Array.from({ length: 9 }, () => f.addMember()))
    const snapshots = await Promise.all(
      extra.map(async (member) => ({
        member,
        snapshot: (await f.service.admit(member, randomUUID(), true)).snapshot,
      })),
    )
    const hits = new Set<string>(),
      cancelledQueued = new Set<string>()
    const write = (row: typeof Log.$inferInsert, signal?: AbortSignal) => {
      hits.add(row.openwork_request_id)
      return writeDb.transaction((tx) =>
        startGatewayUsageLog(
          tx,
          { ...row, completed_at: null, cost_micro_usd: null },
          row.started_at,
          signal,
        ),
      )
    }
    let blocked: Promise<boolean> | undefined
    const readLatency: number[] = [],
      startLatency: number[] = [],
      settlementLatency: number[] = []
    try {
      await whileLocked(
        (tx) =>
          tx
            .update(B)
            .set({ usedMicroUsd: sql`${B.usedMicroUsd}` })
            .where(eq(B.id, held.id)),
        async () => {
          blocked = queue.settle(f.member.memberId, a.openwork_request_id, () => writer.record(a))
          const controllers: AbortController[] = [],
            results: Promise<string>[] = []
          for (let i = 0; i < 200; i++) {
            const row = { ...f.raw(1), metadata: { gateway_usage: snapshotA } },
              controller = new AbortController()
            controllers.push(controller)
            const before = queue.state().reservations
            const result = queue.start(
              f.member.memberId,
              row.openwork_request_id,
              () => write(row, controller.signal),
              controller.signal,
            )
            if (queue.state().reservations > before) cancelledQueued.add(row.openwork_request_id)
            results.push(
              result.then(
                () => "started",
                (error: unknown) => {
                  if (error instanceof UsageWriteAdmissionError) return error.code
                  throw error
                },
              ),
            )
          }
          assert.equal(queue.state().queuedStarts, 8)
          const fresh = f.raw(13, other)
          fresh.metadata = {
            gateway_usage: (await f.service.admit(other, fresh.openwork_request_id, true)).snapshot,
          }
          const start = performance.now()
          await queue.start(other.memberId, fresh.openwork_request_id, () => write(fresh))
          startLatency.push(performance.now() - start)
          const settled = performance.now()
          await queue.settle(other.memberId, fresh.openwork_request_id, () => writer.record(fresh))
          settlementLatency.push(performance.now() - settled)
          await Promise.all(
            Array.from({ length: 40 }, async (_, i) => {
              const began = performance.now()
              if (i % 2) await f.service.getStatus(other)
              else await f.service.admit(other, randomUUID(), true)
              readLatency.push(performance.now() - began)
            }),
          )
          controllers.forEach((controller) => controller.abort())
          const outcomes = await Promise.all(results)
          assert.equal(outcomes.filter((value) => value === "usage_start_capacity").length, 192)
          assert.equal(outcomes.filter((value) => value === "usage_start_cancelled").length, 8)
          for (const id of cancelledQueued) assert.equal(hits.has(id), false)
          assert.equal(
            (
              await f.db
                .select()
                .from(E)
                .where(inArray(E.id, [...cancelledQueued]))
            ).length,
            0,
          )
          assert.equal(
            (await f.db.select().from(T).where(eq(T.memberId, f.member.memberId)))[0]
              .pendingRequests,
            1,
          )
          const deadlineRow = { ...f.raw(1), metadata: { gateway_usage: snapshotA } }
          const deadline = performance.now()
          await assert.rejects(
            queue.start(f.member.memberId, deadlineRow.openwork_request_id, () =>
              write(deadlineRow),
            ),
            (error) =>
              error instanceof UsageWriteAdmissionError && error.code === "usage_start_deadline",
          )
          assert.equal(hits.has(deadlineRow.openwork_request_id), false)
          const deadlineMs = performance.now() - deadline
          const globalControllers: AbortController[] = [],
            globalResults: Promise<string>[] = [],
            globalQueued = new Set<string>()
          for (let i = 0; i < 200; i++) {
            const target = snapshots[i % snapshots.length],
              row = { ...f.raw(1, target.member), metadata: { gateway_usage: target.snapshot } },
              controller = new AbortController()
            globalControllers.push(controller)
            const before = queue.state().reservations
            const result = queue.start(
              target.member.memberId,
              row.openwork_request_id,
              () => write(row, controller.signal),
              controller.signal,
            )
            if (queue.state().reservations > before && !hits.has(row.openwork_request_id))
              globalQueued.add(row.openwork_request_id)
            globalResults.push(
              result.then(
                () => "started",
                (error: unknown) => {
                  if (error instanceof UsageWriteAdmissionError) return error.code
                  if (controller.signal.aborted) return "active_cancelled"
                  throw error
                },
              ),
            )
          }
          const peak = queue.state()
          assert.equal(peak.queuedStarts, 64)
          assert.ok(peak.reservations <= 128)
          assert.ok(peak.active <= 8)
          assert.ok(peak.queued <= 128)
          const reserved = performance.now(),
            bSettlement = queue.settle(other.memberId, b.openwork_request_id, () =>
              writer.record(b),
            )
          globalControllers.forEach((controller) => controller.abort())
          await Promise.all(globalResults)
          assert.equal(await bSettlement, true)
          settlementLatency.push(performance.now() - reserved)
          for (const id of globalQueued) assert.equal(hits.has(id), false)
          assert.equal(
            (
              await f.db
                .select()
                .from(E)
                .where(inArray(E.id, [...globalQueued]))
            ).length,
            0,
          )
          assert.equal(
            (await f.db.select().from(T).where(eq(T.memberId, other.memberId)))[0].pendingRequests,
            0,
          )
          assert.equal(queue.state().queuedStarts, 0)
          assert.equal(queue.state().reservations, 1)
          console.log(
            JSON.stringify({
              benchmark: "bounded_cancelled_start_pool10",
              readPool: 10,
              writePool: 10,
              peak,
              rejectedMemberStarts: 192,
              cancelledMemberStarts: 8,
              deadlineMs,
              unrelatedReads: { n: readLatency.length, ...percentiles(readLatency) },
              unrelatedStarts: { n: startLatency.length, ...percentiles(startLatency) },
              reservedSettlements: {
                n: settlementLatency.length,
                ...percentiles(settlementLatency),
              },
            }),
          )
        },
        10000,
      )
      await blocked
      assert.equal(queue.state().reservations, 0)
    } finally {
      await blocked
      await writePool.end()
    }
  },
)

test("deadlock retries exclude ambiguous transport and lock-timeout failures", () => {
  assert.equal(isGatewayUsageDeadlock({ cause: { code: "ER_LOCK_DEADLOCK", errno: 1213 } }), true)
  assert.equal(isGatewayUsageDeadlock({ code: "ECONNRESET" }), false)
  assert.equal(isGatewayUsageDeadlock({ code: "ER_LOCK_WAIT_TIMEOUT", errno: 1205 }), false)
})
