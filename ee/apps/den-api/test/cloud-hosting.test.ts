import assert from "node:assert/strict"
import { test } from "node:test"
import { cloudHostingAvailable } from "../src/capability-sources/cloud-hosting.ts"

test("multi-org deployments always host Cloud", () => {
  assert.equal(cloudHostingAvailable({ orgMode: "multi_org", openworkWebEnabled: false }), true)
  assert.equal(cloudHostingAvailable({ orgMode: "multi_org", openworkWebEnabled: true }), true)
})

test("single-org installs host Cloud only when OpenWork Web is on", () => {
  assert.equal(cloudHostingAvailable({ orgMode: "single_org", openworkWebEnabled: false }), false)
  assert.equal(cloudHostingAvailable({ orgMode: "single_org", openworkWebEnabled: true }), true)
})
