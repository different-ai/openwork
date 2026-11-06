import assert from "node:assert/strict"
import test from "node:test"
import { dedupeLiteLlmModelIds } from "../src/llm/litellm.js"

process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-litellm-case-test-key-000000000"
process.env.BETTER_AUTH_SECRET ??= "synthetic-litellm-case-test-secret-0000000"
process.env.DEN_BASE_URL ??= "https://console.example.test"
const { gatewayModelsChanged } = await import("../src/llm/gateway-matrix.js")

test("LiteLLM model IDs differing only by case keep the first one", () => {
  const ids = ["MoonshotAI/Kimi-K2.7-code", "gpt-4o", "moonshotai/kimi-k2.7-code"]
  assert.deepEqual(dedupeLiteLlmModelIds(ids), { modelIds: ["MoonshotAI/Kimi-K2.7-code", "gpt-4o"], dropped: ["moonshotai/kimi-k2.7-code"] })
})

test("gatewayModelsChanged matches stored model IDs case-insensitively", () => {
  const row = { id: "ipm_1", gateway_provider_id: "ipr_1", model_id: "moonshotai/kimi-k2.7-code", name: "moonshotai/kimi-k2.7-code", model_config: {}, created_at: new Date() } as never
  const same = { id: "moonshotai/kimi-k2.7-code", name: "moonshotai/kimi-k2.7-code", config: {} }
  assert.equal(gatewayModelsChanged([row], [same]), false)
  // A duplicate differing only by case is skipped, not treated as a new row.
  assert.equal(gatewayModelsChanged([row], [same, { ...same, id: "MoonshotAI/Kimi-K2.7-code" }]), false)
  // A case-only rename still counts as a change so the stored ID is updated.
  assert.equal(gatewayModelsChanged([row], [{ ...same, id: "MoonshotAI/Kimi-K2.7-code" }]), true)
})
