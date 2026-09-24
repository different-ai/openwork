import assert from "node:assert/strict"
import { test } from "node:test"
import { isGatewayUsageAccountable, type GatewayUsagePreflight } from "../src/usage-limits.js"
import { createPricingCatalog } from "../src/pricing.js"
import { hasGatewayUsageLimitHttpMarker } from "@openwork/types/den/gateway-usage-limits"

const request: GatewayUsagePreflight = {
  protocol: "openai_chat",
  providerId: "openai",
  modelId: "known",
  upstreamOrigin: "https://api.openai.com",
  upstreamPath: "/v1/chat/completions",
  deferred: false,
}
const pricing = createPricingCatalog({
  openai: { models: { known: { cost: { input: 1, output: 2 } } } },
})

test("inline accounting requires selected catalog pricing or a known monetary reporting path", () => {
  assert.equal(isGatewayUsageAccountable(request, pricing), true)
  assert.equal(isGatewayUsageAccountable({ ...request, modelId: "unknown" }, pricing), false)
  assert.equal(isGatewayUsageAccountable({ ...request, providerId: "unknown" }, pricing), false)
  assert.equal(isGatewayUsageAccountable({ ...request, protocol: "passthrough" }, pricing), false)
  assert.equal(isGatewayUsageAccountable({ ...request, deferred: true }, pricing), false)
})

test("reported-cost exception is limited to official OpenRouter chat and never deferred execution", () => {
  const reported: GatewayUsagePreflight = {
    ...request,
    providerId: "openrouter",
    modelId: "unknown",
    upstreamOrigin: "https://openrouter.ai",
    upstreamPath: "/api/v1/chat/completions",
  }
  assert.equal(isGatewayUsageAccountable(reported, null), true)
  assert.equal(isGatewayUsageAccountable({ ...reported, deferred: true }, null), false)
  assert.equal(
    isGatewayUsageAccountable({ ...reported, upstreamOrigin: "https://proxy.example.test" }, null),
    false,
  )
  assert.equal(
    isGatewayUsageAccountable(
      { ...reported, protocol: "openai_responses", upstreamPath: "/api/v1/responses" },
      null,
    ),
    false,
  )
})

test("JSON origin fields cannot replace an HTTP429 and canonical transport markers", () => {
  const headers = {
    "X-OpenWork-Error-Code": "openwork_gateway_usage_limit_exceeded",
    "X-OpenWork-Usage-State": "blocked",
  }
  const body = {
    error: { source: "openwork_gateway", code: "openwork_gateway_usage_limit_exceeded" },
  }
  assert.equal(hasGatewayUsageLimitHttpMarker(Response.json(body, { status: 200, headers })), false)
  assert.equal(hasGatewayUsageLimitHttpMarker(Response.json(body, { status: 429 })), false)
  assert.equal(hasGatewayUsageLimitHttpMarker(Response.json(body, { status: 429, headers })), true)
})
