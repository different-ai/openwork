import { describe, expect, test } from "bun:test"
import { cloudHostingAvailable } from "../src/capability-sources/cloud-hosting.js"

describe("cloudHostingAvailable", () => {
  test("offers Cloud on hosted multi-org deployments without a per-organization flag", () => {
    expect(cloudHostingAvailable({ orgMode: "multi_org" })).toBe(true)
  })

  test("never offers Cloud on single-org (self-hosted) deployments", () => {
    expect(cloudHostingAvailable({ orgMode: "single_org" })).toBe(false)
  })
})
