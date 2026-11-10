/**
 * What Workbot spent (GET /v1/workbot-usage), on real MySQL: request logs the headless runner tagged with its
 * conversation count as Workbot usage, the gateway's rollup folds them into workbot_usage_day exactly as the read
 * counted them, and the read then adds the folded days to the logs that are not folded yet.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const { db } = await import("../../src/db.js")
const { foldWorkbotUsage } = await import("@openwork-ee/den-db")
const { GatewayRequestLogTable, WorkbotUsageDayTable } = await import("@openwork-ee/den-db/schema")
const { eq, inArray } = await import("@openwork-ee/den-db/drizzle")
const { createDenTypeId, normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")

const DAY_MS = 86_400_000
const today = new Date(Math.floor(Date.now() / DAY_MS) * DAY_MS)
const chat = `hs_wb_${"a".repeat(40)}`
const agent = `hs_agent_${"b".repeat(40)}`
const slack = "hs_5f0c1c1e9d5b4c0f8a11"

type LogInput = {
  orgId: string; memberId: string; session?: string; model?: string | null
  cost?: number | null; input?: number; output?: number; outcome?: "ok" | "rejected"; at?: Date
}

async function log(input: LogInput) {
  const id = createDenTypeId("inferenceRequestLog")
  const at = input.at ?? new Date(today.getTime() + 60_000)
  await db.insert(GatewayRequestLogTable).values({
    id,
    organization_id: normalizeDenTypeId("organization", input.orgId),
    org_membership_id: normalizeDenTypeId("member", input.memberId),
    route: "openwork_openrouter", protocol: "openai_chat", upstream_provider_id: "openrouter",
    upstream_host: "openrouter.example", upstream_path: "/chat/completions", method: "POST",
    requested_model: "auto", upstream_model: input.model === undefined ? "gpt-6-luna" : input.model,
    stream: true, status: input.outcome === "rejected" ? 429 : 200, outcome: input.outcome ?? "ok",
    input_tokens: input.input ?? 100, output_tokens: input.output ?? 10,
    usage_source: "stream", cost_micro_usd: input.cost === undefined ? 1_000 : input.cost,
    openwork_request_id: id.slice(-32), started_at: at, completed_at: at,
    metadata: { cost_source: "upstream", ...(input.session ? { headless_session: input.session } : {}) },
  })
  return id
}

function usage(body: unknown) {
  const totals = field(body, "totals")
  return {
    cost: Number(field(totals, "costMicroUsd")), requests: Number(field(totals, "requests")),
    unpriced: Number(field(totals, "unpricedRequests")), members: Number(field(totals, "members")),
    input: Number(field(totals, "inputTokens")), output: Number(field(totals, "outputTokens")),
    surfaces: list(field(body, "surfaces")).map((row) => [row.surface, row.costMicroUsd, row.requests]),
    models: list(field(body, "models")).map((row) => [row.model, row.costMicroUsd, row.requests]),
    people: list(field(body, "members")).map((row) => [row.memberId, row.name, row.costMicroUsd, row.requests]),
    days: list(field(body, "daily")).filter((row) => Number(row.requests) > 0).map((row) => [row.day, row.costMicroUsd, row.requests]),
  }
}

test("Workbot usage counts tagged requests, before and after the rollup folds them", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Wanda Workbot"), "Workbot usage org")
  const member = await den.newMember(owner, orgId, "Milo Member")
  const other = await den.createOrg(await den.signUp("Olga Other"), "Other usage org")
  const read = () => den.as(owner, orgId)("GET", "/v1/workbot-usage")

  // Off until the feature is turned on for the organization.
  const off = await read()
  assert.equal(off.status, 404, summary(off))
  for (const id of [orgId, other.orgId]) assert.equal((await den.setFeature(id, "workbotUsageAnalytics", true)).status, 200)

  const empty = await read()
  assert.equal(empty.status, 200, summary(empty))
  assert.equal(field(empty.body, "since"), null)
  assert.deepEqual(usage(empty.body), { cost: 0, requests: 0, unpriced: 0, members: 0, input: 0, output: 0, surfaces: [], models: [], people: [], days: [] })
  assert.equal(list(field(empty.body, "daily")).length, 30)

  const ids = [
    await log({ orgId, memberId: owner.memberId, session: chat, cost: 2_000 }),
    await log({ orgId, memberId: owner.memberId, session: chat, cost: 3_000, model: "claude-opus-5-5", input: 400, output: 40 }),
    await log({ orgId, memberId: member.memberId, session: agent, cost: 700 }),
    // Finished but never priced: counted, adds no cost.
    await log({ orgId, memberId: member.memberId, session: slack, cost: null, model: null }),
    // Refused before it ran: a request, not an unpriced one.
    await log({ orgId, memberId: owner.memberId, session: chat, cost: null, outcome: "rejected", input: 0, output: 0 }),
    // The desktop app's own request (no conversation tag) and another organization's Workbot: neither counts here.
    await log({ orgId, memberId: owner.memberId, cost: 50_000 }),
    await log({ orgId: other.orgId, memberId: other.owner.memberId, session: chat, cost: 90_000 }),
  ]
  const day = today.toISOString().slice(0, 10)
  const expected = {
    cost: 5_700, requests: 5, unpriced: 1, members: 2, input: 700, output: 70,
    surfaces: [["chat", 5_000, 3], ["agent", 700, 1], ["other", 0, 1]],
    // A request whose answering model the gateway never learned keeps the model it asked for.
    models: [["claude-opus-5-5", 3_000, 1], ["gpt-6-luna", 2_700, 3], ["auto", 0, 1]],
    people: [[owner.memberId, owner.name, 5_000, 3], [member.memberId, member.name, 700, 2]],
    days: [[day, 5_700, 5]],
  }

  const live = await read()
  assert.equal(live.status, 200, summary(live))
  assert.deepEqual(usage(live.body), expected)
  assert.equal(field(live.body, "since"), day)

  // The gateway's rollup: fold the batch, then delete it, in one transaction.
  await db.transaction(async (tx) => {
    await foldWorkbotUsage(tx, today, ids)
    await tx.delete(GatewayRequestLogTable).where(inArray(GatewayRequestLogTable.id, ids))
  })
  const rows = await db.select().from(WorkbotUsageDayTable).where(eq(WorkbotUsageDayTable.organization_id, normalizeDenTypeId("organization", orgId)))
  assert.equal(rows.length, 4)
  assert.ok(!JSON.stringify(rows).includes("hs_"), "no conversation id is kept")
  const folded = await read()
  assert.deepEqual(usage(folded.body), expected)
  assert.equal(field(folded.body, "since"), day)

  // A later batch of the same day adds to the same rows, and new logs still count on top.
  const second = [await log({ orgId, memberId: owner.memberId, session: chat, cost: 1_000 })]
  await db.transaction(async (tx) => {
    await foldWorkbotUsage(tx, today, second)
    await tx.delete(GatewayRequestLogTable).where(inArray(GatewayRequestLogTable.id, second))
  })
  await log({ orgId, memberId: member.memberId, session: agent, cost: 300 })
  const again = usage((await read()).body)
  assert.equal((await db.select().from(WorkbotUsageDayTable).where(eq(WorkbotUsageDayTable.organization_id, normalizeDenTypeId("organization", orgId)))).length, 4)
  assert.deepEqual([again.cost, again.requests, again.surfaces], [7_000, 7, [["chat", 6_000, 4], ["agent", 1_000, 2], ["other", 0, 1]]])

  // The other organization sees only its own; a member without the analytics permission sees none of it.
  const theirs = usage((await den.as(other.owner, other.orgId)("GET", "/v1/workbot-usage")).body)
  assert.deepEqual([theirs.cost, theirs.requests, theirs.members], [90_000, 1, 1])
  const denied = await den.as(member, orgId)("GET", "/v1/workbot-usage")
  assert.equal(denied.status, 403, summary(denied))
})
