import assert from "node:assert/strict"
import { after, test } from "node:test"
import { asc, eq } from "@openwork-ee/den-db/drizzle"
import { FeatureUsageTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary, text, type Call } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const org = await den.createOrg(await den.signUp("Usage Owner"), "Feature usage workspace")
const member = await den.newMember(org.owner, org.orgId, "Usage Member")
const other = await den.createOrg(await den.signUp("Other Owner"), "Other usage workspace")
// setFeature signs the platform administrator up, so it runs before signing in.
for (const [key, enabled] of [["settledSessions", true], ["nativeDictation", false], ["workbotProactive", true]] as const) {
  const set = await den.setFeature(org.orgId, key, enabled)
  assert.equal(set.status, 200, `${key}: ${summary(set)}`)
}
const signedIn = await den.signIn(`platform-admin+${den.stamp}@example.test`)
const adminToken = text(field(signedIn.body, "token"), "platform admin session")
const usagePath = (organizationId = org.orgId) => `/v1/admin/organizations/${organizationId}/feature-usage`
const { db } = await import("../../src/db.js")
const { recordFeatureUsage } = await import("@openwork-ee/den-db/organization-features")


async function usageRows(memberId: string) {
  return db.select({
    feature_key: FeatureUsageTable.feature_key,
    days_used: FeatureUsageTable.days_used,
    last_used_day: FeatureUsageTable.last_used_day,
    last_used_at: FeatureUsageTable.last_used_at,
  }).from(FeatureUsageTable).where(eq(FeatureUsageTable.member_id, normalizeDenTypeId("member", memberId))).orderBy(asc(FeatureUsageTable.feature_key))
}

/** Usage is written after the response; wait for it instead of sleeping a fixed time. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return read()
}

function featureEntry(call: Call, key: string) {
  return list(field(call.body, "features")).find((entry) => entry.key === key)
}

test("recording a use is idempotent within a UTC day and counts the next day once", async () => {
  const memberId = createDenTypeId("member")
  const organizationId = createDenTypeId("organization")
  const write = (at: string) => recordFeatureUsage(db, { organizationId, memberId, keys: ["settledSessions"], at: new Date(at) })
  await write("2026-10-20T08:00:00.000Z")
  await write("2026-10-20T20:00:00.000Z")
  let [row] = await usageRows(memberId)
  assert.equal(row?.days_used, 1)
  assert.equal(row?.last_used_at.toISOString(), "2026-10-20T20:00:00.000Z")
  await write("2026-10-21T01:00:00.000Z")
  await write("2026-10-21T02:00:00.000Z")
  ;[row] = await usageRows(memberId)
  assert.equal(row?.days_used, 2)
  assert.equal(row?.last_used_day, "2026-10-21")
  // A late write from another replica never moves the last use back or counts a day twice.
  await write("2026-10-20T23:00:00.000Z")
  ;[row] = await usageRows(memberId)
  assert.equal(row?.days_used, 2)
  assert.equal(row?.last_used_at.toISOString(), "2026-10-21T02:00:00.000Z")
})

test("a client report records only known features that are on for the caller", async () => {
  const reported = await den.as(member, org.orgId)("POST", "/v1/org/feature-usage", { features: ["settledSessions", "nativeDictation", "notARealFeature"] })
  assert.equal(reported.status, 200, summary(reported))
  assert.deepEqual(reported.body, { ok: true })
  const rows = await eventually(() => usageRows(member.memberId), (value) => value.length > 0)
  assert.deepEqual(rows.map((row) => row.feature_key), ["settledSessions"])
  const invalid = await den.as(member, org.orgId)("POST", "/v1/org/feature-usage", { features: "settledSessions" })
  assert.equal(invalid.status, 400, summary(invalid))
  assert.equal((await den.request(null, "POST", "/v1/org/feature-usage", { orgId: org.orgId, body: { features: ["settledSessions"] } })).status, 401)
})

test("a request through a feature-gated route counts as a use", async () => {
  await den.as(org.owner, org.orgId)("GET", "/v1/org/workbot-settings/proactive")
  const rows = await eventually(() => usageRows(org.owner.memberId), (value) => value.some((row) => row.feature_key === "workbotProactive"))
  assert.ok(rows.some((row) => row.feature_key === "workbotProactive"))
})

test("only a platform administrator can read an organization's feature usage", async () => {
  for (const token of [null, org.owner.token, member.token]) {
    const result = await den.request(token, "GET", usagePath())
    assert.equal(result.status, token ? 403 : 401, summary(result))
  }
  assert.equal((await den.request(adminToken, "GET", usagePath("invalid"))).status, 400)
  assert.equal((await den.request(adminToken, "GET", usagePath(createDenTypeId("organization")))).status, 404)
})

test("the admin view shows who has each feature on and who used it", async () => {
  const result = await den.request(adminToken, "GET", usagePath())
  assert.equal(result.status, 200, summary(result))
  assert.equal(field(result.body, "activeMembers"), 2)
  assert.equal(typeof field(result.body, "generatedAt"), "string")

  const mermaid = featureEntry(result, "settledSessions")
  assert.equal(mermaid?.enabledMembers, 2)
  assert.equal(mermaid?.usedLast7Days, 1)
  assert.equal(mermaid?.usedLast30Days, 1)
  const [used] = list(mermaid?.members)
  assert.equal(used?.memberId, member.memberId)
  assert.equal(used?.name, "Usage Member")
  assert.equal(used?.email, member.email)
  assert.equal(used?.enabled, true)
  assert.equal(used?.daysUsed, 1)

  const dictation = featureEntry(result, "nativeDictation")
  assert.equal(dictation?.enabledMembers, 0)
  assert.deepEqual(dictation?.members, [])

  // Turning a feature off keeps its history and shows it is off now.
  assert.equal((await den.setFeature(org.orgId, "settledSessions", false)).status, 200)
  const off = featureEntry(await den.request(adminToken, "GET", usagePath()), "settledSessions")
  assert.equal(off?.enabledMembers, 0)
  assert.equal(list(off?.members)[0]?.enabled, false)

  // Another organization's usage never shows up.
  const foreign = await den.request(adminToken, "GET", usagePath(other.orgId))
  assert.equal(foreign.status, 200, summary(foreign))
  for (const entry of list(field(foreign.body, "features"))) assert.deepEqual(entry.members, [])
})
