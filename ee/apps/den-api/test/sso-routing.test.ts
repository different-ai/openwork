import assert from "node:assert/strict"
import { test } from "node:test"
import {
  allowsVerifiedDomainAutoJoin,
  blocksNonSsoSignIn,
  organizationRequiresSsoSession,
  readOrganizationSsoPolicy,
  resolveLoginSsoRouting,
  ssoProofIsCurrent,
  type DomainSsoRequirement,
  type OrganizationSsoPolicy,
} from "../src/sso-routing.js"

const optional: OrganizationSsoPolicy = { requireSso: false, restrictDomainToSso: false, ssoSessionMaxAgeHours: null }
const required: OrganizationSsoPolicy = { requireSso: true, restrictDomainToSso: false, ssoSessionMaxAgeHours: null }
const restricted: OrganizationSsoPolicy = { requireSso: false, restrictDomainToSso: true, ssoSessionMaxAgeHours: null }

function requirement(policy: OrganizationSsoPolicy, perOrganization: boolean): DomainSsoRequirement {
  return {
    organizationId: "org_sso",
    organizationSlug: "sso-org",
    organizationName: "SSO org",
    signInPath: "/sso/sso-org",
    policy,
    perOrganization,
  }
}

test("policy reads requireSso and restrictDomainToSso from metadata strings and objects", () => {
  assert.deepEqual(readOrganizationSsoPolicy(null), optional)
  assert.deepEqual(readOrganizationSsoPolicy("not json"), optional)
  assert.deepEqual(readOrganizationSsoPolicy(JSON.stringify({ requireSso: true })), required)
  assert.deepEqual(readOrganizationSsoPolicy({ restrictDomainToSso: true }), restricted)
  assert.deepEqual(readOrganizationSsoPolicy({ requireSso: "true" }), optional, "only a real boolean counts")
  assert.equal(organizationRequiresSsoSession(optional), false)
  assert.equal(organizationRequiresSsoSession(required), true)
  assert.equal(organizationRequiresSsoSession(restricted), true)
})

test("flag off: an SSO domain is SSO only, whatever the policy or invitation (today's behavior)", () => {
  for (const policy of [optional, required, restricted]) {
    assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: requirement(policy, false), invitationOrganizationId: "org_other" }), { kind: "sso_only" })
  }
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: null, invitationOrganizationId: null }), { kind: "none" })
})

test("single-organization SSO is unchanged: always SSO only", () => {
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: true, requirement: null, invitationOrganizationId: "org_other" }), { kind: "sso_only" })
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: true, requirement: requirement(optional, true), invitationOrganizationId: null }), { kind: "sso_only" })
})

test("flag on: SSO is preferred with the usual step, and says whether the organization requires it", () => {
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: requirement(optional, true), invitationOrganizationId: null }), { kind: "sso_preferred", ssoRequired: false })
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: requirement(required, true), invitationOrganizationId: null }), { kind: "sso_preferred", ssoRequired: true })
})

test("flag on: an invitation to another organization bypasses the domain's SSO; one to the SSO organization does not", () => {
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: requirement(required, true), invitationOrganizationId: "org_other" }), { kind: "none" })
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: requirement(optional, true), invitationOrganizationId: "org_sso" }), { kind: "sso_preferred", ssoRequired: false })
})

test("flag on: a restricted domain is SSO only, invitation or not", () => {
  assert.deepEqual(resolveLoginSsoRouting({ singletonSso: false, requirement: requirement(restricted, true), invitationOrganizationId: "org_other" }), { kind: "sso_only" })
})

test("non-SSO sign-in: flag off refuses members; flag on refuses only a restricted domain", () => {
  const base = { organizationId: "org_sso", emailOnVerifiedDomain: true }
  assert.equal(blocksNonSsoSignIn({ ...base, policy: optional, perOrganization: false, member: true }), true)
  assert.equal(blocksNonSsoSignIn({ ...base, policy: optional, perOrganization: false, member: false }), false, "today a non-member on the domain is only redirected by login options")
  assert.equal(blocksNonSsoSignIn({ ...base, policy: required, perOrganization: true, member: true }), false, "Require SSO is enforced when the organization is opened")
  assert.equal(blocksNonSsoSignIn({ ...base, policy: restricted, perOrganization: true, member: false }), true)
  assert.equal(blocksNonSsoSignIn({ ...base, emailOnVerifiedDomain: false, policy: restricted, perOrganization: true, member: true }), false, "a restricted domain covers its own emails only")
})

test("verified-domain auto-join stays off for organizations that require SSO when the flag is on", () => {
  assert.equal(allowsVerifiedDomainAutoJoin({ policy: required, perOrganization: false }), true)
  assert.equal(allowsVerifiedDomainAutoJoin({ policy: optional, perOrganization: true }), true)
  assert.equal(allowsVerifiedDomainAutoJoin({ policy: required, perOrganization: true }), false)
  assert.equal(allowsVerifiedDomainAutoJoin({ policy: restricted, perOrganization: true }), false)
})

test("policy reads only the offered \"Ask for SSO again\" choices", () => {
  assert.equal(readOrganizationSsoPolicy({ requireSso: true, ssoSessionMaxAgeHours: 24 }).ssoSessionMaxAgeHours, 24)
  assert.equal(readOrganizationSsoPolicy({ ssoSessionMaxAgeHours: 5 }).ssoSessionMaxAgeHours, null, "an unknown value is no limit")
  assert.equal(readOrganizationSsoPolicy({ ssoSessionMaxAgeHours: "24" }).ssoSessionMaxAgeHours, null)
})

test("an SSO sign-in opens the organization until its \"Ask for SSO again\" time has passed", () => {
  const authenticatedAt = new Date("2026-11-04T09:00:00Z")
  assert.equal(ssoProofIsCurrent({ authenticatedAt, maxAgeHours: null, now: new Date("2027-11-04T09:00:00Z") }), true, "no limit: as long as the session lasts")
  assert.equal(ssoProofIsCurrent({ authenticatedAt, maxAgeHours: 8, now: new Date("2026-11-04T16:59:59Z") }), true)
  assert.equal(ssoProofIsCurrent({ authenticatedAt, maxAgeHours: 8, now: new Date("2026-11-04T17:00:00Z") }), false)
  assert.equal(ssoProofIsCurrent({ authenticatedAt, maxAgeHours: 24, now: new Date("2026-11-05T08:00:00Z") }), true)
})
