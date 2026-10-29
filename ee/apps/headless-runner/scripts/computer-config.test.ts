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

test("VM and desktop capabilities require explicit operator configuration", () => {
  const env = { ...base, HEADLESS_COMPUTER: "daytona", DAYTONA_API_KEY: "test", HEADLESS_COMPUTER_SNAPSHOT: "computer-image" }
  assert.equal(loadConfig(env).computer?.desktop, false)
  assert.equal(loadConfig(env).computer?.sandboxClass, "container")
  const vm = loadConfig({ ...env, HEADLESS_COMPUTER_CLASS: "linux-vm", HEADLESS_COMPUTER_DESKTOP: "true" }).computer
  assert.equal(vm?.desktop, true)
  assert.equal(vm?.sandboxClass, "linux-vm")
  assert.throws(() => loadConfig({ ...env, HEADLESS_COMPUTER_DESKTOP: "true" }), /HEADLESS_COMPUTER_CLASS=linux-vm/)
})

test("a Freestyle desktop needs its desktop snapshot, and persistence and the viewer domain come from env", () => {
  const env = { ...base, HEADLESS_COMPUTER: "freestyle", FREESTYLE_API_KEY: "test", HEADLESS_COMPUTER_DESKTOP: "true" }
  assert.throws(() => loadConfig(env), /snapshot:build:freestyle-desktop/)
  const computer = loadConfig({ ...env, HEADLESS_COMPUTER_SNAPSHOT: "workbot-desktop-freestyle", HEADLESS_COMPUTER_PERSISTENT: "true", HEADLESS_COMPUTER_DOMAIN: "computers.example.com" }).computer
  assert.equal(computer?.desktop, true)
  assert.equal(computer?.persistent, true)
  assert.equal(computer?.endpointDomain, "computers.example.com")
  assert.equal(loadConfig({ ...env, HEADLESS_COMPUTER_SNAPSHOT: "desktop" }).computer?.persistent, false)
  assert.throws(() => loadConfig({ ...env, HEADLESS_COMPUTER_SNAPSHOT: "desktop", HEADLESS_COMPUTER_DOMAIN: "https://bad" }), /lowercase domain/)
})

test("the sandbox gateway is its own setting, off unless chosen, and needs its URL, key and template", () => {
  assert.equal(loadConfig(base).computerGateway, undefined)
  const env = { ...base, SANDBOX_GATEWAY: "differently" }
  assert.throws(() => loadConfig(env), /SANDBOX_GATEWAY_URL, SANDBOX_GATEWAY_API_KEY, SANDBOX_GATEWAY_TEMPLATE/)
  assert.throws(() => loadConfig({ ...env, SANDBOX_GATEWAY_URL: "http://gateway.example.com", SANDBOX_GATEWAY_API_KEY: "k", SANDBOX_GATEWAY_TEMPLATE: "t" }), /SANDBOX_GATEWAY_URL/)
  const config = loadConfig({ ...env, HEADLESS_COMPUTER: "freestyle", FREESTYLE_API_KEY: "test", SANDBOX_GATEWAY_URL: "https://gateway.example.com", SANDBOX_GATEWAY_API_KEY: "k", SANDBOX_GATEWAY_TEMPLATE: "workbot-computer", HEADLESS_COMPUTER_SCOPE: "cell-a" })
  assert.equal(config.computer?.kind, "freestyle")
  assert.deepEqual(
    { kind: config.computerGateway?.kind, url: config.computerGateway?.url, template: config.computerGateway?.template, scope: config.computerGateway?.scope },
    { kind: "differently", url: "https://gateway.example.com", template: "workbot-computer", scope: "cell-a" },
  )
  // A gateway alone is enough: only conversations with the setting on get a computer.
  assert.equal(loadConfig({ ...env, SANDBOX_GATEWAY_URL: "http://127.0.0.1:8080", SANDBOX_GATEWAY_API_KEY: "k", SANDBOX_GATEWAY_TEMPLATE: "t" }).computer, undefined)
  assert.throws(() => loadConfig({ ...base, HEADLESS_COMPUTER: "differently" }))
})
