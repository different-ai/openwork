import assert from "node:assert/strict"
import { test } from "node:test"
import { FEATURES, resolveFeature } from "@openwork/features"

test("MCP domain recovery is default-off on both deployments and can be killed after rollout", () => {
  assert.equal(FEATURES.mcpOauthDomainRecovery.default, false)
  for (const deployment of ["cloud", "self_hosted"] as const) {
    const context = { deployment, locks: {}, rollouts: {}, overrides: {} }
    assert.equal(resolveFeature("mcpOauthDomainRecovery", context).enabled, false)
    assert.equal(resolveFeature("mcpOauthDomainRecovery", { ...context, overrides: { mcpOauthDomainRecovery: true } }).enabled, true)
    assert.equal(resolveFeature("mcpOauthDomainRecovery", { ...context, locks: { mcpOauthDomainRecovery: true }, overrides: { mcpOauthDomainRecovery: true }, rollouts: { mcpOauthDomainRecovery: { enabled: true, killed: true } } }).enabled, false)
  }
})
