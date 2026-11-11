import assert from "node:assert/strict";
import test from "node:test";
import { parseMemberSsoSignIns, resolveReauthSsoTarget } from "./reauth-sso";

const organization = { slug: "org_abc", hasSso: true, perOrganization: true, requireSso: false, restrictDomainToSso: false };
const offered = { organizationId: "org_abc", signInUrl: "https://app.example.com/sso/org_abc", ssoOnly: false };
const required = { organizationId: "org_req", signInUrl: "https://app.example.com/sso/org_req", ssoOnly: true };

test("a domain that must use SSO keeps the preflight's link", () => {
  assert.deepEqual(
    resolveReauthSsoTarget({ resolvedSignInUrl: "https://app.example.com/sso/acme", organizationId: null, memberSsoSignIns: null, organization: null }),
    { signInUrl: "https://app.example.com/sso/acme", ssoOnly: true },
  );
});

test("SSO offered but not required: the organization's SSO is enabled next to the other methods", () => {
  assert.deepEqual(
    resolveReauthSsoTarget({ resolvedSignInUrl: null, organizationId: "org_abc", memberSsoSignIns: [offered, required], organization: null }),
    { signInUrl: offered.signInUrl, ssoOnly: false },
  );
  assert.equal(
    resolveReauthSsoTarget({ resolvedSignInUrl: null, organizationId: "org_req", memberSsoSignIns: [offered, required], organization: null })?.ssoOnly,
    true,
  );
});

test("a known organization without SSO never borrows another organization's SSO", () => {
  assert.equal(resolveReauthSsoTarget({ resolvedSignInUrl: null, organizationId: "org_other", memberSsoSignIns: [offered], organization }), null);
});

test("without a known organization, only a single SSO organization is used", () => {
  assert.equal(resolveReauthSsoTarget({ resolvedSignInUrl: null, organizationId: null, memberSsoSignIns: [offered], organization: null })?.signInUrl, offered.signInUrl);
  assert.equal(resolveReauthSsoTarget({ resolvedSignInUrl: null, organizationId: null, memberSsoSignIns: [offered, required], organization: null }), null);
});

test("an older Den API without /v1/me/sso-sign-in falls back to the organization context", () => {
  assert.deepEqual(resolveReauthSsoTarget({ resolvedSignInUrl: null, organizationId: "org_abc", memberSsoSignIns: null, organization }), {
    signInUrl: "/sso/org_abc",
    ssoOnly: false,
  });
  assert.equal(resolveReauthSsoTarget({ resolvedSignInUrl: null, organizationId: null, memberSsoSignIns: null, organization: { ...organization, requireSso: true } })?.ssoOnly, true);
  assert.equal(resolveReauthSsoTarget({ resolvedSignInUrl: null, organizationId: null, memberSsoSignIns: null, organization: { ...organization, perOrganization: false } })?.ssoOnly, true);
  assert.equal(resolveReauthSsoTarget({ resolvedSignInUrl: null, organizationId: null, memberSsoSignIns: null, organization: { ...organization, hasSso: false } }), null);
  assert.equal(resolveReauthSsoTarget({ resolvedSignInUrl: null, organizationId: null, memberSsoSignIns: null, organization: { ...organization, slug: "a b/c" } })?.signInUrl, "/sso/a%20b%2Fc");
});

test("parses /v1/me/sso-sign-in and drops malformed entries", () => {
  assert.deepEqual(
    parseMemberSsoSignIns({ organizations: [{ ...offered, organizationSlug: "x" }, { organizationId: "", signInUrl: "x" }, "nope", { organizationId: "org_y", signInUrl: "/sso/y" }] }),
    [offered, { organizationId: "org_y", signInUrl: "/sso/y", ssoOnly: false }],
  );
  assert.equal(parseMemberSsoSignIns({ error: "not_found" }), null);
  assert.equal(parseMemberSsoSignIns(null), null);
});
