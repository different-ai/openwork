import { describe, expect, test } from "bun:test"
import { memberFacingMcpConnectionsEnabled } from "../src/capability-sources/external-mcp-rollout.js"

type MetadataInput = Parameters<typeof memberFacingMcpConnectionsEnabled>[0]

function expectWithDeprecatedGate(metadata: MetadataInput, expected: boolean) {
  for (const gatingEnabled of [false, true]) {
    expect(memberFacingMcpConnectionsEnabled(metadata, { gatingEnabled })).toBe(expected)
  }
}

describe("memberFacingMcpConnectionsEnabled", () => {
  test("C1: absent, empty, and unparseable metadata are enabled by default", () => {
    for (const metadata of [null, undefined, "", "{}", "not json", "[]", {}, JSON.stringify({ limits: { members: 5 } })]) {
      expectWithDeprecatedGate(metadata, true)
    }
  })

  test("C2/C3: capability true enables and capability false disables", () => {
    for (const metadata of [
      { capabilities: { mcpConnections: true } },
      JSON.stringify({ capabilities: { mcpConnections: true } }),
      JSON.stringify({ limits: { members: 100 }, plan: { tier: "team" }, capabilities: { mcpConnections: true } }),
    ]) {
      expectWithDeprecatedGate(metadata, true)
    }

    for (const metadata of [
      { capabilities: { mcpConnections: false } },
      JSON.stringify({ capabilities: { mcpConnections: false } }),
    ]) {
      expectWithDeprecatedGate(metadata, false)
    }
  })

  test("C4: alias false disables when capability is absent", () => {
    for (const metadata of [
      { connectEnabled: false },
      { mcpConnectionsEnabled: false },
      { connectEnabled: false, mcpConnectionsEnabled: false },
      JSON.stringify({ connectEnabled: false }),
      JSON.stringify({ mcpConnectionsEnabled: false }),
    ]) {
      expectWithDeprecatedGate(metadata, false)
    }
  })

  test("C5: alias true enables", () => {
    for (const metadata of [
      { connectEnabled: true },
      { mcpConnectionsEnabled: true },
      JSON.stringify({ connectEnabled: true }),
      JSON.stringify({ mcpConnectionsEnabled: true }),
    ]) {
      expectWithDeprecatedGate(metadata, true)
    }
  })

  test("C6: capability outranks aliases, and any alias true outranks alias false", () => {
    expectWithDeprecatedGate({ capabilities: { mcpConnections: true }, connectEnabled: false }, true)
    expectWithDeprecatedGate({ capabilities: { mcpConnections: false }, connectEnabled: true }, false)
    expectWithDeprecatedGate({ connectEnabled: true, mcpConnectionsEnabled: false }, true)
  })

  test("C7: non-boolean values are ignored and fall through to default on", () => {
    for (const metadata of [
      { capabilities: { mcpConnections: "true" } },
      { connectEnabled: "yes" },
      { mcpConnectionsEnabled: "true" },
      JSON.stringify({ capabilities: { mcpConnections: "true" }, connectEnabled: "yes", mcpConnectionsEnabled: "false" }),
      JSON.stringify({ capabilities: { mcpConnections: 1 }, connectEnabled: 0, mcpConnectionsEnabled: null }),
    ]) {
      expectWithDeprecatedGate(metadata, true)
    }
  })
})
