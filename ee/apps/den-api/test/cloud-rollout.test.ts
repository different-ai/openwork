import { describe, expect, test } from "bun:test"
import { organizationCloudEnabled } from "../src/capability-sources/cloud-rollout.js"

describe("organizationCloudEnabled", () => {
  test("is off when metadata is absent, empty, or unparseable", () => {
    for (const metadata of [null, undefined, "", "{}", "not json", "[]", {}, JSON.stringify({ limits: { members: 5 } })]) {
      expect(organizationCloudEnabled(metadata, { orgMode: "multi_org" })).toBe(false)
    }
  })

  test("stays off for single-org deployments even with a literal opt-in", () => {
    for (const metadata of [
      { capabilities: { cloud: true } },
      JSON.stringify({ capabilities: { cloud: true } }),
    ]) {
      expect(organizationCloudEnabled(metadata, { orgMode: "single_org" })).toBe(false)
    }
  })

  test("is on only for multi-org deployments with a literal opt-in", () => {
    expect(organizationCloudEnabled({ capabilities: { cloud: true } }, { orgMode: "multi_org" })).toBe(true)
    expect(organizationCloudEnabled(JSON.stringify({ capabilities: { cloud: true } }), { orgMode: "multi_org" })).toBe(true)
    expect(organizationCloudEnabled({ capabilities: { cloud: false } }, { orgMode: "multi_org" })).toBe(false)
    expect(organizationCloudEnabled({ capabilities: { cloud: "true" } }, { orgMode: "multi_org" })).toBe(false)
  })
})
