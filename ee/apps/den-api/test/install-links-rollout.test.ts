import { describe, expect, test } from "bun:test"
import { organizationInstallLinksEnabled } from "../src/capability-sources/install-links-rollout.js"

type MetadataInput = Parameters<typeof organizationInstallLinksEnabled>[0]

function expectWithDeprecatedGate(metadata: MetadataInput, expected: boolean) {
  for (const gatingEnabled of [false, true]) {
    expect(organizationInstallLinksEnabled(metadata, { gatingEnabled })).toBe(expected)
  }
}

describe("organizationInstallLinksEnabled", () => {
  test("absent, empty, and unparseable metadata are enabled by default", () => {
    for (const metadata of [null, undefined, "", "{}", "not json", "[]", {}, JSON.stringify({ limits: { members: 5 } })]) {
      expectWithDeprecatedGate(metadata, true)
    }
  })

  test("capability true enables and capability false disables", () => {
    for (const metadata of [
      { capabilities: { installLinks: true } },
      JSON.stringify({ capabilities: { installLinks: true } }),
      JSON.stringify({ limits: { members: 100 }, plan: { tier: "team" }, capabilities: { installLinks: true } }),
    ]) {
      expectWithDeprecatedGate(metadata, true)
    }

    for (const metadata of [
      { capabilities: { installLinks: false } },
      JSON.stringify({ capabilities: { installLinks: false } }),
    ]) {
      expectWithDeprecatedGate(metadata, false)
    }
  })

  test("non-boolean values are ignored and fall through to default on", () => {
    for (const metadata of [
      { capabilities: { installLinks: "true" } },
      { capabilities: { installLinks: 1 } },
      JSON.stringify({ capabilities: { installLinks: "false" } }),
      JSON.stringify({ capabilities: { installLinks: null } }),
    ]) {
      expectWithDeprecatedGate(metadata, true)
    }
  })
})
