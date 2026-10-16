import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { loadConfig } from "../src/config.js"
import { gatewayModelCatalog } from "../src/runtime.js"

const base = {
  HEADLESS_API_TOKEN: "test-token-123456789012345678901234567890",
  HEADLESS_MODEL_PROTOCOL: "openai",
  HEADLESS_MODEL_BASE_URL: "https://gateway.example.com/api/v1",
  HEADLESS_MODEL: "set-a-default-model-in-den",
}
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Records the Authorization header of each model-list call and answers with one model. */
function stubGateway() {
  const seen: Array<string | null> = []
  globalThis.fetch = async (_url, init) => {
    seen.push(new Headers(init?.headers).get("authorization"))
    return Response.json({ data: [{ id: "gwm_sonnet", name: "Sonnet" }] })
  }
  return seen
}

test("a runner without a key lists only its default model when no caller key is sent", async () => {
  const seen = stubGateway()
  const catalog = await gatewayModelCatalog(loadConfig(base))()
  assert.deepEqual(catalog.models, [{ id: "set-a-default-model-in-den", name: "set-a-default-model-in-den" }])
  assert.equal(seen.length, 0)
})

test("a runner without a key lists the Gateway's models with the caller's key", async () => {
  const seen = stubGateway()
  const catalog = await gatewayModelCatalog(loadConfig(base))("gw_member_key")
  assert.deepEqual(catalog.models, [{ id: "gwm_sonnet", name: "Sonnet" }])
  assert.deepEqual(seen, ["Bearer gw_member_key"])
})

test("the runner's own key wins over a caller's key", async () => {
  const seen = stubGateway()
  await gatewayModelCatalog(loadConfig({ ...base, HEADLESS_MODEL_API_KEY: "gw_runner_key" }))("gw_member_key")
  assert.deepEqual(seen, ["Bearer gw_runner_key"])
})
