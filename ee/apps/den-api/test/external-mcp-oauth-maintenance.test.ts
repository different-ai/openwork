import { describe, expect, test } from "bun:test"
import { runExternalMcpOAuthTransactionMaintenanceOnce } from "../src/capability-sources/external-mcp-oauth-maintenance.js"

describe("external MCP OAuth transaction maintenance", () => {
  test("runs one bounded cleanup batch with a stable cutoff", async () => {
    const now = new Date("2026-07-14T12:00:00.000Z")
    const calls: Array<{ now?: Date; limit?: number }> = []

    const result = await runExternalMcpOAuthTransactionMaintenanceOnce({
      now,
      batchSize: 25,
      cleanup: async (input = {}) => {
        calls.push(input)
        return { deleted: 3, limitReached: false }
      },
    })

    expect(calls).toEqual([{ now, limit: 25 }])
    expect(result).toEqual({ deleted: 3, limitReached: false })
  })

  test("propagates cleanup failures so the loop can report and retry them", async () => {
    const failure = new Error("database unavailable")
    await expect(runExternalMcpOAuthTransactionMaintenanceOnce({
      cleanup: async () => { throw failure },
    })).rejects.toBe(failure)
  })
})
