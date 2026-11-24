import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, HarnessFeedbackGroupTable, HarnessFeedbackReportTable, MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen({ env: { DEN_HARNESS_FEEDBACK_ORG_IDS: "", DEN_FEATURE_CONNECT_STANDARD_TOOLS: "true" } })
after(() => den.close())
const { env } = await import("../../src/env.js")
const { db, client } = await import("../../src/db.js")
const { HARNESS_FEEDBACK_RATE_LIMIT } = await import("../../src/harness-feedback/repository.js")
const { mintHeadlessRunMcpToken } = await import("../../src/mcp/headless-run-token-mint.js")
const { auth, DEN_MCP_OAUTH_RESOURCE, DEN_MCP_ORG_ID_CLAIM, DEN_MCP_RESOURCE_CLAIM, DEN_MCP_TOKEN_USE_CLAIM } = await import("../../src/auth.js")
const context = await den.createOrg(await den.signUp("Allowed Owner"), "Allowed organization")
const other = await den.createOrg(await den.signUp("Other Owner"), "Other organization")
const organizationId = normalizeDenTypeId("organization", context.orgId)
const memberId = normalizeDenTypeId("member", context.owner.memberId)
const userId = normalizeDenTypeId("user", context.owner.userId)
const outsideOrgId = normalizeDenTypeId("organization", other.orgId)
const token = await den.mintMcpToken(context.owner, context.orgId)
const otherToken = await den.mintMcpToken(other.owner, other.orgId)
const admin = await den.signUp("Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
const tool = "harness_feedback"
const path = "/v1/admin/harness-feedback"
const input = { surface: "tool", tool: "demo_tool", symptom: "The tool does not explain why it needs a target.", workaround: "Read the tool guide." }

async function mcp(accessToken: string, method: string, view = "search", params: object = {}) {
  return den.request(accessToken, "POST", `/mcp/agent?tools=${view}`, {
    headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method, params },
  })
}

async function expectTool(accessToken: string, eligible: boolean, view = "search") {
  const listed = await mcp(accessToken, "tools/list", view)
  assert.equal(listed.status, 200, summary(listed))
  assert.match(listed.text, /"tools":\[/)
  assert.equal(listed.text.includes(`"name":"${tool}"`), eligible)
  const init = await mcp(accessToken, "initialize", view, { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture-client", version: "1.0.0" } })
  assert.equal(init.status, 200, summary(init))
  assert.match(init.text, /"instructions":/)
  assert.equal(init.text.includes(`call ${tool} once`), eligible)
}

test("capture and guidance are absent with empty config or an outside organization", async () => {
  await expectTool(token, false)
  assert.notEqual((await den.callMcpTool(token, tool, input)).rpcError, null)
  env.harnessFeedbackOrgIds.add(organizationId)
  try {
    await expectTool(otherToken, false)
    assert.notEqual((await den.callMcpTool(otherToken, tool, input)).rpcError, null)
  } finally {
    env.harnessFeedbackOrgIds.clear()
  }
})

test("allowlisted members need a first-party principal", async () => {
  env.harnessFeedbackOrgIds.add(organizationId)
  try {
    const [session] = await db.$primary.select({ id: AuthSessionTable.id }).from(AuthSessionTable).where(eq(AuthSessionTable.userId, userId)).limit(1)
    assert.ok(session)
    const { token: thirdParty } = await auth.api.signJWT({ body: { payload: {
      sub: userId, sid: session.id, aud: DEN_MCP_OAUTH_RESOURCE, client_id: "fixture-client", scope: "mcp:read mcp:write",
      [DEN_MCP_ORG_ID_CLAIM]: organizationId, [DEN_MCP_RESOURCE_CLAIM]: DEN_MCP_OAUTH_RESOURCE, [DEN_MCP_TOKEN_USE_CLAIM]: "mcp",
    } } })
    await expectTool(thirdParty, false)
    assert.notEqual((await den.callMcpTool(thirdParty, tool, input)).rpcError, null)
  } finally {
    env.harnessFeedbackOrgIds.clear()
  }
})

test("app and headless capture bounded reports, deduplicate concurrent calls, and share a member limit", async () => {
  env.harnessFeedbackOrgIds.add(organizationId)
  try {
    await expectTool(token, true)
    await expectTool(token, true, "full")
    for (const args of [{ ...input, symptom: "a".repeat(401) }, { ...input, organizationId: other.orgId }]) {
      const invalid = await den.callMcpTool(token, tool, args)
      assert.ok(invalid.isError || invalid.rpcError !== null, invalid.raw)
    }
    const attempts = await Promise.all([den.callMcpTool(token, tool, input), den.callMcpTool(token, tool, input)])
    assert.deepEqual(attempts.map((result) => result.text).sort(), ["Feedback recorded. Continue your task.", "This feedback was already recorded. Continue your task."])
    const [appReport, ...rest] = await db.$primary.select().from(HarnessFeedbackReportTable)
    assert.ok(appReport)
    assert.equal(rest.length, 0)
    assert.equal(appReport.organizationId, organizationId)
    assert.equal(appReport.memberId, memberId)
    assert.equal(appReport.state, "pending")
    assert.equal(appReport.clientKind, "app")
    assert.equal(appReport.symptom, input.symptom)
    if (!("getConnection" in client)) throw new Error("Harness fixture requires disposable MySQL")
    const [stored] = await client.execute("SELECT symptom, workaround FROM harness_feedback_report WHERE id = ?", [appReport.id])
    assert.ok(Array.isArray(stored) && stored.length === 1)
    assert.ok(!JSON.stringify(stored).includes(input.symptom) && !JSON.stringify(stored).includes(input.workaround))

    const { token: headless } = await mintHeadlessRunMcpToken({ organizationId, userId, readOnly: true })
    await expectTool(headless, true)
    for (let index = 2; index < HARNESS_FEEDBACK_RATE_LIMIT; index += 1) {
      const result = await den.callMcpTool(headless, tool, { ...input, symptom: `Harness issue ${index}` })
      assert.match(result.text, /^Feedback recorded/)
    }
    const limited = await den.callMcpTool(token, tool, { ...input, symptom: "Another issue" })
    assert.equal(limited.isError, true)
    assert.match(limited.text, /^Feedback limit reached/)
    const rows = await db.$primary.select().from(HarnessFeedbackReportTable)
    assert.equal(rows.length, HARNESS_FEEDBACK_RATE_LIMIT - 1)
    assert.equal(rows.filter((row) => row.clientKind === "headless").length, HARNESS_FEEDBACK_RATE_LIMIT - 2)
  } finally {
    env.harnessFeedbackOrgIds.clear()
  }
})

test("platform admin inbox and detail are no-store and isolate groups by organization", async () => {
  env.harnessFeedbackOrgIds.add(organizationId)
  const groupId = createDenTypeId("harnessFeedbackGroup")
  const otherGroupId = createDenTypeId("harnessFeedbackGroup")
  await db.insert(HarnessFeedbackGroupTable).values([
    { id: groupId, organizationId, fingerprint: "fixture-fingerprint", title: "Tool guidance is missing", surface: "tool", reportCount: 1 },
    { id: otherGroupId, organizationId: outsideOrgId, fingerprint: "fixture-fingerprint", title: "Outside feedback", surface: "tool", reportCount: 1 },
  ])
  // A cross-org reference must never expose another tenant's report, even when both tenants are allowlisted.
  await db.insert(HarnessFeedbackReportTable).values([
    { id: createDenTypeId("harnessFeedbackReport"), organizationId, memberId, clientKind: "app", surface: "tool", symptom: input.symptom, workaround: input.workaround, groupId, state: "classified" },
    { id: createDenTypeId("harnessFeedbackReport"), organizationId: outsideOrgId, memberId: normalizeDenTypeId("member", other.owner.memberId), clientKind: "app", surface: "tool", symptom: "Other organization symptom", groupId, state: "classified" },
  ])
  try {
    const detailPath = `${path}/${organizationId}/${groupId}`
    for (const endpoint of [path, detailPath]) {
      assert.equal((await den.request(null, "GET", endpoint)).status, 401)
      assert.equal((await den.request(context.owner.token, "GET", endpoint)).status, 403)
    }
    const listing = await den.request(admin.token, "GET", path)
    assert.equal(listing.status, 200, summary(listing))
    assert.equal(listing.headers.get("cache-control"), "no-store")
    assert.equal(field(listing.body, "summary", "groups"), 1)
    assert.equal(field(listing.body, "summary", "pending"), HARNESS_FEEDBACK_RATE_LIMIT - 1)
    assert.equal(field(listing.body, "summary", "reports"), HARNESS_FEEDBACK_RATE_LIMIT)
    assert.ok(!listing.text.includes(outsideOrgId) && !listing.text.includes(input.symptom))
    assert.equal((await den.request(admin.token, "GET", `${path}/${outsideOrgId}/${otherGroupId}`)).status, 404)
    env.harnessFeedbackOrgIds.add(outsideOrgId)
    assert.equal((await den.request(admin.token, "GET", `${path}/${outsideOrgId}/${groupId}`)).status, 404)
    const detail = await den.request(admin.token, "GET", detailPath)
    assert.equal(detail.status, 200, summary(detail))
    assert.equal(detail.headers.get("cache-control"), "no-store")
    assert.ok(detail.text.includes(input.symptom) && detail.text.includes(input.workaround) && !detail.text.includes(outsideOrgId))
  } finally {
    env.harnessFeedbackOrgIds.clear()
  }
})

test("admin can read an ungrouped report that needs review without exposing its text in the inbox", async () => {
  const reportId = createDenTypeId("harnessFeedbackReport")
  const outsideReportId = createDenTypeId("harnessFeedbackReport")
  const groupedReportId = createDenTypeId("harnessFeedbackReport")
  const report = { organizationId, memberId, clientKind: "app", surface: "tool", symptom: input.symptom, workaround: input.workaround, state: "needs_review", createdAt: new Date(Date.now() - 60_000) } satisfies Omit<typeof HarnessFeedbackReportTable.$inferInsert, "id">
  await db.insert(HarnessFeedbackReportTable).values([
    { ...report, id: reportId },
    { ...report, id: outsideReportId, organizationId: outsideOrgId },
    { ...report, id: groupedReportId, groupId: createDenTypeId("harnessFeedbackGroup"), state: "classified" },
  ])
  env.harnessFeedbackOrgIds.add(organizationId)
  try {
    const detailPath = `${path}/reports/${organizationId}/${reportId}`
    assert.equal((await den.request(null, "GET", detailPath)).status, 401)
    assert.equal((await den.request(context.owner.token, "GET", detailPath)).status, 403)
    assert.equal((await den.request(admin.token, "GET", `${path}/reports/${outsideOrgId}/${outsideReportId}`)).status, 404)
    assert.equal((await den.request(admin.token, "GET", `${path}/reports/${organizationId}/${outsideReportId}`)).status, 404)
    assert.equal((await den.request(admin.token, "GET", `${path}/reports/${organizationId}/${groupedReportId}`)).status, 404)
    const listing = await den.request(admin.token, "GET", path)
    assert.equal(listing.status, 200)
    const [first] = list(field(listing.body, "ungroupedReports"))
    assert.equal(first?.id, reportId)
    assert.equal(first?.state, "needs_review")
    assert.ok(!listing.text.includes(input.symptom) && !listing.text.includes(input.workaround))
    const detail = await den.request(admin.token, "GET", detailPath)
    assert.equal(detail.status, 200, summary(detail))
    assert.equal(detail.headers.get("cache-control"), "no-store")
    assert.ok(detail.text.includes(input.symptom) && detail.text.includes(input.workaround))
  } finally {
    env.harnessFeedbackOrgIds.clear()
  }
})

test("removed members cannot list or submit feedback even with a previously issued token", async () => {
  env.harnessFeedbackOrgIds.add(organizationId)
  try {
    await db.update(MemberTable).set({ removedAt: new Date() }).where(eq(MemberTable.id, memberId))
    const listed = await mcp(token, "tools/list")
    assert.ok(listed.status === 403 || (listed.status === 200 && !listed.text.includes(`"name":"${tool}"`)))
    const call = await den.callMcpTool(token, tool, input)
    assert.ok(call.status === 403 || call.rpcError !== null)
  } finally {
    env.harnessFeedbackOrgIds.clear()
  }
})

test("only platform admins can requeue a failed group in the matching allowlisted organization", async () => {
  const id = createDenTypeId("harnessFeedbackGroup")
  const group = { id, organizationId, title: "Tool error", surface: "tool", fingerprint: id,
    notifyState: "failed", notifyAttempts: 3 } satisfies typeof HarnessFeedbackGroupTable.$inferInsert
  await db.insert(HarnessFeedbackGroupTable).values(group)
  env.harnessFeedbackOrgIds.add(organizationId)
  env.harnessFeedbackOrgIds.add(outsideOrgId)
  try {
    const retry = `${path}/${organizationId}/${id}/retry`
    assert.equal((await den.request(null, "POST", retry)).status, 401)
    assert.equal((await den.request(context.owner.token, "POST", retry)).status, 403)
    assert.equal((await den.request(admin.token, "POST", `${path}/${outsideOrgId}/${id}/retry`)).status, 404)
    const listing = await den.request(admin.token, "GET", `${path}?group=${id}`)
    assert.equal(listing.status, 200)
    assert.equal(list(field(listing.body, "groups"))[0]?.id, id)
    const requeued = await den.request(admin.token, "POST", retry)
    assert.equal(requeued.status, 200, summary(requeued))
    assert.equal(requeued.headers.get("cache-control"), "no-store")
    assert.equal((await den.request(admin.token, "POST", retry)).status, 404)
    const [row] = await db.$primary.select().from(HarnessFeedbackGroupTable).where(eq(HarnessFeedbackGroupTable.id, id))
    assert.equal(row?.notifyState, "pending")
    assert.equal(row?.notifyAttempts, 0)
  } finally {
    env.harnessFeedbackOrgIds.clear()
  }
})
