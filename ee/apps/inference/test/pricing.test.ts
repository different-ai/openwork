import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { InferenceReporter } from "../src/inference-reporting.js"
import { createPricingCatalog, estimateCostMicroUsd, loadPricingCatalogFromFile } from "../src/pricing.js"
import { createRequestLogRecorder } from "../src/request-log.js"
import type { InferenceRequestLogRow, RequestLogStartInput } from "../src/request-log.js"

const catalog = createPricingCatalog({
  anthropic: {
    models: {
      "claude-test": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
      "no-cache-price": { cost: { input: 2, output: 4 } },
    },
  },
  openrouter: {
    models: {
      "z-ai/glm-5.2": { cost: { input: 1, output: 2 } },
    },
  },
})

const zeroTokens = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null }

test("known model prices input/output tokens at USD per 1M", () => {
  const cost = estimateCostMicroUsd({ providerId: "anthropic", modelId: "claude-test", ...zeroTokens, inputTokens: 1_000_000, outputTokens: 1_000 }, catalog)
  // 1M input * $3/1M = $3 = 3_000_000 micro; 1000 output * $15/1M = $0.015 = 15_000 micro
  assert.equal(cost, 3_015_000)
})

test("unknown model or provider returns null", () => {
  assert.equal(estimateCostMicroUsd({ providerId: "anthropic", modelId: "nope", ...zeroTokens, inputTokens: 10 }, catalog), null)
  assert.equal(estimateCostMicroUsd({ providerId: "nobody", modelId: "claude-test", ...zeroTokens, inputTokens: 10 }, catalog), null)
})

test("cache tokens use cache prices and fall back to the input price", () => {
  const priced = estimateCostMicroUsd({ providerId: "anthropic", modelId: "claude-test", ...zeroTokens, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, catalog)
  assert.equal(priced, 300_000 + 3_750_000)
  const fallback = estimateCostMicroUsd({ providerId: "anthropic", modelId: "no-cache-price", ...zeroTokens, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, catalog)
  assert.equal(fallback, 2_000_000 + 2_000_000)
})

test("reasoning tokens bill as output without a separate reasoning price", () => {
  const cost = estimateCostMicroUsd({ providerId: "anthropic", modelId: "no-cache-price", ...zeroTokens, reasoningTokens: 1_000_000 }, catalog)
  assert.equal(cost, 4_000_000)
})

test("the bundled base.json prices openrouter models keyed by vendor/model", () => {
  const price = loadPricingCatalogFromFile().getModelPrice("openrouter", "z-ai/glm-5.2")
  assert.ok(price)
  assert.ok(price.input > 0 && price.output > 0)
})

function createRecorder(rows: InferenceRequestLogRow[]) {
  const reporter: InferenceReporter = { request() {}, handledError() {} }
  return createRequestLogRecorder({ insertRequestLog: async (row) => { rows.push(row) }, reporter, pricing: catalog })
}

function start(overrides: Partial<RequestLogStartInput> = {}): RequestLogStartInput {
  return {
    identity: {
      organizationId: createDenTypeId("organization"),
      orgMembershipId: createDenTypeId("member"),
      inferenceKeyId: createDenTypeId("inferenceKey"),
    },
    openworkRequestId: "req-1",
    route: "org_provider",
    protocol: "anthropic_messages",
    upstreamProviderId: "anthropic",
    upstreamHost: "api.anthropic.com",
    upstreamPath: "/v1/messages",
    method: "POST",
    requestedModel: "claude-test",
    upstreamModel: "claude-test",
    stream: false,
    ...overrides,
  }
}

test("recorder snapshots cost from pricing when upstream reports none", async () => {
  const rows: InferenceRequestLogRow[] = []
  const recorder = createRecorder(rows)
  recorder.start(start())
  recorder.setUsage({ usageSource: "json", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 1000 })
  await recorder.finish({ status: 200, outcome: "ok" })
  assert.equal(rows[0]?.cost_micro_usd, 3_000 + 1_500 + 300)
})

test("recorder leaves cost null for unknown models and missing usage", async () => {
  const rows: InferenceRequestLogRow[] = []
  const recorder = createRecorder(rows)
  recorder.start(start({ upstreamModel: "unknown-model" }))
  recorder.setUsage({ usageSource: "json", inputTokens: 1000, outputTokens: 100 })
  await recorder.finish({ status: 200, outcome: "ok" })
  assert.equal(rows[0]?.cost_micro_usd, null)

  const missing = createRecorder(rows)
  missing.start(start())
  await missing.finish({ status: 500, outcome: "upstream_error" })
  assert.equal(rows[1]?.cost_micro_usd, null)
})

test("openrouter usage.cost takes precedence over the pricing snapshot", async () => {
  const rows: InferenceRequestLogRow[] = []
  const recorder = createRecorder(rows)
  recorder.start(start({ route: "openwork_openrouter", protocol: "openai_chat", upstreamProviderId: "openrouter", upstreamHost: "openrouter.ai", upstreamPath: "/api/v1/chat/completions", requestedModel: "alias", upstreamModel: "z-ai/glm-5.2" }))
  recorder.setUsage({ usageSource: "json", inputTokens: 1_000_000, outputTokens: 0, costUsd: 0.5 })
  await recorder.finish({ status: 200, outcome: "ok" })
  assert.equal(rows[0]?.cost_micro_usd, 500_000)

  const estimated = createRecorder(rows)
  estimated.start(start({ route: "openwork_openrouter", protocol: "openai_chat", upstreamProviderId: "openrouter", upstreamModel: "z-ai/glm-5.2" }))
  estimated.setUsage({ usageSource: "json", inputTokens: 1_000_000, outputTokens: 0, reasoningTokens: 5_000 })
  await estimated.finish({ status: 200, outcome: "ok" })
  // OpenAI-style output tokens already include reasoning tokens, so they are not billed twice.
  assert.equal(rows[1]?.cost_micro_usd, 1_000_000)
})
