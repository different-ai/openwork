import assert from "node:assert/strict"
import { test } from "node:test"
import { isDenDeviceClientId } from "../src/device-clients.ts"

test("known CLI, plugin and separately gated desktop device clients are registered", () => {
  assert.equal(isDenDeviceClientId("openwork-cli"), true)
  assert.equal(isDenDeviceClientId("openwork-opencode-plugin"), true)
  assert.equal(isDenDeviceClientId("openwork-desktop-device"), true)
  assert.equal(isDenDeviceClientId("someone-else"), false)
})
