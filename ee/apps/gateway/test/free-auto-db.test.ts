import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { z } from "zod"
import {
  createDenDb, AuthUserTable, OrganizationTable, MemberTable, InferenceKeyTable, AnonymousInferenceIdentityTable,
  InferenceFreeUsageBucketTable as Bucket, InferenceFreeUsageTable as Usage,
  AnonymousInferenceUsageBucketTable as GuestBucket, AnonymousInferenceUsageTable as GuestUsage,
  InferenceOrgUsageBucketTable, InferenceUsageLedgerEntryTable, OrgSubscriptionTable, DesktopPolicyTable, DesktopPolicyMemberTable, TeamTable, TeamMemberTable,
} from "@openwork-ee/den-db"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { freeInferenceWindow, INFERENCE_FREE_MODEL_ID, INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import { readAutoConfig } from "../src/free/shared/config.js"
import { rampedDeviceAmount } from "@openwork/free-auto/accounting"
import type { FreePrincipal, GuestPrincipal } from "../src/free/shared/principal.js"
import type { FreeUsageReceipt } from "../src/free/shared/allowance.js"

const adminUrl = process.env.FREE_AUTO_MYSQL_TEST_URL
if (adminUrl) {
  const parsed = new URL(adminUrl)
  if (process.env.FREE_AUTO_MYSQL_TEST_ISOLATED !== "1" || parsed.protocol !== "mysql:"
    || !["127.0.0.1", "localhost"].includes(parsed.hostname) || !["", "/", "/mysql"].includes(parsed.pathname)
    || parsed.search || parsed.hash) throw new Error("Use an explicitly isolated loopback MySQL administrative URL without a target database.")
}
const tableSchema = z.object({ name: z.string(), columns: z.record(z.string(), z.object({
  name: z.string(), type: z.string(), notNull: z.boolean(), primaryKey: z.boolean(), autoincrement: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
})), indexes: z.record(z.string(), z.object({ name: z.string(), columns: z.array(z.string()), isUnique: z.boolean() })),
  compositePrimaryKeys: z.record(z.string(), z.object({ name: z.string(), columns: z.array(z.string()) })),
  uniqueConstraints: z.record(z.string(), z.object({ name: z.string(), columns: z.array(z.string()) })),
  foreignKeys: z.record(z.string(), z.unknown()), checkConstraint: z.record(z.string(), z.unknown()),
})
const snapshotSchema = z.object({ tables: z.record(z.string(), tableSchema) })
function identifier(value: string) {
  assert.match(value, /^[a-zA-Z0-9_]+$/)
  return `\`${value}\``
}
function baselineSql(table: z.infer<typeof tableSchema>) {
  assert.deepEqual(table.foreignKeys, {})
  assert.deepEqual(table.checkConstraint, {})
  const definitions = Object.values(table.columns).map((column) => `${identifier(column.name)} ${column.type}${column.notNull ? " NOT NULL" : ""}${column.default !== undefined ? ` DEFAULT ${column.default === null ? "NULL" : String(column.default)}` : ""}${column.primaryKey ? " PRIMARY KEY" : ""}${column.autoincrement ? " AUTO_INCREMENT" : ""}`)
  for (const key of Object.values(table.compositePrimaryKeys)) definitions.push(`PRIMARY KEY (${key.columns.map(identifier).join(",")})`)
  for (const key of Object.values(table.uniqueConstraints)) definitions.push(`UNIQUE KEY ${identifier(key.name)} (${key.columns.map(identifier).join(",")})`)
  for (const index of Object.values(table.indexes)) definitions.push(`${index.isUnique ? "UNIQUE " : ""}KEY ${identifier(index.name)} (${index.columns.map(identifier).join(",")})`)
  return `CREATE TABLE ${identifier(table.name)} (${definitions.join(",")}) ENGINE=InnoDB`
}
function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value))
  return value.map((row: unknown) => {
    assert.ok(row !== null && typeof row === "object" && !Array.isArray(row))
    return Object.fromEntries(Object.entries(row))
  })
}

test("free Auto SQL and 0116 upgrade in an owned random database", { skip: !adminUrl, timeout: 60000 }, async (t) => {
  assert.ok(adminUrl)
  const databaseName = `free_auto_test_${randomBytes(12).toString("hex")}`
  assert.match(databaseName, /^free_auto_test_[a-f0-9]{24}$/)
  const administrative = createDenDb({ mode: "mysql", databaseUrl: adminUrl })
  const admin = administrative.client
  assert.ok("end" in admin)
  let created = false
  const close: Array<() => Promise<void>> = []
  t.after(async () => {
    const closures = await Promise.allSettled(close.map((end) => end()))
    try {
      if (created) {
        await admin.query(`DROP DATABASE ${identifier(databaseName)}`)
        const [remaining] = await admin.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [databaseName])
        assert.deepEqual(records(remaining), [])
        t.diagnostic(`Dropped and verified removal of owned database ${databaseName}`)
      }
      assert.ok(closures.every((result) => result.status === "fulfilled"), "all owned application pools close")
    } finally { await admin.end() }
  })
  await admin.query(`CREATE DATABASE ${identifier(databaseName)}`)
  created = true
  const url = new URL(adminUrl)
  url.pathname = `/${databaseName}`
  process.env.DATABASE_URL = url.href
  process.env.DB_MODE = "mysql"
  process.env.OPENWORK_DEV_MODE = "1"
  process.env.GATEWAY_ENABLED = "false"
  process.env.DEN_DB_ENCRYPTION_KEY = "free-auto-sql-fixture-encryption-key-0000000000"
  process.env.BETTER_AUTH_SECRET = "free-auto-sql-fixture-auth-secret-000000000000"
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
  process.env.INFERENCE_FREE_ENABLED = "true"
  process.env.INFERENCE_FREE_WEEKLY_BUDGET_USD = "5"
  const application = createDenDb({ mode: "mysql", databaseUrl: url.href })
  const replica = createDenDb({ mode: "mysql", databaseUrl: url.href })
  const connection = application.client
  const otherConnection = replica.client
  assert.ok("end" in connection && "end" in otherConnection)
  close.push(() => connection.end(), () => otherConnection.end())
  const db = application.db
  const rows = async (statement: string, values: unknown[] = []) => records((await connection.query(statement, values))[0])
  const before = snapshotSchema.parse(JSON.parse(await readFile(new URL("../../../packages/den-db/drizzle/meta/0115_snapshot.json", import.meta.url), "utf8")))
  const after = snapshotSchema.parse(JSON.parse(await readFile(new URL("../../../packages/den-db/drizzle/meta/0116_snapshot.json", import.meta.url), "utf8")))
  const baseline = ["user", "organization", "member", "org_subscriptions", "gateway_providers", "inference_keys", "inference_org_limit_policies", "inference_org_usage_buckets", "inference_usage_ledger_entries", "inference_usage_ledger_bucket_charges", "gateway_request_logs", "gateway_usage_rollups", "desktop_policy", "desktop_policy_member", "team", "team_member"]
  for (const name of baseline) await connection.query(baselineSql(before.tables[name]))
  await connection.query("INSERT INTO gateway_providers (id,organization_id,created_by_org_membership_id,provider_id,name,model_ids,provider_config,settings) VALUES ('old-provider','org-fixture','member-fixture','fixture','Existing provider',JSON_ARRAY('kept-model'),JSON_OBJECT(),JSON_OBJECT())")
  await t.test("0116 executes over 0115 table shapes and preserves old rows with empty default pins", async () => {
    const migration = await readFile(new URL("../../../packages/den-db/drizzle/0116_free_auto_and_provider_pins.sql", import.meta.url), "utf8")
    const statements = migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)
    assert.equal(statements.length, 15)
    for (const statement of statements) await connection.query(statement)
    const added = Object.keys(after.tables).filter((name) => !before.tables[name]).sort()
    // Usage windows, one usage record per request, machine identities, proof signatures, and the new-machine counter. No holds, no control row.
    assert.deepEqual(added, ["anonymous_inference_identities", "anonymous_inference_rate_buckets", "anonymous_inference_usage", "anonymous_inference_usage_buckets",
      "desktop_free_proof_nonces", "inference_free_usage", "inference_free_usage_buckets"])
    for (const name of added) {
      const columns = await rows("SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION", [name])
      assert.deepEqual(columns, Object.values(after.tables[name].columns).map((column) => ({ name: column.name, nullable: column.notNull ? "NO" : "YES" })))
      const indexes = await rows("SELECT INDEX_NAME AS name, COLUMN_NAME AS col, NON_UNIQUE AS nonUnique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY BINARY INDEX_NAME, SEQ_IN_INDEX", [name])
      const expected = [
        ...Object.values(after.tables[name].compositePrimaryKeys).flatMap((key) => key.columns.map((col) => ({ name: "PRIMARY", col, nonUnique: 0 }))),
        ...Object.values(after.tables[name].uniqueConstraints).flatMap((key) => key.columns.map((col) => ({ name: key.name, col, nonUnique: 0 }))),
        ...Object.values(after.tables[name].indexes).flatMap((key) => key.columns.map((col) => ({ name: key.name, col, nonUnique: key.isUnique ? 0 : 1 }))),
      ].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      assert.deepEqual(indexes, expected, `${name} indexes match generated 0116 snapshot`)
    }
    // Guests have no account: nothing in their tables can point at an organization, member, user or key.
    const guestColumns = await rows("SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND (TABLE_NAME LIKE 'anonymous_inference_%' OR TABLE_NAME='desktop_free_proof_nonces')")
    assert.ok(guestColumns.length > 0)
    assert.deepEqual(guestColumns.filter((column) => /organization|member|user|key_id/.test(String(column.name))), [])
    await connection.query("INSERT INTO gateway_providers (id,organization_id,created_by_org_membership_id,provider_id,name,provider_config,settings) VALUES ('new-provider','org-fixture','member-fixture','fixture','New provider',JSON_OBJECT(),JSON_OBJECT())")
    assert.deepEqual(await rows("SELECT id, JSON_LENGTH(pinned_model_ids) AS pins FROM gateway_providers ORDER BY id"), [{ id: "new-provider", pins: 0 }, { id: "old-provider", pins: 0 }])
    assert.deepEqual(await rows("SELECT JSON_UNQUOTE(JSON_EXTRACT(model_ids,'$[0]')) AS model FROM gateway_providers WHERE id='old-provider'"), [{ model: "kept-model" }])
    t.diagnostic(`Applied ${statements.length} generated 0116 statements; verified seven new tables, every column/index, guest tables free of account references, and pin defaults`)
  })
  const { createFreeAllowanceStore } = await import("../src/free/shared/allowance.js")
  const { findMemberFreePrincipal, freePrincipalHash, memberFreePrincipalAllowed } = await import("../src/free/shared/principal.js")
  const gatewayDb = await import("../src/db.js")
  if ("end" in gatewayDb.client) { const client = gatewayDb.client; close.push(() => client.end()) }
  const { ensureMemberFreeInferenceCredential, getMemberInferenceAccess } = await import("../../den-api/src/inference.js")
  const denDb = await import("../../den-api/src/db.js")
  if ("end" in denDb.client) { const client = denDb.client; close.push(() => client.end()) }
  const config = readAutoConfig({})
  assert.equal(config.memberEnabled, false)
  assert.equal(config.anonymousEnabled, false)
  const store = createFreeAllowanceStore(config, "member", db)
  const otherStore = createFreeAllowanceStore(config, "member", replica.db)
  const guests = createFreeAllowanceStore(config, "anonymous", db)
  const otherGuests = createFreeAllowanceStore(config, "anonymous", replica.db)
  const id = () => randomUUID()
  const receipt = (amount = 100000): FreeUsageReceipt => ({ eventId: `chatcmpl-${id()}`, model: INFERENCE_FREE_MODEL_ID, amount, inputTokens: 10, outputTokens: 2 })
  // The raw key is stored encrypted, so match on the decrypted value.
  async function keyRow(apiKey: string) {
    const candidates = await db.select().from(InferenceKeyTable).where(eq(InferenceKeyTable.status, "active"))
    const match = candidates.find((candidate) => candidate.encrypted_key === apiKey)
    assert.ok(match)
    return match
  }
  async function person(userId?: typeof AuthUserTable.$inferSelect.id, metadata: Record<string, unknown> = { inferenceFree: { rolloutEnabled: true } }) {
    const organizationId = createDenTypeId("organization"), memberId = createDenTypeId("member")
    const user = userId ?? createDenTypeId("user")
    await db.insert(OrganizationTable).values({ id: organizationId, name: "Free SQL fixture", slug: randomUUID(), metadata })
    if (!userId) await db.insert(AuthUserTable).values({ id: user, name: "Fixture", email: `${user}@example.test` })
    await db.insert(MemberTable).values({ id: memberId, organizationId, userId: user, role: "member" })
    const input = { organizationId, memberId, userId: user }
    const credential = await ensureMemberFreeInferenceCredential(input)
    assert.ok(credential)
    assert.match(credential.apiKey, /^ow_inf_/)
    assert.equal(new URL(credential.baseURL).pathname, "/api/v1")
    const key = await keyRow(credential.apiKey)
    const principal = await findMemberFreePrincipal(key, db)
    assert.ok(principal)
    return { input, credential, key, principal }
  }
  const bucket = async (principal: FreePrincipal) => {
    const table = principal.kind === "member" ? Bucket : GuestBucket
    const [row] = await db.select().from(table).where(and(eq(table.identity_hash, freePrincipalHash(principal)), eq(table.window_start_at, freeInferenceWindow().start))).limit(1)
    return row ?? { used_amount: 0, limit_amount: null }
  }
  const admit = async (principal: FreePrincipal, pool = principal.kind === "member" ? store : guests) => {
    const result = await pool.admit(principal)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.ok)
    return result.windows
  }
  const charge = (principal: FreePrincipal, windows: import("../src/free/shared/allowance.js").FreeWindow[], usage: FreeUsageReceipt | null, requestId = id(),
    pool = principal.kind === "member" ? store : guests) => pool.charge({ requestId, principal, windows, receipt: usage })
  const sentinelOrg = createDenTypeId("organization"), sentinelMember = createDenTypeId("member")
  await db.insert(InferenceOrgUsageBucketTable).values({ id: createDenTypeId("inferenceOrgUsageBucket"), organization_id: sentinelOrg,
    policy_id: createDenTypeId("inferenceOrgLimitPolicy"), window_start_at: new Date(), window_end_at: new Date(Date.now() + 60000), limit_amount: 1000000, used_amount: 12345 })
  await db.insert(InferenceUsageLedgerEntryTable).values({ id: createDenTypeId("inferenceUsageLedgerEntry"), organization_id: sentinelOrg,
    org_membership_id: sentinelMember, external_job_id: "paid-sentinel", event_type: "openrouter_usage", cost_amount: 12345, occurred_at: new Date() })
  const paidBefore = { buckets: await rows("SELECT * FROM inference_org_usage_buckets"), ledger: await rows("SELECT * FROM inference_usage_ledger_entries") }

  await t.test("members get one OpenWork Models key; member and guest allowances live in separate tables ($5, and $1 ramped for guests)", async () => {
    const member = await person()
    const credentials = await Promise.all(Array.from({ length: 6 }, () => ensureMemberFreeInferenceCredential(member.input)))
    assert.ok(credentials.every((value) => value?.apiKey === member.credential.apiKey))
    assert.equal((await rows("SELECT COUNT(*) AS amount FROM inference_keys WHERE org_membership_id=? AND status='active'", [member.input.memberId]))[0].amount, 1)
    const stored = await rows("SELECT encrypted_key FROM inference_keys WHERE id=?", [member.key.id])
    assert.notEqual(stored[0].encrypted_key, member.credential.apiKey)
    assert.equal((await getMemberInferenceAccess(member.input)).weeklyLimitUsd, 5)
    const guest: GuestPrincipal = { kind: "installation", id: "a".repeat(64) }
    const [memberWindows, guestWindows] = await Promise.all([admit(member.principal), admit(guest)])
    assert.deepEqual(memberWindows.map((window) => [window.scope, window.window]), [["member", "weekly"]], "members have one window: their free weekly allowance")
    assert.deepEqual(guestWindows.map((window) => [window.scope, window.window]), [["installation", "weekly"], ["global", "daily"], ["global", "monthly"]])
    assert.equal((await rows("SELECT COUNT(*) AS amount FROM inference_free_usage_buckets"))[0].amount, 0, "admission writes nothing, like paid Models")
    const memberRequest = id(), guestRequest = id()
    assert.equal(await charge(member.principal, memberWindows, receipt(), memberRequest), true)
    assert.equal(await charge(guest, guestWindows, receipt(), guestRequest), true)
    assert.equal((await bucket(member.principal)).limit_amount, 5 * INFERENCE_USAGE_CONVERSION_FACTOR)
    assert.equal((await bucket(guest)).limit_amount, rampedDeviceAmount(config, 0), "a brand-new machine starts on the first ramp step")
    assert.equal((await rows("SELECT COUNT(*) AS amount FROM inference_free_usage WHERE request_id=?", [guestRequest]))[0].amount, 0)
    assert.equal((await rows("SELECT COUNT(*) AS amount FROM anonymous_inference_usage WHERE request_id=?", [memberRequest]))[0].amount, 0)
    assert.equal((await db.select().from(Usage).where(eq(Usage.request_id, memberRequest)))[0].inference_key_id, member.key.id)
    assert.equal((await store.read(member.principal)).allowance?.limitUsd, 5)
    assert.equal((await guests.read(guest)).allowance?.limitUsd, 0.1)
    assert.equal((await guests.admit(member.principal)).ok, false)
    assert.equal((await store.admit(guest)).ok, false)
  })

  await t.test("parallel requests from the same member all run and are each charged, across memberships and SQL pools", async () => {
    const first = await person(), same = await person(first.input.userId)
    const admitted = await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? otherStore : store).admit(index % 2 ? same.principal : first.principal)))
    assert.ok(admitted.every((result) => result.ok), JSON.stringify(admitted))
    const usages = admitted.map(() => receipt(1000))
    const charged = await Promise.all(admitted.map((result, index) => result.ok && charge(index % 2 ? same.principal : first.principal, result.windows, usages[index],
      id(), index % 2 ? otherStore : store)))
    assert.deepEqual(charged, Array(16).fill(true))
    assert.equal((await bucket(first.principal)).used_amount, 16000, "one weekly allowance per person, shared by both memberships")
    assert.equal((await rows("SELECT COUNT(*) AS amount FROM inference_free_usage WHERE principal_hash=?", [freePrincipalHash(first.principal)]))[0].amount, 16)
    const guest: GuestPrincipal = { kind: "installation", id: "c".repeat(64) }
    const guestAdmitted = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? otherGuests : guests).admit(guest)))
    assert.ok(guestAdmitted.every((result) => result.ok), "guests may run parallel requests too")
    const guestCharged = await Promise.all(guestAdmitted.map((result, index) => result.ok && charge(guest, result.windows, receipt(10), id(), index % 2 ? otherGuests : guests)))
    assert.deepEqual(guestCharged, Array(8).fill(true))
    assert.equal((await bucket(guest)).used_amount, 80)
  })

  await t.test("a completion is charged once, even when reported twice at the same time", async () => {
    const member = await person(), windows = await admit(member.principal)
    const usage = receipt(), requestId = id()
    const results = await Promise.all([charge(member.principal, windows, usage, requestId, store), charge(member.principal, windows, usage, requestId, otherStore)])
    assert.deepEqual(results.sort(), [false, true])
    assert.equal(await charge(member.principal, windows, usage, id()), false, "the same completion id under another request is not charged again")
    assert.equal(await charge(member.principal, windows, receipt(1), requestId), false, "a request is charged once")
    assert.equal((await bucket(member.principal)).used_amount, usage.amount)
    const [row] = await db.select().from(Usage).where(eq(Usage.request_id, requestId))
    assert.deepEqual([row.completion_id, row.amount, row.estimated], [usage.eventId, usage.amount, false])
  })

  await t.test("SQL settlement failures recover the original real charge, including after a client disconnects", async () => {
    const { dispatchFreeCompletion } = await import("../src/free/shared/dispatch.js")
    for (const family of ["member", "anonymous"] as const) {
      const principal: FreePrincipal = family === "member" ? (await person()).principal : { kind: "installation", id: "8".repeat(64) }
      const original = family === "member" ? store : guests
      const table = family === "member" ? "inference_free_usage" : "anonymous_inference_usage"
      let sawFailure: () => void = () => {}
      const failure = new Promise<void>((resolve) => { sawFailure = resolve })
      let attempts = 0
      const pool = { ...original, charge: async (input: Parameters<typeof original.charge>[0]) => {
        attempts++
        try { return await original.charge(input) } catch (error) { sawFailure(); throw error }
      } }
      await connection.query(`CREATE TRIGGER reject_free_settlement BEFORE INSERT ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture settlement failure'`)
      const controller = new AbortController()
      const eventId = `chatcmpl-${id()}`
      let consumed: Promise<unknown> | undefined
      try {
        const response = await dispatchFreeCompletion({ config, store: pool, principal, signal: controller.signal, controller,
          prepared: { body: "{}", stream: false }, fetch: async () => Response.json({ id: eventId, model: config.upstreamModel,
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "fixture" } }],
            usage: { prompt_tokens: 100, completion_tokens: 20 } }) })
        consumed = response.json().then((value) => value, (error: unknown) => error)
        await failure
        assert.equal((await rows(`SELECT COUNT(*) AS amount FROM ${table} WHERE completion_id=?`, [eventId]))[0].amount, 0)
        if (family === "anonymous") controller.abort()
        await connection.query("DROP TRIGGER reject_free_settlement")
        const result = await consumed
        if (family === "member") assert.equal((result as { model: string }).model, INFERENCE_FREE_MODEL_ID)
        else assert.ok(result instanceof Error, "the disconnected client does not receive a completed response")
        let usage: Record<string, unknown>[] = []
        for (let attempt = 0; attempt < 50; attempt++) {
          usage = await rows(`SELECT amount, estimated FROM ${table} WHERE completion_id=?`, [eventId])
          if (usage.length) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.deepEqual(usage, [{ amount: 4900, estimated: 0 }], "the known receipt is never replaced by an estimate")
        assert.equal((await bucket(principal)).used_amount, 4900)
        assert.ok(attempts >= 2)
      } finally {
        await connection.query("DROP TRIGGER IF EXISTS reject_free_settlement")
        await consumed
      }
    }
  })

  await t.test("a request whose usage never arrived is charged the fixed estimate", async () => {
    const member = await person(), windows = await admit(member.principal), requestId = id()
    assert.equal(await charge(member.principal, windows, null, requestId), true)
    assert.equal(await charge(member.principal, windows, { ...receipt(), model: "someone-else" }, id()), true, "an invalid report is treated as missing")
    assert.equal((await bucket(member.principal)).used_amount, 2 * config.unreportedUsageAmount)
    const [row] = await db.select().from(Usage).where(eq(Usage.request_id, requestId))
    assert.deepEqual([row.completion_id, row.amount, row.estimated], [null, config.unreportedUsageAmount, true])
  })

  await t.test("like paid Models, a window refuses only once its used total reaches the limit, and the real cost is always charged", async () => {
    const member = await person(), limit = config.member.weeklyLimitAmount
    const windows = await admit(member.principal)
    assert.equal(await charge(member.principal, windows, receipt(limit - 1)), true)
    const last = await admit(member.principal)
    assert.equal(await charge(member.principal, last, receipt(500000)), true, "the last request is charged in full, past the limit")
    assert.equal((await bucket(member.principal)).used_amount, limit - 1 + 500000)
    assert.deepEqual(await store.admit(member.principal), { ok: false, code: "anonymous_limit_exceeded" })
    assert.equal((await otherStore.read(member.principal)).state, "exhausted")
    const access = await getMemberInferenceAccess(member.input)
    assert.deepEqual([access.kind, access.reason, access.remainingUsd], ["exhausted", "free_allowance_exhausted", 0])
  })

  await t.test("the global daily and monthly caps stop guests, and only guests", async () => {
    const guest: GuestPrincipal = { kind: "installation", id: "d".repeat(64) }
    const windows = await admit(guest)
    const daily = windows.find((window) => window.scope === "global" && window.window === "daily")
    assert.ok(daily)
    await charge(guest, windows, receipt(1))
    await db.update(GuestBucket).set({ used_amount: config.globalDailyAmount }).where(eq(GuestBucket.id, daily.id))
    assert.deepEqual(await otherGuests.admit({ kind: "installation", id: "e".repeat(64) }), { ok: false, code: "anonymous_capacity_exceeded" })
    assert.equal((await guests.read(guest)).state, "unavailable")
    await admit((await person()).principal)
    await db.update(GuestBucket).set({ used_amount: 0 }).where(eq(GuestBucket.id, daily.id))
  })

  await t.test("untagged builds also get their IP's daily budget and a shared untagged cap; tagged guests on that IP are unaffected", async () => {
    const ipHash = "9".repeat(64)
    const untagged: GuestPrincipal = { kind: "installation", id: "u".repeat(64), untaggedIpHash: ipHash }
    const windows = await admit(untagged)
    assert.deepEqual(windows.map((window) => [window.scope, window.window, window.limit]), [
      ["installation", "weekly", rampedDeviceAmount(config, 0)], ["installation", "daily", config.untaggedIpDailyAmount],
      ["global", "daily", config.untaggedGlobalDailyAmount], ["global", "daily", config.globalDailyAmount], ["global", "monthly", config.globalMonthlyAmount],
    ])
    assert.equal((await guests.read(untagged)).allowance?.limitUsd, config.untaggedIpDailyAmount / INFERENCE_USAGE_CONVERSION_FACTOR, "status shows the daily IP budget")
    await charge(untagged, windows, receipt(1))
    const ipWindow = windows[1]
    assert.ok(ipWindow)
    await db.update(GuestBucket).set({ used_amount: config.untaggedIpDailyAmount }).where(eq(GuestBucket.id, ipWindow.id))
    // A new self-reported machine id on the same IP does not reset the budget.
    assert.deepEqual(await otherGuests.admit({ kind: "installation", id: "v".repeat(64), untaggedIpHash: ipHash }), { ok: false, code: "anonymous_limit_exceeded" })
    assert.equal((await guests.read(untagged)).state, "exhausted")
    assert.equal((await guests.admit({ kind: "installation", id: "u".repeat(64) })).ok, true, "a tagged proof from that machine is not held to the untagged budget")
    assert.equal((await guests.admit({ kind: "installation", id: "w".repeat(64), untaggedIpHash: "8".repeat(64) })).ok, true, "another IP has its own budget")
    const shared = windows[2]
    assert.ok(shared)
    await db.update(GuestBucket).set({ used_amount: config.untaggedGlobalDailyAmount }).where(eq(GuestBucket.id, shared.id))
    assert.deepEqual(await guests.admit({ kind: "installation", id: "x".repeat(64), untaggedIpHash: "7".repeat(64) }), { ok: false, code: "anonymous_capacity_exceeded" })
    assert.equal((await guests.admit({ kind: "installation", id: "y".repeat(64) })).ok, true, "the untagged cap never stops tagged guests")
    await db.update(GuestBucket).set({ used_amount: 0 }).where(eq(GuestBucket.id, shared.id))
  })

  await t.test("an open request (no desktop proof) has no device window and shares its IP's untagged budget", async () => {
    const ipHash = "6".repeat(64)
    const open: GuestPrincipal = { kind: "installation", id: "o".repeat(64), untaggedIpHash: ipHash, deviceless: true }
    const windows = await admit(open)
    assert.deepEqual(windows.map((window) => [window.scope, window.window, window.limit]), [
      ["installation", "daily", config.untaggedIpDailyAmount], ["global", "daily", config.untaggedGlobalDailyAmount],
      ["global", "daily", config.globalDailyAmount], ["global", "monthly", config.globalMonthlyAmount],
    ])
    assert.equal((await rows("SELECT COUNT(*) AS amount FROM anonymous_inference_identities WHERE id=?", [open.id]))[0].amount, 0, "no machine is recorded")
    await charge(open, windows, receipt(1))
    const ipWindow = windows[0]
    assert.ok(ipWindow)
    await db.update(GuestBucket).set({ used_amount: config.untaggedIpDailyAmount }).where(eq(GuestBucket.id, ipWindow.id))
    assert.deepEqual(await guests.admit({ kind: "installation", id: "z".repeat(64), untaggedIpHash: ipHash }), { ok: false, code: "anonymous_limit_exceeded" },
      "an untagged desktop on the same IP shares that budget")
    assert.equal((await guests.read(open)).state, "exhausted")
  })

  await t.test("a guest's allowance unlocks with time the app is open, credited from heartbeats; new machines are never capped per IP", async () => {
    const minute = 60000
    // Fifty machines (say, one office behind one IP) all start sessions, each on the first ramp step.
    const machines = Array.from({ length: 50 }, (_, index) => `e${index.toString(16).padStart(2, "0")}`.padEnd(64, "a"))
    for (const [index, machine] of machines.entries()) await (index % 2 ? otherGuests : guests).consumeSession(machine)
    assert.equal((await rows(`SELECT COUNT(*) AS amount FROM anonymous_inference_identities WHERE id IN (${machines.map(() => "?").join(",")})`, machines))[0].amount, 50)
    for (const machine of [machines[0], machines[49]]) assert.equal((await guests.read({ kind: "installation", id: machine })).allowance?.limitUsd, 0.1)
    await guests.consumeSession(machines[0])
    const guest: GuestPrincipal = { kind: "installation", id: machines[0] }
    assert.equal((await admit(guest))[0].limit, rampedDeviceAmount(config, 0))
    assert.equal((await guests.read(guest)).allowance?.limitUsd, 0.1)
    const identity = async () => (await db.select().from(AnonymousInferenceIdentityTable).where(eq(AnonymousInferenceIdentityTable.id, machines[0])))[0]
    // Wall-clock time alone unlocks nothing: a heartbeat after a long silence credits no active time.
    const before = (await identity()).active_ms
    await db.update(AnonymousInferenceIdentityTable).set({ last_seen_at: new Date(Date.now() - 45 * minute) }).where(eq(AnonymousInferenceIdentityTable.id, machines[0]))
    assert.equal((await otherGuests.read(guest)).allowance?.limitUsd, 0.1)
    assert.equal((await identity()).active_ms, before)
    // A heartbeat two minutes after the last one credits those two minutes.
    await db.update(AnonymousInferenceIdentityTable).set({ last_seen_at: new Date(Date.now() - 2 * minute) }).where(eq(AnonymousInferenceIdentityTable.id, machines[0]))
    await guests.read(guest)
    const credited = (await identity()).active_ms
    assert.ok(credited >= 2 * minute - 2000 && credited <= 2 * minute + 2000, `credited ${credited}`)
    // Twenty-five active minutes reach the third tier, thirty the full device allowance.
    await db.update(AnonymousInferenceIdentityTable).set({ active_ms: 25 * minute, last_seen_at: new Date() }).where(eq(AnonymousInferenceIdentityTable.id, machines[0]))
    assert.equal((await otherGuests.read(guest)).allowance?.limitUsd, 0.5)
    await db.update(AnonymousInferenceIdentityTable).set({ active_ms: 31 * minute, last_seen_at: new Date() }).where(eq(AnonymousInferenceIdentityTable.id, machines[0]))
    assert.equal((await guests.read(guest)).allowance?.limitUsd, 1, "the full device allowance after 30 active minutes")
    // A machine first met through a request (not a session) is recorded too.
    const direct: GuestPrincipal = { kind: "installation", id: "f".repeat(64) }
    await admit(direct)
    assert.equal((await db.select().from(AnonymousInferenceIdentityTable).where(eq(AnonymousInferenceIdentityTable.id, direct.id))).length, 1)
  })

  await t.test("an organization whose default desktop policy turns off the free starter model is not offered free Auto", async () => {
    const member = await person(), policyId = createDenTypeId("desktopPolicy")
    await db.insert(DesktopPolicyTable).values({ id: policyId, organizationId: member.input.organizationId, policyName: "Managed only",
      isDefault: true, isEnabled: true, policy: { allowCustomProviders: false, allowZenModel: false }, createdByOrgMemberId: member.input.memberId })
    assert.equal(await ensureMemberFreeInferenceCredential(member.input), null)
    assert.equal(await findMemberFreePrincipal(member.key, db), null, "a key issued before the switch was turned off is refused")
    assert.equal(await memberFreePrincipalAllowed(member.principal, replica.db), false)
    assert.deepEqual(await otherStore.admit(member.principal), { ok: false, code: "free_principal_rejected" })
    assert.equal((await getMemberInferenceAccess(member.input)).reason, "admin_disabled")
    await db.update(DesktopPolicyTable).set({ policy: { allowCustomProviders: false, allowZenModel: true } }).where(eq(DesktopPolicyTable.id, policyId))
    assert.ok(await ensureMemberFreeInferenceCredential(member.input), "managed only with the free starter model on: Auto is offered again")
    assert.ok(await findMemberFreePrincipal(member.key, replica.db))
    assert.equal(await memberFreePrincipalAllowed(member.principal, db), true)
  })

  for (const assignment of ["member", "team", "role"] as const) {
    await t.test(`Gateway and Den honor the same ${assignment} assignment for an already-issued key`, async () => {
      const member = await person(), defaultId = createDenTypeId("desktopPolicy"), assignedId = createDenTypeId("desktopPolicy")
      const common = { organizationId: member.input.organizationId, isEnabled: true, createdByOrgMemberId: member.input.memberId }
      await db.insert(DesktopPolicyTable).values([
        { ...common, id: defaultId, isDefault: true, policyName: "Starter off", policy: { allowZenModel: false } },
        { ...common, id: assignedId, isDefault: false, policyName: "Starter on", policy: { allowZenModel: true } },
      ])
      let teamId: typeof TeamTable.$inferSelect.id | null = null
      if (assignment === "team") {
        teamId = createDenTypeId("team")
        await db.insert(TeamTable).values({ id: teamId, organizationId: member.input.organizationId, name: "Starter team" })
        await db.insert(TeamMemberTable).values({ id: createDenTypeId("teamMember"), teamId, orgMembershipId: member.input.memberId })
      }
      if (assignment === "role") await db.update(MemberTable).set({ role: "owner" }).where(eq(MemberTable.id, member.input.memberId))
      await db.insert(DesktopPolicyMemberTable).values({ id: createDenTypeId("desktopPolicyMember"), organizationId: member.input.organizationId,
        desktopPolicyId: assignedId, orgMemberId: assignment === "member" ? member.input.memberId : null,
        teamId, role: assignment === "role" ? "admin" : null })
      assert.ok(await ensureMemberFreeInferenceCredential(member.input))
      assert.ok(await findMemberFreePrincipal(member.key, replica.db))
      assert.equal(await memberFreePrincipalAllowed(member.principal, db), true)
      await db.update(DesktopPolicyTable).set({ isEnabled: false }).where(eq(DesktopPolicyTable.id, assignedId))
      assert.equal(await ensureMemberFreeInferenceCredential(member.input), null)
      assert.equal(await findMemberFreePrincipal(member.key, db), null)
      assert.deepEqual(await otherStore.admit(member.principal), { ok: false, code: "free_principal_rejected" })
    })
  }

  await t.test("an organization that pays for OpenWork Models still gets free Auto on its members' Models key", async () => {
    const member = await person()
    await db.insert(OrgSubscriptionTable).values({ id: createDenTypeId("orgSubscription"), organization_id: member.input.organizationId, type: "inference",
      status: "active", stripe_customer_id: "cus_fixture", stripe_subscription_id: `sub_${randomUUID()}` })
    await db.update(OrganizationTable).set({ metadata: { inference: { enabled: true, tier: "tier1" }, inferenceFree: { rolloutEnabled: true } } })
      .where(eq(OrganizationTable.id, member.input.organizationId))
    assert.ok(await findMemberFreePrincipal(member.key, db))
    assert.equal(await memberFreePrincipalAllowed(member.principal, replica.db), true)
    assert.equal((await ensureMemberFreeInferenceCredential(member.input))?.apiKey, member.credential.apiKey, "Auto rides on the member's existing Models key")
    const access = await getMemberInferenceAccess(member.input)
    assert.deepEqual([access.kind, access.reason], ["free", null])
    assert.equal((await admit(member.principal)).length, 1, "admitted against the member's free weekly allowance")
  })

  await t.test("an organization rollout change blocks existing keys, status and admission without affecting another organization or guests", async () => {
    const pilot = await person(), other = await person()
    const guest: GuestPrincipal = { kind: "installation", id: "org-rollout-independent-guest" }
    const windows = await admit(pilot.principal)
    for (const metadata of [{}, { inferenceFree: { rolloutEnabled: false } }, { inferenceFree: { rolloutEnabled: "true" } }]) {
      await db.update(OrganizationTable).set({ metadata }).where(eq(OrganizationTable.id, pilot.input.organizationId))
      assert.equal(await ensureMemberFreeInferenceCredential(pilot.input), null)
      assert.equal((await getMemberInferenceAccess(pilot.input)).reason, "free_disabled")
      assert.equal(await findMemberFreePrincipal(pilot.key, replica.db), null)
      assert.equal(await memberFreePrincipalAllowed(pilot.principal, replica.db), false)
      assert.deepEqual(await otherStore.read(pilot.principal), { state: "unavailable", code: "free_principal_rejected", allowance: null })
      assert.equal((await otherStore.admit(pilot.principal)).ok, false)
      assert.equal((await otherStore.read(other.principal)).state, "ready")
      assert.equal((await guests.read(guest)).state, "ready")
    }
    assert.equal(await charge(pilot.principal, windows, receipt()), true, "already admitted usage still settles")
    await db.update(OrganizationTable).set({ metadata: { inferenceFree: { rolloutEnabled: true } } }).where(eq(OrganizationTable.id, pilot.input.organizationId))
    assert.equal((await ensureMemberFreeInferenceCredential(pilot.input))?.apiKey, pilot.credential.apiKey)
    assert.ok(await findMemberFreePrincipal(pilot.key, db))
    assert.equal((await otherStore.read(pilot.principal)).state, "ready")
    assert.equal((await bucket(pilot.principal)).used_amount, 100000, "reenabling does not reset spend")
  })

  await t.test("DPA and admin policy deny free Auto; a revoked key cannot start a request but a finished one is still charged", async () => {
    const member = await person(), windows = await admit(member.principal)
    await db.update(OrganizationTable).set({ metadata: { dpaSigned: true } }).where(eq(OrganizationTable.id, member.input.organizationId))
    await assert.rejects(ensureMemberFreeInferenceCredential(member.input), { code: "managed_models_disabled_for_dpa" })
    await assert.rejects(otherStore.admit(member.principal), { code: "managed_models_disabled_for_dpa" })
    await db.update(OrganizationTable).set({ metadata: { inferenceFree: { offerAllowed: false, rolloutEnabled: true } } }).where(eq(OrganizationTable.id, member.input.organizationId))
    assert.equal(await ensureMemberFreeInferenceCredential(member.input), null)
    assert.equal(await findMemberFreePrincipal(member.key, db), null)
    assert.equal((await otherStore.admit(member.principal)).ok, false)
    await db.update(OrganizationTable).set({ metadata: { inferenceFree: { rolloutEnabled: true } } }).where(eq(OrganizationTable.id, member.input.organizationId))
    await db.update(InferenceKeyTable).set({ status: "revoked", revoked_at: new Date() }).where(eq(InferenceKeyTable.id, member.key.id))
    assert.equal(await findMemberFreePrincipal(member.key, replica.db), null)
    assert.equal((await otherStore.admit(member.principal)).ok, false)
    assert.equal(await charge(member.principal, windows, receipt()), true, "usage OpenAI already produced is recorded")
    assert.equal((await bucket(member.principal)).used_amount, 100000)
    const next = await ensureMemberFreeInferenceCredential(member.input)
    assert.ok(next)
    assert.notEqual(next.apiKey, member.credential.apiKey)
  })

  await t.test("membership removal invalidates the key's free access", async () => {
    const member = await person()
    await db.update(MemberTable).set({ removedAt: new Date() }).where(eq(MemberTable.id, member.input.memberId))
    assert.equal(await memberFreePrincipalAllowed(member.principal, replica.db), false)
    assert.equal(await findMemberFreePrincipal(member.key, db), null)
    assert.equal(await ensureMemberFreeInferenceCredential(member.input), null)
  })

  await t.test("proof nonce uniqueness survives committed transactions and competing SQL pools", async () => {
    const proof = { keyThumbprint: "b".repeat(64), machineId: "c".repeat(64), nonce: id(), timestamp: Date.now(), appVersion: "1.2.3", platform: "darwin", arch: "arm64" } satisfies import("../src/free/guest/proof.js").DesktopFreeBinding & { nonce: string; timestamp: number }
    assert.deepEqual((await Promise.all([guests.consumeNonce(proof), otherGuests.consumeNonce(proof)])).sort(), ["accepted", "replay"])
    assert.equal(await otherGuests.consumeNonce(proof), "replay")
    assert.equal(await store.consumeNonce(proof), "unavailable")
    assert.equal(await guests.consumeNonce({ ...proof, nonce: id(), timestamp: Date.now() - 10 * 60000 }), "unavailable", "a stale proof is refused")
    assert.equal((await rows("SELECT COUNT(*) AS amount FROM desktop_free_proof_nonces"))[0].amount, 1)
  })

  await t.test("free migrations and all runtime cases leave seeded paid accounting unchanged", async () => {
    assert.deepEqual({ buckets: await rows("SELECT * FROM inference_org_usage_buckets"), ledger: await rows("SELECT * FROM inference_usage_ledger_entries") }, paidBefore)
    assert.equal((await db.select({ amount: sql<number>`count(*)` }).from(Usage))[0].amount > 0, true)
    assert.equal((await db.select({ amount: sql<number>`count(*)` }).from(GuestUsage))[0].amount > 0, true)
  })
})
