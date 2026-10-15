import assert from "node:assert/strict"
import { test } from "node:test"
import { FEATURES, resolveFeature } from "@openwork/features"

test("MCP domain recovery is default-off on both deployments and can be killed after rollout", () => {
  assert.equal(FEATURES.mcpOAuthDomainRecovery.default, false)
  for (const deployment of ["cloud", "self_hosted"] as const) {
    const context = { deployment, locks: {}, rollouts: {}, overrides: {} }
    assert.equal(resolveFeature("mcpOAuthDomainRecovery", context).enabled, false)
    assert.equal(resolveFeature("mcpOAuthDomainRecovery", { ...context, overrides: { mcpOAuthDomainRecovery: true } }).enabled, true)
    assert.equal(resolveFeature("mcpOAuthDomainRecovery", { ...context, locks: { mcpOAuthDomainRecovery: true }, overrides: { mcpOAuthDomainRecovery: true }, rollouts: { mcpOAuthDomainRecovery: { enabled: true, killed: true } } }).enabled, false)
  }
})
