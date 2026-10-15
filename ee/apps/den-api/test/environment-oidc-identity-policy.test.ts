import assert from "node:assert/strict"
import { test } from "node:test"
import { resolveEnvironmentOidcIdentityAuthorization, type EnvironmentOidcIdentityPolicy } from "../src/environment-oidc-identity-policy.js"

const identity = { sub: "fixture-subject", email: "member@example.test" }
function policy(overrides: Partial<EnvironmentOidcIdentityPolicy> = {}): EnvironmentOidcIdentityPolicy {
  return {
    available: async () => true,
    enterpriseRequired: async () => false,
    localUser: async () => null,
    linkedUser: async () => null,
    installationAllows: async () => true,
    ...overrides,
  }
}

test("off or killed provider refuses identity before reading/linking local accounts", async () => {
  let read = false
  assert.equal(await resolveEnvironmentOidcIdentityAuthorization(identity, policy({
    available: async () => false,
    localUser: async () => { read = true; return null },
  })), false)
  assert.equal(read, false)
})

test("organization SSO takes precedence even for an already verified local account", async () => {
  assert.equal(await resolveEnvironmentOidcIdentityAuthorization(identity, policy({
    enterpriseRequired: async () => true,
    localUser: async () => ({ id: "local-user", emailVerified: true }),
  })), false)
})

test("verified remote email cannot claim an unverified local account", async () => {
  assert.equal(await resolveEnvironmentOidcIdentityAuthorization(identity, policy({
    localUser: async () => ({ id: "local-user", emailVerified: false }),
  })), false)
})

test("verified matching local account may link without a trusted-provider override", async () => {
  let checkedUser: string | null = null
  assert.equal(await resolveEnvironmentOidcIdentityAuthorization(identity, policy({
    localUser: async () => ({ id: "local-user", emailVerified: true }),
    installationAllows: async ({ userId }) => { checkedUser = userId; return true },
  })), true)
  assert.equal(checkedUser, "local-user")
})

test("a stable subject cannot move into another email or collide with another user", async () => {
  assert.equal(await resolveEnvironmentOidcIdentityAuthorization(identity, policy({
    linkedUser: async () => ({ userId: "linked-user", email: "previous@example.test" }),
  })), false)
  assert.equal(await resolveEnvironmentOidcIdentityAuthorization(identity, policy({
    linkedUser: async () => ({ userId: "linked-user", email: identity.email }),
    localUser: async () => ({ id: "other-user", emailVerified: true }),
  })), false)
})

test("new and existing subjects must pass installation domains, singleton SSO and SCIM policy", async () => {
  const calls: { email: string; userId: string | null }[] = []
  const refuse = async (input: { email: string; userId: string | null }) => { calls.push(input); return false }
  assert.equal(await resolveEnvironmentOidcIdentityAuthorization(identity, policy({ installationAllows: refuse })), false)
  assert.equal(await resolveEnvironmentOidcIdentityAuthorization(identity, policy({
    linkedUser: async () => ({ userId: "linked-user", email: identity.email }), installationAllows: refuse,
  })), false)
  assert.deepEqual(calls, [{ email: identity.email, userId: null }, { email: identity.email, userId: "linked-user" }])
})
