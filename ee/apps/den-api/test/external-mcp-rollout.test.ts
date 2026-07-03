import { describe, expect, test } from "bun:test"
import { memberFacingMcpConnectionsEnabled } from "../src/capability-sources/external-mcp-rollout.js"

describe("memberFacingMcpConnectionsEnabled", () => {
  test("gating disabled: enabled for every org, regardless of metadata", () => {
    for (const metadata of [null, undefined, "", "{}", "not json", { mcpConnectionsEnabled: false }, { mcpConnectionsEnabled: true }]) {
      expect(memberFacingMcpConnectionsEnabled(metadata, { gatingEnabled: false })).toBe(true)
    }
  })

  test("gating enabled: disabled unless the org explicitly opted in", () => {
    for (const metadata of [
      null,
      undefined,
      "",
      "{}",
      "not json",
      "[]",
      JSON.stringify({ limits: { members: 5 } }),
      JSON.stringify({ mcpConnectionsEnabled: false }),
      JSON.stringify({ mcpConnectionsEnabled: "true" }),
      { mcpConnectionsEnabled: false },
      {},
    ]) {
      expect(memberFacingMcpConnectionsEnabled(metadata, { gatingEnabled: true })).toBe(false)
    }
  })

  test("gating enabled: opted-in orgs are enabled (string and object metadata)", () => {
    expect(memberFacingMcpConnectionsEnabled(JSON.stringify({ mcpConnectionsEnabled: true }), { gatingEnabled: true })).toBe(true)
    expect(memberFacingMcpConnectionsEnabled({ mcpConnectionsEnabled: true }, { gatingEnabled: true })).toBe(true)
    expect(
      memberFacingMcpConnectionsEnabled(
        JSON.stringify({ limits: { members: 100 }, plan: { tier: "team" }, mcpConnectionsEnabled: true }),
        { gatingEnabled: true },
      ),
    ).toBe(true)
  })
})
