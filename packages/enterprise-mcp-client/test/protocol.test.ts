import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  createMcpCapabilityHash,
  MCP_CURRENT_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSION,
  McpProtocolNegotiationError,
  negotiateMcpProtocol,
  normalizeMcpResult,
} from "../src/index.js"

function currentDiscovery() {
  return {
    resultType: "complete",
    supportedVersions: [MCP_LEGACY_PROTOCOL_VERSION, MCP_CURRENT_PROTOCOL_VERSION],
    serverInfo: { name: "openwork-den", version: "1.0.0" },
    capabilities: { tools: { listChanged: true }, subscriptions: {} },
    ttlMs: 60_000,
    cacheScope: "private",
  }
}

describe("MCP protocol negotiation", () => {
  it("prefers current protocol and produces a deterministic capability binding", () => {
    const first = negotiateMcpProtocol({
      policy: "auto",
      outcome: { kind: "discovered", value: currentDiscovery() },
      authorizationServerIssuer: "https://identity.example.test",
      establishedAt: "2026-07-14T00:00:00.000Z",
    })
    const secondHash = createMcpCapabilityHash({
      extensions: {},
      capabilities: { subscriptions: {}, tools: { listChanged: true } },
    })

    assert.equal(first.binding.negotiatedVersion, MCP_CURRENT_PROTOCOL_VERSION)
    assert.equal(first.binding.capabilityHash, secondHash)
    assert.equal(first.status.currentCompatible, true)
    assert.deepEqual(first.status.warnings, [])
  })

  it("allows legacy fallback only when the caller classified an explicit legacy outcome", () => {
    const result = negotiateMcpProtocol({
      policy: "auto",
      outcome: { kind: "legacy-only", reason: "method-not-found" },
      establishedAt: "2026-07-14T00:00:00.000Z",
    })

    assert.equal(result.binding.negotiatedVersion, MCP_LEGACY_PROTOCOL_VERSION)
    assert.equal(result.status.warnings[0]?.code, "MCP_LEGACY_COMPATIBILITY_MODE")
  })

  it("does not turn malformed current discovery into a legacy downgrade", () => {
    assert.throws(
      () => negotiateMcpProtocol({
        policy: "auto",
        outcome: { kind: "discovered", value: { error: "unauthorized" } },
      }),
      (error: unknown) => error instanceof McpProtocolNegotiationError
        && error.code === "MCP_PROTOCOL_DISCOVERY_INVALID",
    )
  })

  it("blocks silent downgrade after a current binding", () => {
    const current = negotiateMcpProtocol({
      policy: "auto",
      outcome: { kind: "discovered", value: currentDiscovery() },
      establishedAt: "2026-07-14T00:00:00.000Z",
    }).binding

    assert.throws(
      () => negotiateMcpProtocol({
        policy: "auto",
        outcome: { kind: "legacy-only", reason: "unsupported-version" },
        previousBinding: current,
      }),
      (error: unknown) => error instanceof McpProtocolNegotiationError
        && error.code === "MCP_PROTOCOL_DOWNGRADE_BLOCKED",
    )
  })

  it("allows an administrator to force temporary legacy mode explicitly", () => {
    const current = negotiateMcpProtocol({
      policy: "auto",
      outcome: { kind: "discovered", value: currentDiscovery() },
      establishedAt: "2026-07-14T00:00:00.000Z",
    }).binding
    const forced = negotiateMcpProtocol({
      policy: MCP_LEGACY_PROTOCOL_VERSION,
      outcome: { kind: "legacy-only", reason: "legacy-lifecycle" },
      previousBinding: current,
      establishedAt: "2026-07-14T01:00:00.000Z",
    })

    assert.equal(forced.binding.negotiatedVersion, MCP_LEGACY_PROTOCOL_VERSION)
    assert.equal(forced.status.downgradeBlocked, true)
    assert.equal(forced.status.warnings[0]?.code, "MCP_FORCED_LEGACY_MODE")
  })

  it("fails closed when current protocol is forced against a legacy server", () => {
    assert.throws(
      () => negotiateMcpProtocol({
        policy: MCP_CURRENT_PROTOCOL_VERSION,
        outcome: { kind: "legacy-only", reason: "legacy-lifecycle" },
      }),
      (error: unknown) => error instanceof McpProtocolNegotiationError
        && error.code === "MCP_PROTOCOL_VERSION_UNSUPPORTED",
    )
  })
})

describe("MCP normalized results", () => {
  it("normalizes legacy results to complete", () => {
    assert.deepEqual(normalizeMcpResult({
      protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
      value: { content: [] },
      parseComplete: (value) => value,
    }), {
      resultType: "complete",
      value: { content: [] },
    })
  })

  it("normalizes complete and input-required current results", () => {
    assert.deepEqual(normalizeMcpResult({
      protocolVersion: MCP_CURRENT_PROTOCOL_VERSION,
      value: { resultType: "complete", content: [{ type: "text", text: "done" }] },
      parseComplete: (value) => value,
    }), {
      resultType: "complete",
      value: { content: [{ type: "text", text: "done" }] },
    })
    assert.deepEqual(normalizeMcpResult({
      protocolVersion: MCP_CURRENT_PROTOCOL_VERSION,
      value: {
        resultType: "input_required",
        requestState: "opaque-state",
        inputRequests: {
          confirm: { type: "elicitation", message: "Continue?", schema: { type: "boolean" } },
        },
      },
      parseComplete: (value) => value,
    }), {
      resultType: "input_required",
      requestState: "opaque-state",
      inputRequests: {
        confirm: { type: "elicitation", message: "Continue?", schema: { type: "boolean" } },
      },
    })
  })

  it("rejects a malformed current result instead of downgrading it", () => {
    assert.throws(
      () => normalizeMcpResult({
        protocolVersion: MCP_CURRENT_PROTOCOL_VERSION,
        value: { content: [] },
        parseComplete: (value) => value,
      }),
      McpProtocolNegotiationError,
    )
  })
})
