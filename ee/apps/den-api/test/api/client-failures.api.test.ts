import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { ClientFailureReportTable } from "@openwork-ee/den-db/schema"
import { clientFailureSummarySchema, type ClientFailureReport } from "@openwork/types/den/diagnostics"
import { bootDen, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")
const actor = await den.signUp("Reporter")
const organization = await den.createOrg(actor, "Failure diagnostics test")
const path = "/v1/diagnostics/client-failures"
const report = (): ClientFailureReport => ({ schemaVersion: 1, reportId: randomUUID(), occurredAt: new Date().toISOString(), component: "engine", phase: "run", reason: "signal", appVersion: "1.2.3", platform: "linux", arch: "x64", count: 2 })
const post = (reports: ClientFailureReport[]) => den.request(actor.token, "POST", path, { orgId: organization.orgId, body: { reports } })

test("flag off rejects ingest; authenticated member can store each report only once", async () => {
  const item = report()
  assert.equal((await post([item])).status, 404)
  assert.equal((await den.setFeature(organization.orgId, "clientFailureReports", true)).status, 200)
  const result = await post([item])
  assert.equal(result.status, 204, summary(result))
  assert.equal((await post([{ ...item, count: 99 }])).status, 204)
  const rows = await db.select().from(ClientFailureReportTable).where(eq(ClientFailureReportTable.reportId, item.reportId))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.count, 2)
  assert.equal(rows[0]?.organizationId, organization.orgId)
  assert.equal(rows[0]?.orgMembershipId, organization.owner.memberId)
})
test("unauthenticated and cross-organization member cannot write", async () => {
  assert.equal((await den.request(null, "POST", path, { orgId: organization.orgId, body: { reports: [report()] } })).status, 401)
  const outsider = await den.signUp("Outside reporter")
  await den.createOrg(outsider, "Separate test organization")
  const item = report()
  const result = await den.request(outsider.token, "POST", path, { orgId: organization.orgId, body: { reports: [item] } })
  assert.ok(result.status === 403 || result.status === 404, summary(result))
  assert.equal((await db.select().from(ClientFailureReportTable).where(eq(ClientFailureReportTable.reportId, item.reportId))).length, 0)
})
test("validation, body bound and expiry prevent storage", async () => {
  const item = report()
  const invalid = await den.request(actor.token, "POST", path, { orgId: organization.orgId, body: { reports: [{ ...item, message: "forbidden" }] } })
  assert.equal(invalid.status, 400, summary(invalid))
  const huge = await den.request(actor.token, "POST", path, { orgId: organization.orgId, rawBody: JSON.stringify({ reports: [], padding: "a".repeat(33_000) }) })
  assert.equal(huge.status, 413, summary(huge))
  assert.equal((await post([{ ...item, occurredAt: new Date(Date.now() - 15 * 86_400_000).toISOString() }])).status, 204)
  assert.equal((await db.select().from(ClientFailureReportTable).where(eq(ClientFailureReportTable.reportId, item.reportId))).length, 0)
})
test("staff aggregation counts reports, folded failures and organizations", async () => {
  const one = { ...report(), component: "updater", phase: "check", reason: "checksum", count: 3 } satisfies ClientFailureReport
  const two = { ...one, reportId: randomUUID(), count: 4 }
  assert.equal((await post([one, two])).status, 204)
  const other = await den.createOrg(actor, "Another diagnostics test")
  assert.equal((await den.setFeature(other.orgId, "clientFailureReports", true)).status, 200)
  assert.equal((await den.request(actor.token, "POST", path, { orgId: other.orgId, body: { reports: [{ ...one, reportId: randomUUID(), count: 5 }] } })).status, 204)
  const response = await den.asPlatformAdmin("GET", "/v1/admin/client-failures?days=14")
  assert.equal(response.status, 200, summary(response))
  const data = clientFailureSummarySchema.parse(response.body)
  const aggregate = data.components.find((row) => row.component === "updater" && row.reason === "checksum")
  assert.ok(aggregate)
  assert.equal(aggregate.reports, 3)
  assert.equal(aggregate.failures, 12)
  assert.equal(aggregate.organizations, 2)
  assert.ok(Math.abs(Date.parse(aggregate.latestOccurrence) - Date.parse(one.occurredAt)) < 5000)
  assert.ok(data.versions.some((row) => row.appVersion === "1.2.3" && row.failures === 14 && row.reports === 4))
  assert.ok(data.latest.some((row) => row.reportId === one.reportId && row.organizationId === organization.orgId))
  assert.equal((await den.request(null, "GET", "/v1/admin/client-failures")).status, 401)
  assert.equal((await den.request(actor.token, "GET", "/v1/admin/client-failures")).status, 403)
})
test("ingest prunes rows older than 90 days", async () => {
  const [existing] = await db.select().from(ClientFailureReportTable).limit(1)
  assert.ok(existing)
  const reportId = randomUUID()
  const occurredAt = new Date(Date.now() - 91 * 86_400_000)
  await db.insert(ClientFailureReportTable).values({ ...existing, reportId, occurredAt, receivedAt: occurredAt })
  assert.equal((await post([report()])).status, 204)
  assert.equal((await db.select().from(ClientFailureReportTable).where(eq(ClientFailureReportTable.reportId, reportId))).length, 0)
})
