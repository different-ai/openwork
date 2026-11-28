import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { adminOrganizationTimelineSchema, type AdminTimelineEntry } from "@openwork/types/den/admin-organization-timeline"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("Timeline fixtures require the disposable MySQL harness")
const query = (statement: string, values: (string | number | null)[] = []) => client.execute(statement, values)
const { compareTimelineEntries, summarizeTimelineSource, TIMELINE_SUMMARY_LIMIT } = await import("../../src/routes/admin/organization-timeline.js")
const utc = (at: string) => at.replace("T", " ").replace("Z", "")
const admin = await den.signUp("Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
const owner = await den.signUp("Timeline Owner")
const organization = await den.createOrg(owner, "Example diagnostics")
const other = await den.createOrg(await den.signUp("Other Owner"), "Other diagnostics")
const base = `/v1/admin/organizations/${organization.orgId}/timeline`
const now = Date.now() - 60_000
const tiedAt = new Date(now - 60_000).toISOString()
const marker = "PRIVATE_CONTENT_MUST_NOT_APPEAR"
const expected: AdminTimelineEntry[] = []

async function startup(at: string, success: boolean, orgId = organization.orgId, memberId = organization.owner.memberId) {
  const id = createDenTypeId("desktopStartupReport")
  await query("INSERT INTO desktop_startup_report (id, organization_id, org_membership_id, attempt_id, app_version, platform, success, failed_step, failure_reason, observed_at) VALUES (?, ?, ?, ?, '1.0.0', 'darwin', ?, ?, ?, ?)",
    [id, orgId, memberId, randomUUID(), success ? 1 : 0, success ? null : "engine", success ? null : "engine_failed", utc(at)])
  return { at, source: "desktop_startup", outcome: success ? "ok" : "failed", kind: success ? "startup_ready" : "engine_failed", recordId: id, memberId } satisfies AdminTimelineEntry
}

for (let index = 0; index < 105; index += 1) expected.push(await startup(tiedAt, index % 2 === 0))
for (let index = 0; index < 105; index += 1) {
  const id = createDenTypeId("inferenceRequestLog")
  const outcome = index % 3 === 0 ? "upstream_error" : "ok"
  const route = ["openwork_openrouter", "org_provider", "openwork_free"][index % 3]
  await query("INSERT INTO gateway_request_logs (id, organization_id, org_membership_id, route, protocol, upstream_provider_id, upstream_host, upstream_path, method, requested_model, stream, status, outcome, error_code, usage_source, openwork_request_id, started_at, metadata) VALUES (?, ?, ?, ?, 'openai_chat', 'example', ?, ?, 'POST', ?, 0, ?, ?, ?, 'missing', ?, ?, ?)",
    [id, organization.orgId, organization.owner.memberId, route ?? "org_provider", marker, `/${marker}?token=${marker}`, marker, outcome === "ok" ? 200 : 502, outcome, marker, randomUUID().replaceAll("-", ""), utc(tiedAt), JSON.stringify({ prompt: marker, messages: marker, arguments: marker, token: marker, fileName: marker })])
  expected.push({ at: tiedAt, source: "inference_request", outcome: outcome === "ok" ? "ok" : "failed", kind: outcome, recordId: id, memberId: organization.owner.memberId })
}
expected.push(await startup(new Date(now).toISOString(), false))
expected.push(await startup(new Date(now - 120_000).toISOString(), true))
await startup(tiedAt, false, other.orgId, other.owner.memberId)
await startup(new Date(now - 31 * 86_400_000).toISOString(), false)
const olderStartup = await startup(new Date(now - 8 * 86_400_000).toISOString(), false)

const workflowId = createDenTypeId("workflowRun")
await query("INSERT INTO workflow_run (id, organization_id, org_membership_id, source, code_digest, status, error_kind, error_message, tool_calls, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?)",
  [workflowId, organization.orgId, organization.owner.memberId, marker, marker, marker, marker, JSON.stringify([{ name: marker }]), utc(tiedAt), utc(tiedAt), utc(tiedAt)])
expected.push({ at: tiedAt, source: "workflow_run", outcome: "failed", kind: "failed", recordId: workflowId, memberId: organization.owner.memberId })
const deviceId = createDenTypeId("remoteDeviceEvent")
await query("INSERT INTO remote_device_event (id, organization_id, device_id, type, level, message, actor, actor_id, data, created_at) VALUES (?, ?, ?, 'failed', 'error', ?, 'member', ?, ?, ?)",
  [deviceId, organization.orgId, createDenTypeId("remoteDevice"), marker, marker, JSON.stringify({ text: marker }), utc(tiedAt)])
expected.push({ at: tiedAt, source: "remote_device_event", outcome: "failed", kind: "failed", recordId: deviceId, memberId: null })
const capabilityId = createDenTypeId("capabilityUsageEvent")
await query("INSERT INTO capability_usage_event (id, organization_id, org_membership_id, kind, source, outcome, created_at) VALUES (?, ?, ?, 'connector_tool', 'agent', 'error', ?)", [capabilityId, organization.orgId, organization.owner.memberId, utc(tiedAt)])
expected.push({ at: tiedAt, source: "capability_use", outcome: "failed", kind: "connector_tool", recordId: capabilityId, memberId: organization.owner.memberId })
const auditId = createDenTypeId("auditOperation")
await query("INSERT INTO audit_operation (id, organization_id, binding_key, kind, scope, principal_key, initiating_actor, origin, origin_trust, first_recorded_at, attachment_expires_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, 'api', 'authenticated', ?, ?, 'partial')", [auditId, organization.orgId, randomUUID(), marker, marker, marker, JSON.stringify({ type: "member", id: marker }), utc(tiedAt), utc(tiedAt)])
expected.push({ at: tiedAt, source: "audit_operation", outcome: "failed", kind: "unknown", recordId: auditId, memberId: null })
const telemetryId = createDenTypeId("telemetryEvent")
await query("INSERT INTO telemetry_event (id, org_id, member_id, event_type, event_timestamp, source, session_id, success) VALUES (?, ?, ?, 'task.failed', ?, 'app', ?, 0)", [telemetryId, organization.orgId, organization.owner.memberId, utc(tiedAt), marker])
expected.push({ at: tiedAt, source: "client_activity", outcome: "failed", kind: "task.failed", recordId: telemetryId, memberId: organization.owner.memberId })
expected.sort(compareTimelineEntries)

async function read(path = base) {
  const response = await den.request(admin.token, "GET", path)
  assert.equal(response.status, 200, summary(response))
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(response.text.includes(marker), false, "raw HTTP responses never expose content")
  for (const entry of list(field(response.body, "entries"))) {
    assert.deepEqual(Object.keys(entry).sort(), ["at", "kind", "memberId", "outcome", "recordId", "source"])
  }
  return adminOrganizationTimelineSchema.parse(response.body)
}
async function all(path = base) {
  const entries: AdminTimelineEntry[] = []
  let response = await read(path)
  const window = response.window
  for (let page = 0; ; page += 1) {
    assert.ok(page < 10, "pagination terminates")
    assert.deepEqual(response.window, window)
    entries.push(...response.entries)
    if (!response.nextCursor) break
    response = await read(`${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(response.nextCursor)}`)
  }
  return entries
}

test("timeline requires staff access, not organization ownership", async () => {
  assert.equal((await den.request(null, "GET", base)).status, 401)
  assert.equal((await den.request(owner.token, "GET", base)).status, 403)
  for (const suffix of ["?days=31", "?days=0", "?source=not_a_source", "?failuresOnly=true", "?cursor=broken"]) {
    assert.equal((await den.request(admin.token, "GET", `${base}${suffix}`)).status, 400, suffix)
  }
  assert.equal((await den.request(admin.token, "GET", `/v1/admin/organizations/${createDenTypeId("organization")}/timeline`)).status, 404)
})

test("merges all indexed sources newest first and pages through tied timestamps without duplicates or gaps", async () => {
  const first = await read()
  assert.equal(first.entries.length, 100)
  assert.ok(first.nextCursor)
  assert.deepEqual(first.entries, expected.slice(0, 100))
  assert.deepEqual(await all(), expected)
  assert.equal(new Set((await all()).map((entry) => `${entry.source}:${entry.recordId}`)).size, expected.length)
  assert.equal(Date.parse(first.window.until) - Date.parse(first.window.since), 7 * 86_400_000)
})

test("source and failure filters apply before pagination while summaries cover the whole window", async () => {
  assert.deepEqual(await all(`${base}?failuresOnly=1`), expected.filter((entry) => entry.outcome === "failed"))
  assert.deepEqual(await all(`${base}?source=inference_request`), expected.filter((entry) => entry.source === "inference_request"))
  assert.deepEqual(await all(`${base}?source=desktop_startup&failuresOnly=1`), expected.filter((entry) => entry.source === "desktop_startup" && entry.outcome === "failed"))
  const report = await read(`${base}?failuresOnly=1`)
  assert.equal(report.sources.find((source) => source.source === "desktop_startup")?.count, 107)
  assert.equal(report.sources.find((source) => source.source === "inference_request")?.failureCount, 35)
  const first = await read()
  assert.equal((await den.request(admin.token, "GET", `${base}?failuresOnly=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).status, 400)
  assert.equal((await den.request(admin.token, "GET", `/v1/admin/organizations/${other.orgId}/timeline?cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).status, 400)
})

test("the selected window includes older reports without crossing the 30-day maximum", async () => {
  assert.deepEqual(await all(`${base}?days=30`), [...expected, olderStartup].sort(compareTimelineEntries))
  const report = await read(`${base}?days=30`)
  assert.equal(Date.parse(report.window.until) - Date.parse(report.window.since), 30 * 86_400_000)
})

test("a source with no rows is unknown, never healthy", async () => {
  const report = await read(`/v1/admin/organizations/${other.orgId}/timeline`)
  const source = report.sources.find((entry) => entry.source === "workflow_run")
  assert.deepEqual(source && { count: source.count, failureCount: source.failureCount, lastSeenAt: source.lastSeenAt, outcome: source.outcome, limited: source.limited }, { count: 0, failureCount: 0, lastSeenAt: null, outcome: "unknown", limited: false })
  assert.ok(report.excludedSources.some((entry) => entry.source === "Connection sign-ins and checks"))
})

test("never returns content, raw errors, tokens, tool arguments, file names or query-string URLs", async () => {
  const report = await read()
  assert.equal(JSON.stringify(report).includes(marker), false)
  for (const entry of await all()) {
    assert.deepEqual(Object.keys(entry).sort(), ["at", "kind", "memberId", "outcome", "recordId", "source"])
    assert.equal(JSON.stringify(entry).includes(marker), false)
  }
})

test("summary bounds are explicit and do not imply a known successful outcome", () => {
  const entry = expected.find((row) => row.outcome === "ok")
  assert.ok(entry)
  const result = summarizeTimelineSource(entry.source, Array.from({ length: TIMELINE_SUMMARY_LIMIT + 1 }, () => entry), "Retained reports only.")
  assert.equal(result.count, TIMELINE_SUMMARY_LIMIT)
  assert.equal(result.limited, true)
  assert.equal(result.outcome, "unknown")
})
