/**
 * A member's own AI Gateway usage (GET /v1/gateway/usage/me, the My Usage page): any member reads only their own
 * rows, from raw request logs and retained rollups, with the models they can use and those models' listed prices.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { gatewayMemberUsageResponseSchema } from "@openwork/types/den/gateway-member-usage"
import { bootDen, field, list, summary, type Member } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels } from "./gateway-fixture.js"

// ARRANGE ONLY: the public catalog Den reads, with a price on one model and none on the other.
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== "https://models.openworklabs.com/api.json") return realFetch(input, init)
  return Response.json({
    openai: { id: "openai", name: "Fixture OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], api: "https://api.openai.com/v1", models: {
      "gpt-6-luna": { id: "gpt-6-luna", name: "Fixture Luna", limit: { context: 100000, output: 1000 }, cost: { input: 2, output: 8, cache_read: 0.5 } },
      "gpt-fixture-other": { id: "gpt-fixture-other", name: "Fixture Other", limit: { context: 100000, output: 1000 } },
    } },
  })
}

const den = await bootDen({ env: gatewayFixtureEnv })
after(async () => {
  globalThis.fetch = realFetch
  await den.close()
})
const { client } = await import("../../src/db.js")
const { env } = await import("../../src/env.js")

const owner = await den.signUp("Usage Owner")
const { orgId } = await den.createOrg(owner, "Member usage workspace")
const member = await den.newMember(owner, orgId, "Usage Member")
const peer = await den.newMember(owner, orgId, "Usage Peer")
await grantGatewayModels(den, owner, orgId, [member], ["gpt-6-luna", "gpt-fixture-other"])

const today = new Date()
const hoursAgo = (hours: number) => new Date(Math.floor(today.getTime() / 3_600_000) * 3_600_000 - hours * 3_600_000)

/** ARRANGE ONLY: one completed Gateway request, as the Gateway records it. */
async function logRequest(person: Member, input: { model?: string; inputTokens: number | null; outputTokens: number | null; cacheRead?: number; costMicroUsd: number | null; at?: Date }) {
  const at = input.at ?? hoursAgo(1)
  const total = input.inputTokens === null || input.outputTokens === null ? null : input.inputTokens + input.outputTokens
  await client.execute(
    `INSERT INTO gateway_request_logs (id, organization_id, org_membership_id, route, protocol, upstream_provider_id, upstream_host, upstream_path, method, upstream_model, stream, status, outcome, input_tokens, output_tokens, total_tokens, cache_read_tokens, usage_source, cost_micro_usd, openwork_request_id, started_at, completed_at)
     VALUES (?, ?, ?, 'org_provider', 'openai_chat', 'openai', 'api.openai.com', '/v1/chat/completions', 'POST', ?, false, 200, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [createDenTypeId("inferenceRequestLog"), orgId, person.memberId, input.model ?? "gpt-6-luna", input.inputTokens, input.outputTokens, total, input.cacheRead ?? null,
      total === null ? "missing" : "json", input.costMicroUsd, createDenTypeId("inferenceRequestLog").slice(-32), at, at],
  )
}

/** ARRANGE ONLY: a retained hourly summary, as retention writes it after raw logs age out. */
async function logRollup(person: Member, input: { requests: number; inputTokens: number; outputTokens: number; costMicroUsd: number; at: Date }) {
  await client.execute(
    `INSERT INTO gateway_usage_rollups (id, granularity, bucket_start, dimension_key, organization_id, org_membership_id, route, protocol, upstream_provider_id, upstream_model, request_count, ok_count, input_tokens, output_tokens, total_tokens, cost_micro_usd, input_tokens_count, output_tokens_count, total_tokens_count, cost_count, uncountable_ok_count, uncountable_upstream_error_count, uncountable_upstream_unreachable_count, uncountable_client_aborted_count, uncountable_rejected_count)
     VALUES (?, 'hour', ?, ?, ?, ?, 'org_provider', 'openai_chat', 'openai', 'gpt-6-luna', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)`,
    [createDenTypeId("inferenceUsageRollup"), input.at, createDenTypeId("inferenceUsageRollup").slice(-32), orgId, person.memberId,
      input.requests, input.requests, input.inputTokens, input.outputTokens, input.inputTokens + input.outputTokens, input.costMicroUsd,
      input.requests, input.requests, input.requests, input.requests],
  )
}

const asMember = den.as(member, orgId)
const asPeer = den.as(peer, orgId)

test("a member with no Gateway permissions reads empty usage as zeros, not an error", async () => {
  const empty = await asPeer("GET", "/v1/gateway/usage/me")
  assert.equal(empty.status, 200, summary(empty))
  const parsed = gatewayMemberUsageResponseSchema.parse(empty.body)
  assert.equal(parsed.usage.days, 30)
  assert.equal(parsed.usage.daily.length, 30)
  assert.equal(parsed.usage.totalTokens, 0)
  assert.equal(parsed.usage.totalCostMicroUsd, 0)
  assert.equal(parsed.usage.requestCount, 0)
  assert.deepEqual(parsed.usage.series, [])
  assert.deepEqual(parsed.tokenMix, [])
  // The peer has no grant, so no models either.
  assert.deepEqual(parsed.models, [])
  // The admin report still needs its permission.
  const admin = await asPeer("GET", "/v1/inference-providers/usage")
  assert.equal(admin.status, 403, summary(admin))
})

test("returns only the caller's rows, from raw logs and rollups, with the models they can use", async () => {
  await logRequest(member, { inputTokens: 1000, outputTokens: 200, cacheRead: 400, costMicroUsd: 3000 })
  await logRequest(member, { inputTokens: 500, outputTokens: 100, costMicroUsd: 1800, at: hoursAgo(30) })
  // Requests without a price count as unpriced, not as $0 of spend.
  await logRequest(member, { model: "gpt-fixture-other", inputTokens: 300, outputTokens: 30, costMicroUsd: null })
  await logRollup(member, { requests: 2, inputTokens: 2000, outputTokens: 500, costMicroUsd: 8000, at: hoursAgo(24 * 5) })
  // Another member's usage on the same days must never show up.
  await logRequest(peer, { inputTokens: 9_000_000, outputTokens: 9_000_000, costMicroUsd: 9_000_000 })
  await logRollup(peer, { requests: 7, inputTokens: 7_000_000, outputTokens: 7_000_000, costMicroUsd: 7_000_000, at: hoursAgo(24 * 5) })

  const result = await asMember("GET", "/v1/gateway/usage/me")
  assert.equal(result.status, 200, summary(result))
  assert.equal(result.headers.get("cache-control"), "no-store")
  const { usage, tokenMix, models } = gatewayMemberUsageResponseSchema.parse(result.body)
  assert.equal(usage.groupBy, "model")
  assert.equal(usage.requestCount, 5)
  assert.equal(usage.totalTokens, 1200 + 600 + 330 + 2500)
  assert.equal(usage.totalCostMicroUsd, 3000 + 1800 + 8000)
  assert.equal(usage.unpricedRequests, 1)
  assert.deepEqual(usage.filterOptions, [], "a member never sees the organization's provider list")
  assert.deepEqual(usage.series.map((series) => series.label).sort(), ["Fixture Luna", "Fixture Other"])

  const luna = tokenMix.find((mix) => mix.seriesId === models.find((model) => model.upstreamModelId === "gpt-6-luna")?.seriesId)
  assert.ok(luna, "token mix for the priced model")
  assert.equal(luna.measuredRequests, 4)
  assert.equal(luna.uncachedInputTokens, (1000 - 400) + 500 + 2000)
  assert.equal(luna.cacheReadTokens, 400)
  assert.equal(luna.outputTokens, 200 + 100 + 500)

  assert.deepEqual(models.map((model) => model.upstreamModelId).sort(), ["gpt-fixture-other", "gpt-6-luna"].sort())
  assert.deepEqual(models.find((model) => model.upstreamModelId === "gpt-6-luna")?.price, { input: 2, output: 8, cacheRead: 0.5, cacheWrite: null, contextTiers: [] })
  assert.equal(models.find((model) => model.upstreamModelId === "gpt-fixture-other")?.price, null)
})

test("the query names nothing but the period: no member, grouping or filters", async () => {
  for (const query of [`memberId=${peer.memberId}`, "groupBy=person", "groupBy=team", "filterIds=openwork", "days=0", "days=367", "days=abc"]) {
    const result = await asMember("GET", `/v1/gateway/usage/me?${query}`)
    assert.equal(result.status, 400, `${query}: ${summary(result)}`)
  }
  const week = await asMember("GET", "/v1/gateway/usage/me?days=7")
  assert.equal(week.status, 200, summary(week))
  const { usage } = gatewayMemberUsageResponseSchema.parse(week.body)
  assert.equal(usage.days, 7)
  assert.equal(usage.daily.length, 7)
  // The rollup five days ago is in; nothing older is.
  assert.equal(usage.totalCostMicroUsd, 3000 + 1800 + 8000)
})

test("a peer still sees only their own usage once both have requests", async () => {
  const result = await asPeer("GET", "/v1/gateway/usage/me")
  assert.equal(result.status, 200, summary(result))
  const { usage } = gatewayMemberUsageResponseSchema.parse(result.body)
  assert.equal(usage.requestCount, 8)
  assert.equal(usage.totalCostMicroUsd, 16_000_000)
  assert.equal(list(field(result.body, "models")).length, 0)
})

test("Gateway management off answers the usual gateway_not_enabled", async () => {
  env.gatewayEnabled = false
  try {
    const result = await asMember("GET", "/v1/gateway/usage/me")
    assert.equal(result.status, 403, summary(result))
    assert.equal(field(result.body, "error"), "gateway_not_enabled")
  } finally {
    env.gatewayEnabled = true
  }
})
