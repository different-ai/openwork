import assert from "node:assert/strict";
import test from "node:test";
import { parseMemberSsoSignIns, parseResolvedDomainSso, resolveReauthSsoTarget } from "./reauth-sso";

const organization = { slug: "org_abc", hasSso: true, perOrganization: true, requireSso: false, restrictDomainToSso: false };
const offered = { organizationId: "org_abc", signInUrl: "https://app.example.com/sso/org_abc", ssoOnly: false };
const required = { organizationId: "org_req", signInUrl: "https://app.example.com/sso/org_req", ssoOnly: true };
const domainOffered = { signInUrl: "https://app.example.com/sso/acme", domainForced: false, organizationRequired: false };
const none = { resolvedDomainSso: null, organizationId: null, memberSsoSignIns: null, organization: null };

test("SSO forced for the whole domain is the only option, whatever else is known", () => {
  assert.deepEqual(
    resolveReauthSsoTarget({ ...none, resolvedDomainSso: { ...domainOffered, domainForced: true }, organizationId: "org_abc", memberSsoSignIns: [offered] }),
    { signInUrl: domainOffered.signInUrl, ssoOnly: true },
  );
});

test("signed in, SSO offered but not required: the organization's SSO is enabled next to the other methods", () => {
  assert.deepEqual(
    resolveReauthSsoTarget({ ...none, organizationId: "org_abc", memberSsoSignIns: [offered, required] }),
    { signInUrl: offered.signInUrl, ssoOnly: false },
  );
  assert.equal(resolveReauthSsoTarget({ ...none, organizationId: "org_req", memberSsoSignIns: [offered, required] })?.ssoOnly, true);
});

test("signed in, a known organization without SSO never borrows another organization's SSO", () => {
  assert.equal(resolveReauthSsoTarget({ ...none, resolvedDomainSso: domainOffered, organizationId: "org_other", memberSsoSignIns: [offered], organization }), null);
});

test("signed in without a known organization, only a single SSO organization is used", () => {
  assert.equal(resolveReauthSsoTarget({ ...none, memberSsoSignIns: [offered] })?.signInUrl, offered.signInUrl);
  assert.equal(resolveReauthSsoTarget({ ...none, memberSsoSignIns: [offered, required] }), null);
});

test("an older Den API without /v1/me/sso-sign-in falls back to the organization context", () => {
  assert.deepEqual(resolveReauthSsoTarget({ ...none, organizationId: "org_abc", organization }), { signInUrl: "/sso/org_abc", ssoOnly: false });
  assert.equal(resolveReauthSsoTarget({ ...none, organization: { ...organization, requireSso: true } })?.ssoOnly, true);
  assert.equal(resolveReauthSsoTarget({ ...none, organization: { ...organization, perOrganization: false } })?.ssoOnly, true);
  assert.equal(resolveReauthSsoTarget({ ...none, resolvedDomainSso: domainOffered, organization: { ...organization, hasSso: false } }), null);
  assert.equal(resolveReauthSsoTarget({ ...none, organization: { ...organization, slug: "a b/c" } })?.signInUrl, "/sso/a%20b%2Fc");
});

test("not signed in (email typed): the domain's SSO is one option, or the only one when its organization requires SSO", () => {
  assert.deepEqual(resolveReauthSsoTarget({ ...none, resolvedDomainSso: domainOffered, organizationId: "org_abc" }), { signInUrl: domainOffered.signInUrl, ssoOnly: false });
  assert.equal(resolveReauthSsoTarget({ ...none, resolvedDomainSso: { ...domainOffered, organizationRequired: true } })?.ssoOnly, true);
  assert.equal(resolveReauthSsoTarget(none), null);
});

test("parses /v1/orgs/sso/resolve, old and new", () => {
  assert.deepEqual(parseResolvedDomainSso({ requireSso: false, method: "google", ssoRequired: false, signInUrl: "https://a/sso/x" }), { signInUrl: "https://a/sso/x", domainForced: false, organizationRequired: false });
  assert.deepEqual(parseResolvedDomainSso({ requireSso: false, method: "google", ssoRequired: true, signInUrl: "https://a/sso/x" }), { signInUrl: "https://a/sso/x", domainForced: false, organizationRequired: true });
  // Older API: a link only ever came with requireSso true.
  assert.deepEqual(parseResolvedDomainSso({ requireSso: true, method: "sso", signInUrl: "https://a/sso/x" }), { signInUrl: "https://a/sso/x", domainForced: true, organizationRequired: true });
  assert.equal(parseResolvedDomainSso({ requireSso: false, method: "google" }), null);
  assert.equal(parseResolvedDomainSso(null), null);
});

test("parses /v1/me/sso-sign-in and drops malformed entries", () => {
  assert.deepEqual(
    parseMemberSsoSignIns({ organizations: [{ ...offered, organizationSlug: "x" }, { organizationId: "", signInUrl: "x" }, "nope", { organizationId: "org_y", signInUrl: "/sso/y" }] }),
    [offered, { organizationId: "org_y", signInUrl: "/sso/y", ssoOnly: false }],
  );
  assert.equal(parseMemberSsoSignIns({ error: "not_found" }), null);
  assert.equal(parseMemberSsoSignIns(null), null);
});
