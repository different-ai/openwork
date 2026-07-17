import { describe, expect, test } from "bun:test"

import {
  hasFreshMcpAuthorization,
  isChatMcpReconnectScopeCurrent,
  waitForFreshMcpAuthorization,
} from "../src/react-app/domains/session/surface/mcp-chat-reconnect"

const baseConnection = {
  id: "emc_research",
  name: "Research Vault",
  url: "https://mcp.test/endpoint",
  authType: "oauth" as const,
  credentialMode: "per_member" as const,
  connected: true,
  connectedAt: "2026-07-16T20:00:00.000Z",
  connectedForMe: true,
}

describe("chat MCP reconnect completion", () => {
  test("requires a new member authorization timestamp, not merely an existing token", () => {
    expect(hasFreshMcpAuthorization(baseConnection, baseConnection.connectedAt)).toBe(false)
    expect(hasFreshMcpAuthorization({
      ...baseConnection,
      connectedAt: "2026-07-16T20:01:00.000Z",
    }, baseConnection.connectedAt)).toBe(true)
  })

  test("polls through the unchanged credential until the OAuth callback advances it", async () => {
    let now = 0
    let lists = 0
    const result = await waitForFreshMcpAuthorization({
      connectionId: baseConnection.id,
      connectionName: baseConnection.name,
      previousConnectedAt: baseConnection.connectedAt,
      listConnections: async () => {
        lists += 1
        return [{
          ...baseConnection,
          connectedAt: lists < 2 ? baseConnection.connectedAt : "2026-07-16T20:01:00.000Z",
        }]
      },
      isScopeCurrent: () => true,
      timeoutMs: 10,
      intervalMs: 1,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
    })

    expect(result.connectedAt).toBe("2026-07-16T20:01:00.000Z")
    expect(lists).toBe(2)
  })

  test("stops if the active Den account or organization changes", async () => {
    const original = { baseUrl: "https://den.test", token: "member-a", organizationId: "org-a" }
    expect(isChatMcpReconnectScopeCurrent(original, { ...original })).toBe(true)
    expect(isChatMcpReconnectScopeCurrent(original, { ...original, organizationId: "org-b" })).toBe(false)

    await expect(waitForFreshMcpAuthorization({
      connectionId: baseConnection.id,
      connectionName: baseConnection.name,
      previousConnectedAt: baseConnection.connectedAt,
      listConnections: async () => [baseConnection],
      isScopeCurrent: () => false,
      timeoutMs: 10,
      intervalMs: 1,
    })).rejects.toThrow("active OpenWork Cloud account changed")
  })

  test("times out without claiming a stale connected account was repaired", async () => {
    let now = 0
    await expect(waitForFreshMcpAuthorization({
      connectionId: baseConnection.id,
      connectionName: baseConnection.name,
      previousConnectedAt: baseConnection.connectedAt,
      listConnections: async () => [baseConnection],
      isScopeCurrent: () => true,
      timeoutMs: 3,
      intervalMs: 1,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
    })).rejects.toThrow("did not finish")
  })
})
