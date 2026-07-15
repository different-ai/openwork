import { describe, expect, test } from "bun:test"
import { memberFacingMcpConnectionsEnabled } from "../src/capability-sources/external-mcp-rollout.js"

describe("memberFacingMcpConnectionsEnabled", () => {
  test("gating disabled: enabled for every org, regardless of metadata", () => {
    for (const metadata of [
      null,
      undefined,
      "",
      "{}",
      "not json",
      { capabilities: { mcpConnections: false } },
      { connectEnabled: false },
      { mcpConnectionsEnabled: false },
    ]) {
      expect(memberFacingMcpConnectionsEnabled(metadata, { gatingEnabled: false })).toBe(true)
    }
  })

  test("gating enabled: disabled unless the org has connect enabled", () => {
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
      JSON.stringify({ connectEnabled: false }),
      JSON.stringify({ connectEnabled: "yes" }),
      JSON.stringify({ mcpConnectionsEnabled: false }),
      JSON.stringify({ mcpConnectionsEnabled: "yes" }),
      { capabilities: { mcpConnections: false } },
      { capabilities: { mcpConnections: "true" } },
      { connectEnabled: false },
      { connectEnabled: "yes" },
      { mcpConnectionsEnabled: false },
      { mcpConnectionsEnabled: "yes" },
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

  test("gating enabled: orgs with connectEnabled are enabled", () => {
    expect(memberFacingMcpConnectionsEnabled(JSON.stringify({ connectEnabled: true }), { gatingEnabled: true })).toBe(true)
    expect(memberFacingMcpConnectionsEnabled({ connectEnabled: true }, { gatingEnabled: true })).toBe(true)
    expect(
      memberFacingMcpConnectionsEnabled(
        JSON.stringify({ limits: { members: 100 }, plan: { tier: "team" }, connectEnabled: true }),
        { gatingEnabled: true },
      ),
    ).toBe(true)
  })

  test("gating enabled: orgs with the legacy mcpConnectionsEnabled alias are enabled", () => {
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
