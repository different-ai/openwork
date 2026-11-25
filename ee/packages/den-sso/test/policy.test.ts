import assert from "node:assert/strict"
import test from "node:test"
import { allowsVerifiedDomainAutoJoin, blocksNonSsoSignIn, organizationRequiresSsoSession, readOrganizationSsoPolicy, resolveLoginSsoRouting, type DomainSsoRequirement, type OrganizationSsoPolicy } from "../src/policy.js"

const none: OrganizationSsoPolicy = { requireSso: false, restrictDomainToSso: false }
const required: OrganizationSsoPolicy = { requireSso: true, restrictDomainToSso: false }
const restricted: OrganizationSsoPolicy = { requireSso: false, restrictDomainToSso: true }

function requirement(policy: OrganizationSsoPolicy, perOrganization = true): DomainSsoRequirement {
  return { organizationId: "org_sso", organizationSlug: "acme", organizationName: "Acme", signInPath: "/sso/acme", policy, perOrganization }
}

test("only a literal true in the organization's metadata turns a setting on", () => {
  assert.deepEqual(readOrganizationSsoPolicy('{"requireSso":true,"restrictDomainToSso":true}'), { requireSso: true, restrictDomainToSso: true })
  assert.deepEqual(readOrganizationSsoPolicy({ requireSso: true }), required)
  for (const metadata of [null, undefined, "", "not json", "[]", '{"requireSso":"true","restrictDomainToSso":1}', 42]) {
    assert.deepEqual(readOrganizationSsoPolicy(metadata), none, String(metadata))
  }
})

test("login routing: SSO only, SSO first, or the usual sign-in", () => {
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: true, requirement: null, invitationOrganizationId: null }), { kind: "sso_only" })
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: null, invitationOrganizationId: null }), { kind: "none" })
  // Single-organization routing and a restricted domain keep the strict behavior.
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: requirement(none, false), invitationOrganizationId: null }), { kind: "sso_only" })
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: requirement(restricted), invitationOrganizationId: "org_other" }), { kind: "sso_only" })
  // Otherwise SSO is offered first, and an invitation elsewhere is the person's way in there.
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: requirement(required), invitationOrganizationId: null }), { kind: "sso_preferred", ssoRequired: true })
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: requirement(none), invitationOrganizationId: "org_sso" }), { kind: "sso_preferred", ssoRequired: false })
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: requirement(required), invitationOrganizationId: "org_other" }), { kind: "none" })
})

test("a non-SSO sign-in is refused for members of a single-organization SSO, or on a restricted domain", () => {
  const candidate = { organizationId: "org_sso", emailOnVerifiedDomain: true, member: true }
  assert.equal(blocksNonSsoSignIn({ ...candidate, policy: none, perOrganization: false }), true)
  assert.equal(blocksNonSsoSignIn({ ...candidate, member: false, policy: none, perOrganization: false }), false)
  assert.equal(blocksNonSsoSignIn({ ...candidate, policy: required, perOrganization: true }), false)
  assert.equal(blocksNonSsoSignIn({ ...candidate, member: false, policy: restricted, perOrganization: true }), true)
  assert.equal(blocksNonSsoSignIn({ ...candidate, emailOnVerifiedDomain: false, policy: restricted, perOrganization: true }), false)
})

test("an organization that requires SSO never gains members by verified-domain auto-join", () => {
  assert.equal(organizationRequiresSsoSession(none), false)
  assert.equal(organizationRequiresSsoSession(required), true)
  assert.equal(organizationRequiresSsoSession(restricted), true)
  assert.equal(allowsVerifiedDomainAutoJoin({ policy: required, perOrganization: false }), true)
  assert.equal(allowsVerifiedDomainAutoJoin({ policy: none, perOrganization: true }), true)
  assert.equal(allowsVerifiedDomainAutoJoin({ policy: required, perOrganization: true }), false)
  assert.equal(allowsVerifiedDomainAutoJoin({ policy: restricted, perOrganization: true }), false)
})
