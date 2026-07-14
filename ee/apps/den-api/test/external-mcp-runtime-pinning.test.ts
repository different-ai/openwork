import { createHmac } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  createOAuthStateToken,
  externalMcpOAuthRuntimeFromStateToken,
  verifyOAuthStateToken,
} from "../src/capability-sources/generic-oauth.js"
import { externalMcpClientRuntimeIdForOAuthState } from "../src/capability-sources/external-mcp-client-runtime.js"

const secret = "runtime-pinning-test-secret-at-least-32-bytes"
const organizationId = "org_01runtimepinning000000000000" as Parameters<typeof createOAuthStateToken>[0]["organizationId"]
const memberId = "member_01runtimepinning000000000" as Parameters<typeof createOAuthStateToken>[0]["orgMembershipId"]

function base64Url(input: Buffer | string) {
  return (typeof input === "string" ? Buffer.from(input, "utf8") : input).toString("base64url")
}

function signedRawState(payload: Record<string, unknown>) {
  const encodedPayload = base64Url(JSON.stringify(payload))
  const signature = base64Url(createHmac("sha256", secret).update(encodedPayload).digest())
  return `${encodedPayload}.${signature}`
}

describe("external MCP OAuth runtime pinning", () => {
  test("new external MCP states round-trip the selected runtime", () => {
    for (const runtime of ["current", "enterprise"] as const) {
      const state = createOAuthStateToken({
        organizationId,
        orgMembershipId: memberId,
        providerId: "emc_runtime_pin",
        binding: "identity-binding",
        externalMcpRuntime: runtime,
        secret,
      })
      expect(verifyOAuthStateToken({ token: state, secret })?.externalMcpRuntime).toBe(runtime)
      expect(externalMcpOAuthRuntimeFromStateToken(state)).toBe(runtime)
    }
  })

  test("callback selection honors a pin and preserves selected-runtime behavior for legacy states", () => {
    expect(externalMcpClientRuntimeIdForOAuthState("enterprise", "current")).toBe("enterprise")
    expect(externalMcpClientRuntimeIdForOAuthState("current", "enterprise")).toBe("current")
    expect(externalMcpClientRuntimeIdForOAuthState(undefined, "enterprise")).toBe("enterprise")
    expect(externalMcpClientRuntimeIdForOAuthState(undefined, "current")).toBe("current")
  })

  test("signed states with an unknown runtime fail validation", () => {
    const state = signedRawState({
      organizationId,
      orgMembershipId: memberId,
      providerId: "emc_runtime_pin",
      externalMcpRuntime: "future-runtime",
      nonce: "unknown-runtime",
      exp: Math.floor(Date.now() / 1000) + 600,
    })
    expect(verifyOAuthStateToken({ token: state, secret })).toBeNull()
    expect(externalMcpOAuthRuntimeFromStateToken(state)).toBeUndefined()
  })

  test("native OAuth-compatible states remain unpinned", () => {
    const state = createOAuthStateToken({
      organizationId,
      orgMembershipId: memberId,
      providerId: "google-workspace",
      secret,
    })
    expect(verifyOAuthStateToken({ token: state, secret })).toEqual(expect.objectContaining({
      providerId: "google-workspace",
    }))
    expect(verifyOAuthStateToken({ token: state, secret })?.externalMcpRuntime).toBeUndefined()
    expect(externalMcpOAuthRuntimeFromStateToken(state)).toBeUndefined()
  })

  test("the route pins start and dispatches callback completion and cleanup through that runtime", () => {
    const source = readFileSync(new URL("../src/routes/org/mcp-connections.ts", import.meta.url), "utf8")
    expect(source).toContain("externalMcpRuntime: oauthRuntimeId")
    expect(source).toContain("externalMcpClientRuntimeIdForOAuthState")
    expect(source).toContain("oauthRuntime.completeExternalMcpAuth(")
    expect(source.match(/oauthRuntime\.abandonExternalMcpAuth\(/g)).toHaveLength(2)
  })
})
