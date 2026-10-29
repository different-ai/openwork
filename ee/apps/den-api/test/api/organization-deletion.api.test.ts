/**
 * Deleting an organization with more history than one purge batch:
 * - history is deleted in bounded batches outside the transaction that deletes the organization, so an attempt that
 *   fails in that transaction keeps what it purged;
 * - the retry resumes: one Linear deletion ticket per deletion, completed once the organization is gone;
 * - the progress is not part of the metadata members see;
 * - another organization's rows stay.
 */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, test } from "node:test"
import { bootDen, field, isRecord, startFakeHttpServer, summary } from "./harness.js"

const linearCalls: Array<{ operation: "create" | "complete"; issueId: string }> = []
const linear = await startFakeHttpServer((_request, body, response) => {
  const parsed: unknown = JSON.parse(body)
  const query = field(parsed, "query")
  response.setHeader("content-type", "application/json")
  if (typeof query === "string" && query.includes("issueCreate")) {
    const issueId = `issue-${linearCalls.filter((call) => call.operation === "create").length + 1}`
    linearCalls.push({ operation: "create", issueId })
    response.end(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: issueId } } } }))
    return
  }
  const issueId = String(field(parsed, "variables", "id"))
  linearCalls.push({ operation: "complete", issueId })
  response.end(JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: issueId } } } }))
})
const den = await bootDen({
  env: {
    LINEAR_API_KEY: "linear-test-key",
    LINEAR_COMPLIANCE_TEAM_ID: "compliance-team",
    LINEAR_COMPLIANCE_COMPLETED_STATE_ID: "completed-state",
    LINEAR_API_BASE: linear.url,
  },
})
after(async () => {
  await den.close()
  await linear.close()
})
const { client } = await import("../../src/db.js")
const { ORGANIZATION_PURGE_BATCH_SIZE } = await import("../../src/routes/org/delete-organization-purge.js")

async function sql(statement: string, args: unknown[] = []): Promise<Record<string, unknown>[]> {
  if (!("getConnection" in client)) throw new Error("needs MySQL mode")
  const [rows] = await client.query(statement, args)
  return Array.isArray(rows) ? rows.filter(isRecord) : []
}

async function count(table: string, column: string, organizationId: string): Promise<number> {
  const [row] = await sql(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${column}\` = ?`, [organizationId])
  return Number(row?.n)
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`

/**
 * ARRANGE ONLY: history a busy organization collects (telemetry, usage events and their charges). Returns the
 * prefix of the charges' bucket ids, since charges carry no organization column.
 */
async function seedHistory(organizationId: string, memberId: string, rows: number): Promise<string> {
  const buckets = id("gub")
  const telemetry = Array.from({ length: rows }, () => [id("tev"), organizationId, memberId, "session.started", new Date()])
  await sql("INSERT INTO telemetry_event (id, org_id, member_id, event_type, event_timestamp) VALUES ?", [telemetry])
  const events = Array.from({ length: rows }, () => [id("gue"), organizationId, memberId, new Date(), "gateway"])
  await sql("INSERT INTO gateway_usage_consumption_event (id, organization_id, member_id, admitted_at, source) VALUES ?", [events])
  const charges = events.map((event, index) => [event[0], `${buckets}_${index}`, id("gup"), 1])
  await sql("INSERT INTO gateway_usage_bucket_charge (event_id, bucket_id, policy_id, policy_revision) VALUES ?", [charges])
  return buckets
}

async function charges(buckets: string): Promise<number> {
  const [row] = await sql("SELECT COUNT(*) AS n FROM gateway_usage_bucket_charge WHERE bucket_id LIKE ?", [`${buckets}\\_%`])
  return Number(row?.n)
}

test("a deletion that fails in its final transaction keeps its purge, and the retry finishes with one Linear ticket", async () => {
  const rows = ORGANIZATION_PURGE_BATCH_SIZE * 2 + 150
  const doomed = await den.createOrg(await den.signUp("Dora Deleting"), "Busy deleted org")
  const kept = await den.createOrg(await den.signUp("Kim Keeping"), "Busy kept org")
  const doomedCharges = await seedHistory(doomed.orgId, doomed.owner.memberId, rows)
  const keptCharges = await seedHistory(kept.orgId, kept.owner.memberId, 10)
  await sql("UPDATE session SET active_organization_id = ? WHERE user_id = ?", [doomed.orgId, doomed.owner.userId])

  // The organization row cannot be deleted, so the final transaction fails after the batched purge.
  await sql(`CREATE TRIGGER refuse_org_delete BEFORE DELETE ON organization FOR EACH ROW
    BEGIN IF OLD.name = 'Busy deleted org' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'refused for test'; END IF; END`)
  const failed = await den.as(doomed.owner, doomed.orgId)("DELETE", "/v1/org", { confirmation: "Busy deleted org" })
    .finally(() => sql("DROP TRIGGER refuse_org_delete"))
  assert.equal(failed.status, 500, summary(failed))
  assert.equal(await count("telemetry_event", "org_id", doomed.orgId), 0, "purged history stays deleted")
  assert.equal(await count("gateway_usage_consumption_event", "organization_id", doomed.orgId), 0)
  assert.equal(await charges(doomedCharges), 0)
  assert.equal(await count("organization", "id", doomed.orgId), 1, "the organization itself is still there")
  assert.deepEqual(linearCalls, [{ operation: "create", issueId: "issue-1" }])
  const seen = await den.as(doomed.owner, doomed.orgId)("GET", "/v1/org")
  assert.equal(seen.status, 200, summary(seen))
  assert.ok(!String(field(seen.body, "organization", "metadata")).includes("deletionInProgress"), "members never see deletion progress")

  const retried = await den.as(doomed.owner, doomed.orgId)("DELETE", "/v1/org", { confirmation: "Busy deleted org" })
  assert.equal(retried.status, 200, summary(retried))
  assert.deepEqual(linearCalls, [
    { operation: "create", issueId: "issue-1" },
    { operation: "complete", issueId: "issue-1" },
  ], "the retry completes the first attempt's ticket instead of opening another")
  assert.equal(await count("organization", "id", doomed.orgId), 0)
  assert.equal(await count("member", "organization_id", doomed.orgId), 0)
  assert.equal(await count("session", "active_organization_id", doomed.orgId), 0, "members' sessions leave the organization")

  assert.equal(await count("telemetry_event", "org_id", kept.orgId), 10, "another organization's history stays")
  assert.equal(await count("gateway_usage_consumption_event", "organization_id", kept.orgId), 10)
  assert.equal(await charges(keptCharges), 10)
})
