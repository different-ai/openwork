import { describe, expect, test } from "bun:test"
import { memberFacingMcpConnectionsEnabled } from "../src/capability-sources/external-mcp-rollout.js"

describe("memberFacingMcpConnectionsEnabled", () => {
  test("gating disabled: enabled for every org, regardless of metadata", () => {
    for (const metadata of [null, undefined, "", "{}", "not json", { capabilities: { mcpConnections: false } }, { mcpConnectionsEnabled: true }]) {
      expect(memberFacingMcpConnectionsEnabled(metadata, { gatingEnabled: false })).toBe(true)
    }
  })

  test("gating enabled: disabled unless the org has the mcpConnections capability", () => {
    for (const metadata of [
      null,
      undefined,
      "",
      "{}",
      "not json",
      "[]",
      JSON.stringify({ limits: { members: 5 } }),
      JSON.stringify({ capabilities: { mcpConnections: false } }),
      JSON.stringify({ capabilities: { mcpConnections: "true" } }),
      JSON.stringify({ mcpConnectionsEnabled: true }),
      { capabilities: { mcpConnections: false } },
      { mcpConnectionsEnabled: true },
      {},
    ]) {
      expect(memberFacingMcpConnectionsEnabled(metadata, { gatingEnabled: true })).toBe(false)
    }
  })

  test("gating enabled: orgs with the mcpConnections capability are enabled", () => {
    expect(memberFacingMcpConnectionsEnabled(JSON.stringify({ capabilities: { mcpConnections: true } }), { gatingEnabled: true })).toBe(true)
    expect(memberFacingMcpConnectionsEnabled({ capabilities: { mcpConnections: true } }, { gatingEnabled: true })).toBe(true)
    expect(
      memberFacingMcpConnectionsEnabled(
        JSON.stringify({ limits: { members: 100 }, plan: { tier: "team" }, capabilities: { mcpConnections: true } }),
        { gatingEnabled: true },
      ),
    ).toBe(true)
  })
})
