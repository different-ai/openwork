// End-to-end hourly rollup pass against a real MySQL database. Skipped unless
// DEN_DB_MYSQL_TEST_URL points at a database with the den-db schema applied.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenDb, InferenceProviderOauthStateTable, InferenceRequestLogTable, InferenceUsageRollupTable } from "@openwork-ee/den-db"
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { InferenceRequestLogRow } from "../src/request-log.js"
import { HOUR_MS, createDbRollupRepository, rollupDimensionKey, runRollups } from "../src/rollups.js"

const mysqlUrl = process.env.DEN_DB_MYSQL_TEST_URL?.trim()
// code_verifier is an encrypted column; any 32+ char key works for this scratch data.
process.env.DEN_DB_ENCRYPTION_KEY ??= "local-dev-db-encryption-key-please-change-1234567890"

test("hourly pass aggregates and deletes raw rows in MySQL", { skip: !mysqlUrl, timeout: 60_000 }, async () => {
  assert.ok(mysqlUrl)
  const { db, client } = createDenDb({ databaseUrl: mysqlUrl, mode: "mysql" })
  const org = createDenTypeId("organization")
  const memberA = createDenTypeId("member")
  const memberB = createDenTypeId("member")
  const key = createDenTypeId("inferenceKey")
  const provider = createDenTypeId("inferenceProvider")
  // A unique, far-past hour so concurrent runs and leftovers do not collide.
  const bucketStart = new Date(Date.UTC(2001, 0, 1, 0, 0, 0) + Math.floor(Math.random() * 100_000) * HOUR_MS)
  const at = (offsetMs: number) => new Date(bucketStart.getTime() + offsetMs)

  const row = (overrides: Partial<InferenceRequestLogRow>): InferenceRequestLogRow => ({
    id: createDenTypeId("inferenceRequestLog"),
    organization_id: org,
    org_membership_id: memberA,
    inference_key_id: key,
    inference_provider_id: provider,
    inference_provider_credential_id: null,
    route: "org_provider",
    protocol: "anthropic_messages",
    upstream_provider_id: "anthropic",
    upstream_host: "api.anthropic.com",
    upstream_path: "/v1/messages",
    method: "POST",
    requested_model: "claude-a",
    upstream_model: "claude-a",
    stream: false,
    status: 200,
    outcome: "ok",
    error_code: null,
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    usage_source: "json",
    cost_micro_usd: 1000,
    upstream_request_id: null,
    openwork_request_id: createDenTypeId("inferenceRequestLog").slice(-24),
    started_at: at(60_000),
    first_byte_at: at(60_000 + 250),
    completed_at: at(60_000 + 1500),
    request_bytes: 10,
    response_bytes: 20,
    metadata: null,
    ...overrides,
  })

  const rows = [
    row({}),
    row({ started_at: at(120_000), first_byte_at: at(120_000 + 250), completed_at: at(120_000 + 1500), stream: true, cache_read_tokens: 30, cost_micro_usd: 2000 }),
    row({ started_at: at(180_000), org_membership_id: memberB, upstream_model: null, completed_at: null, first_byte_at: null, usage_source: "missing", input_tokens: null, output_tokens: null, total_tokens: null, cost_micro_usd: null }),
    // Next hour: must not be folded by a single-bucket run.
    row({ started_at: at(HOUR_MS + 60_000), first_byte_at: at(HOUR_MS + 60_000 + 250), completed_at: at(HOUR_MS + 60_000 + 1500) }),
  ]
  const oauthStateId = createDenTypeId("inferenceProviderOauthState")

  try {
    await db.insert(InferenceRequestLogTable).values(rows)
    await db.insert(InferenceProviderOauthStateTable).values({
      id: oauthStateId,
      inference_provider_id: provider,
      org_membership_id: memberA,
      state: `test-${oauthStateId}`,
      code_verifier: "verifier",
      redirect_to: null,
      expires_at: at(-HOUR_MS),
      used_at: null,
    })

    const repository = createDbRollupRepository(db)
    const now = at(3 * 24 * HOUR_MS)
    // Restrict candidates to our hour so the run ignores unrelated rows.
    const scoped = {
      ...repository,
      async listCandidateHourBuckets(before: Date, limit: number) {
        const buckets = await repository.listCandidateHourBuckets(before, 10_000)
        return buckets.filter((bucket) => bucket.getTime() === bucketStart.getTime()).slice(0, limit)
      },
      async listCandidateDayBuckets() {
        return []
      },
    }
    const summary = await runRollups({ repository: scoped, now, maxBucketsPerRun: 1 })
    assert.equal(summary.hourBuckets, 1)
    assert.equal(summary.rawRowsDeleted, 3)
    assert.ok(summary.oauthStatesDeleted >= 1)

    const remaining = await db.select({ id: InferenceRequestLogTable.id }).from(InferenceRequestLogTable)
      .where(eq(InferenceRequestLogTable.organization_id, org))
    assert.deepEqual(remaining.map((r) => r.id), [rows[3]?.id])

    const rollups = await db.select().from(InferenceUsageRollupTable)
      .where(and(eq(InferenceUsageRollupTable.organization_id, org), eq(InferenceUsageRollupTable.granularity, "hour")))
    assert.equal(rollups.length, 2)
    for (const rollup of rollups) assert.equal(rollup.bucket_start.getTime(), bucketStart.getTime())

    const a = rollups.find((r) => r.org_membership_id === memberA)
    assert.ok(a)
    assert.equal(a.request_count, 2)
    assert.equal(a.ok_count, 2)
    assert.equal(a.error_count, 0)
    assert.equal(a.aborted_count, 0)
    assert.equal(a.stream_count, 1)
    assert.equal(a.input_tokens, 200)
    assert.equal(a.output_tokens, 100)
    assert.equal(a.total_tokens, 300)
    assert.equal(a.cache_read_tokens, 30)
    assert.equal(a.cost_micro_usd, 3000)
    assert.equal(a.latency_ms_sum, 3000)
    assert.equal(a.ttfb_ms_sum, 500)
    assert.equal(a.request_bytes, 20)
    assert.equal(a.response_bytes, 40)
    assert.equal(a.source_row_count, 2)
    assert.equal(a.upstream_model, "claude-a")
    assert.equal(a.dimension_key, rollupDimensionKey(a))

    const b = rollups.find((r) => r.org_membership_id === memberB)
    assert.ok(b)
    assert.equal(b.request_count, 1)
    assert.equal(b.aborted_count, 1)
    assert.equal(b.ok_count, 0)
    assert.equal(b.usage_missing_count, 1)
    assert.equal(b.latency_ms_sum, 0)
    assert.equal(b.upstream_model, null)
    assert.equal(b.dimension_key, rollupDimensionKey(b))

    // Idempotent: re-running the same bucket (raw rows re-inserted) overwrites, never duplicates.
    await db.insert(InferenceRequestLogTable).values(rows.slice(0, 3).map((r) => ({ ...r, id: createDenTypeId("inferenceRequestLog"), openwork_request_id: createDenTypeId("inferenceRequestLog").slice(-24) })))
    const again = await runRollups({ repository: scoped, now, maxBucketsPerRun: 1 })
    assert.equal(again.rawRowsDeleted, 3)
    const rollupsAgain = await db.select().from(InferenceUsageRollupTable)
      .where(and(eq(InferenceUsageRollupTable.organization_id, org), eq(InferenceUsageRollupTable.granularity, "hour")))
    assert.equal(rollupsAgain.length, 2)
    assert.deepEqual(rollupsAgain.map((r) => r.id).sort(), rollups.map((r) => r.id).sort(), "existing rollup ids are kept")
    assert.equal(rollupsAgain.find((r) => r.org_membership_id === memberA)?.cost_micro_usd, 3000)

    // Daily pass: the two hour rows fold into two day rows (one per dimension) and are deleted.
    const dayStart = new Date(Math.floor(bucketStart.getTime() / (24 * HOUR_MS)) * 24 * HOUR_MS)
    const dayScoped = {
      ...repository,
      async listCandidateHourBuckets() {
        return []
      },
      async listCandidateDayBuckets(before: Date, limit: number) {
        const buckets = await repository.listCandidateDayBuckets(before, 10_000)
        return buckets.filter((bucket) => bucket.getTime() === dayStart.getTime()).slice(0, limit)
      },
    }
    const daySummary = await runRollups({ repository: dayScoped, now: at(91 * 24 * HOUR_MS), maxBucketsPerRun: 1 })
    assert.equal(daySummary.dayBuckets, 1)
    assert.equal(daySummary.hourRowsDeleted, 2)
    const dayRows = await db.select().from(InferenceUsageRollupTable).where(eq(InferenceUsageRollupTable.organization_id, org))
    assert.equal(dayRows.length, 2)
    for (const dayRow of dayRows) {
      assert.equal(dayRow.granularity, "day")
      assert.equal(dayRow.bucket_start.getTime(), dayStart.getTime())
    }
    const dayA = dayRows.find((r) => r.org_membership_id === memberA)
    assert.ok(dayA)
    assert.equal(dayA.request_count, 2)
    assert.equal(dayA.cost_micro_usd, 3000)
    assert.equal(dayA.latency_ms_sum, 3000)
    assert.equal(dayA.source_row_count, 2)
    assert.equal(dayA.dimension_key, a.dimension_key)

    const oauth = await db.select({ id: InferenceProviderOauthStateTable.id }).from(InferenceProviderOauthStateTable)
      .where(eq(InferenceProviderOauthStateTable.id, oauthStateId))
    assert.equal(oauth.length, 0)
  } finally {
    await db.delete(InferenceRequestLogTable).where(eq(InferenceRequestLogTable.organization_id, org))
    await db.delete(InferenceUsageRollupTable).where(eq(InferenceUsageRollupTable.organization_id, org))
    await db.delete(InferenceProviderOauthStateTable).where(inArray(InferenceProviderOauthStateTable.id, [oauthStateId]))
    if ("end" in client) await client.end()
  }
})
