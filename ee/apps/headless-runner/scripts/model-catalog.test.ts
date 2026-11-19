import assert from "node:assert/strict"
import { test } from "node:test"
import { loadConfig } from "../src/config.js"
import { gatewayModelCatalog } from "../src/model-catalog.js"

const env = { HEADLESS_API_TOKEN: "test-token-123456789012345678901234567890", HEADLESS_MODEL_PROTOCOL: "openai", HEADLESS_MODEL_BASE_URL: "http://127.0.0.1:3000/v1", HEADLESS_MODEL: "configured-model" }

test("a configured default without a shared model key is not verified readiness", async () => {
  const read = gatewayModelCatalog(loadConfig(env), async () => { throw new Error("must not call") })
  assert.deepEqual(await read(), { defaultModel: "configured-model", models: [{ id: "configured-model", name: "configured-model" }], verified: false })
})

test("catalog verification requires the configured gateway to accept the model key", async () => {
  let calls = 0
  const models = [{ id: "luna-alias", name: "GPT-6 Luna" }]
  const read = gatewayModelCatalog(loadConfig({ ...env, HEADLESS_MODEL_API_KEY: "fixture-key" }), async (input) => {
    assert.equal(input.apiKey, "fixture-key")
    calls += 1
    return models
  })
  assert.deepEqual(await read(), { defaultModel: "configured-model", models, verified: true })
  await read()
  assert.equal(calls, 1)
})

test("gateway failure and an empty authorized list never invent a servable default", async () => {
  const config = loadConfig({ ...env, HEADLESS_MODEL_API_KEY: "fixture-key" })
  const failure = gatewayModelCatalog(config, async () => { throw new Error("unreachable") })
  assert.equal((await failure()).verified, false)
  const empty = gatewayModelCatalog(config, async () => [])
  assert.deepEqual(await empty(), { defaultModel: "configured-model", models: [{ id: "configured-model", name: "configured-model" }], verified: false })
})
