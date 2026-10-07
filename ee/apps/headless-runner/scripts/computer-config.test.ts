import assert from "node:assert/strict"
import { test } from "node:test"
import { loadConfig } from "../src/config.js"
const base = { HEADLESS_API_TOKEN: "test-token-123456789012345678901234567890", HEADLESS_MODEL_PROTOCOL: "anthropic", HEADLESS_MODEL_BASE_URL: "https://example.com/v1", HEADLESS_MODEL: "test-model" }
test("computer remains off by default", () => assert.equal(loadConfig(base).computer, undefined))
test("Freestyle's existing settings still select Freestyle", () => {
  const config = loadConfig({ ...base, HEADLESS_COMPUTER: "freestyle", FREESTYLE_API_KEY: "test" })
  assert.equal(config.computer?.kind, "freestyle")
  assert.equal(config.computer?.snapshot, undefined)
})
test("Daytona requires its own key and prepared computer snapshot", () => {
  assert.throws(() => loadConfig({ ...base, HEADLESS_COMPUTER: "daytona" }), /DAYTONA_API_KEY/)
  assert.throws(() => loadConfig({ ...base, HEADLESS_COMPUTER: "daytona", DAYTONA_API_KEY: "test" }), /HEADLESS_COMPUTER_SNAPSHOT/)
  assert.equal(loadConfig({ ...base, HEADLESS_COMPUTER: "daytona", DAYTONA_API_KEY: "test", HEADLESS_COMPUTER_SNAPSHOT: "computer-image" }).computer?.kind, "daytona")
})
