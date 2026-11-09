import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { DEFAULT_AGENT_SOURCES_POLICY, mergeAgentSourcesPolicy } from "@openwork/types/den/workbot-proactive"
import { agentReadAllowlist } from "../src/mcp/agent-read-sources.js"
import { connectionsWithheld, headlessRunTokenScopes, workbotTurnLimitScopes } from "../src/mcp/workbot-turn-limits.js"

describe("what an admin's Workbot settings take away from a Workbot conversation", () => {
  const policy = mergeAgentSourcesPolicy(DEFAULT_AGENT_SOURCES_POLICY, {
    connections: { emc_excalidraw: "off", emc_linear: "everyone", emc_notion: "members" },
  })

  test("only a connection set to Not allowed is taken away", () => {
    const withheld = connectionsWithheld(new Set(workbotTurnLimitScopes(policy)))
    assert.deepEqual([...(withheld ?? [])], ["emc_excalidraw"])
  })

  test("a turn that can make changes keeps the limit and nothing else it was handed", () => {
    const scopes = headlessRunTokenScopes({ readOnly: false, scopes: [...workbotTurnLimitScopes(policy), "openwork:agent-read"] })
    assert.deepEqual(scopes.slice(0, 2), ["mcp:read", "mcp:write"])
    assert.equal(scopes.includes("openwork:agent-read"), false)
    assert.deepEqual([...(connectionsWithheld(new Set(scopes)) ?? [])], ["emc_excalidraw"])
  })

  test("a read-only turn keeps the limit without becoming a background agent", () => {
    const scopes = new Set(headlessRunTokenScopes({ readOnly: true, scopes: workbotTurnLimitScopes(policy) }))
    assert.equal(scopes.has("mcp:write"), false)
    assert.equal(agentReadAllowlist(scopes), null)
    assert.deepEqual([...(connectionsWithheld(scopes) ?? [])], ["emc_excalidraw"])
  })

  test("every other token has nothing taken away", () => {
    assert.equal(connectionsWithheld(new Set(["mcp:read", "mcp:write"])), undefined)
    assert.deepEqual(workbotTurnLimitScopes(DEFAULT_AGENT_SOURCES_POLICY), [])
    assert.deepEqual(headlessRunTokenScopes({}), ["mcp:read", "mcp:write"])
  })
})
