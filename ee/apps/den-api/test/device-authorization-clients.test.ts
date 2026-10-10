import assert from "node:assert/strict"
import { test } from "node:test"
import { isEnabledDenDeviceClientId } from "../src/device-clients.ts"

test("the OpenCode plugin's device client follows the opencodePlugin rollout; the CLI client is always allowed", async () => {
  const on = async () => true
  const off = async () => false
  assert.equal(await isEnabledDenDeviceClientId("openwork-cli", off), true)
  assert.equal(await isEnabledDenDeviceClientId("openwork-opencode-plugin", on), true)
  assert.equal(await isEnabledDenDeviceClientId("openwork-opencode-plugin", off), false)
  assert.equal(await isEnabledDenDeviceClientId("someone-else", on), false)
})
