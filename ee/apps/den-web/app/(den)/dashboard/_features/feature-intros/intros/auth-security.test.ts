import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrgAccessFlags, parseOrgContextPayload, type DenOrgAccessFlags, type DenOrgSsoConnection } from "../../../../_lib/den-org";
import { scimIntroState, ssoIntroState } from "../../../_components/auth-security-intro-facts";
import { matchFeatureIntro, pickIntroCta, selectIntroSize } from "../model";
import type { FeatureIntroContext, FeatureIntroPermission } from "../types";
import { type AuthSecurityFacts, authSecurityIntros } from "./auth-security";

const [section, sso, scim] = authSecurityIntros;

const orgContext = parseOrgContextPayload({
  organization: { id: "org_1", name: "Acme", slug: "acme" },
  currentMember: { id: "member_1", userId: "user_1", role: "owner", isOwner: true },
});
assert.ok(orgContext);
const ownerContext = orgContext;

function ctx(facts: AuthSecurityFacts, permissions: readonly FeatureIntroPermission[] = ["canManageSso", "canManageScim", "canManageBilling"]): FeatureIntroContext {
  const access: DenOrgAccessFlags = getOrgAccessFlags("member", false);
  return {
    orgId: "org_1",
    orgSlug: "acme",
    orgContext: ownerContext,
    access,
    isAdmin: false,
    can: (permission) => permissions.includes(permission),
    memberName: () => null,
    facts,
  };
}

const included = { ssoIncluded: true, scimIncluded: true, ssoReady: false };

test("auth & security intros match the page and its ?tab", () => {
  assert.equal(matchFeatureIntro(authSecurityIntros, "/dashboard/auth-security", null)?.key, "auth-security");
  assert.equal(matchFeatureIntro(authSecurityIntros, "/dashboard/auth-security", new URLSearchParams("tab=sso"))?.key, "auth-security.sso");
  assert.equal(matchFeatureIntro(authSecurityIntros, "/dashboard/auth-security", new URLSearchParams("tab=scim"))?.key, "auth-security.scim");
});

test("setup states come from the SSO connection and SCIM connector", () => {
  assert.equal(ssoIntroState(null), "none");
  assert.equal(ssoIntroState(fakeSso()), "verify-domain");
  assert.equal(ssoIntroState({ ...fakeSso(), status: "disabled", domainVerified: true }), "turn-on");
  assert.equal(ssoIntroState({ ...fakeSso(), status: "enabled", domainVerified: true }), "on");
  assert.equal(scimIntroState(null, { lastSuccessfulSyncAt: null }), "none");
  const connector = { id: "scim_1", providerId: "p", organizationId: "org_1", groupMappingMode: "metadata_only", createdAt: null, updatedAt: null } as const;
  assert.equal(scimIntroState(connector, { lastSuccessfulSyncAt: null }), "waiting");
  assert.equal(scimIntroState(connector, { lastSuccessfulSyncAt: "2026-11-03T12:00:00.000Z" }), "syncing");
});

test("the section takes the page only when neither is set up, and never on a guess", () => {
  assert.equal(section.setupState(ctx({ ...included })), "done");
  assert.equal(section.setupState(ctx({ ...included, sso: "none", scim: "none" })), "none");
  assert.equal(section.setupState(ctx({ ...included, sso: "verify-domain", scim: "none" })), "done");
  assert.equal(section.setupState(ctx({ ...included, sso: "none", scim: "waiting" })), "done");
});

test("tabs: box with nothing set up, banner while partly set up", () => {
  const sizeFor = (intro: typeof sso, facts: AuthSecurityFacts) => selectIntroSize({
    state: intro.setupState(ctx(facts)),
    parentState: section.setupState(ctx(facts)),
  })?.size ?? null;
  assert.equal(sizeFor(sso, { ...included, sso: "none", scim: "none" }), "fullscreen");
  assert.equal(sizeFor(scim, { ...included, sso: "on", scim: "none" }), "box");
  assert.equal(sizeFor(sso, { ...included, sso: "turn-on", scim: "none" }), "banner");
  assert.equal(sizeFor(sso, { ...included, sso: "on", scim: "none" }), null);
  assert.equal(sizeFor(scim, { ...included, sso: "on", scim: "waiting" }), "banner");
  assert.equal(sizeFor(scim, { ...included, sso: "on", scim: "syncing" }), null);
});

test("actions follow the plan and permissions, never offering what can't be done", () => {
  const free = { ssoIncluded: false, scimIncluded: false, ssoReady: false, sso: "none", scim: "none" } as const;
  assert.equal(pickIntroCta(section, ctx(free))?.label, "Upgrade to Team");
  assert.equal(pickIntroCta(section, ctx(free))?.locked, undefined);
  assert.match(pickIntroCta(section, ctx(free, ["canManageSso"]))?.locked?.reason ?? "", /Team plan/);
  assert.match(pickIntroCta(scim, ctx(free))?.href ?? "", /^https:\/\//);
  assert.match(pickIntroCta(scim, ctx(free, []))?.locked?.reason ?? "", /Enterprise plan/);

  const team = { ...included, scimIncluded: false, sso: "none", scim: "none" } as const;
  assert.equal(pickIntroCta(section, ctx(team))?.href, "/dashboard/auth-security?tab=sso&setup=1");
  assert.ok(pickIntroCta(section, ctx(team, []))?.locked);

  const enterprise = { ...included, sso: "on", scim: "none", ssoReady: true } as const;
  assert.equal(pickIntroCta(scim, ctx(enterprise))?.href, "/dashboard/auth-security?tab=scim&setup=1");
  assert.equal(pickIntroCta(scim, ctx({ ...enterprise, sso: "none", ssoReady: false }))?.label, "Set up single sign-on first");
  assert.equal(pickIntroCta(sso, ctx({ ...enterprise, sso: "verify-domain" }))?.href, "#sso-domain-verification");
  assert.equal(pickIntroCta(sso, ctx({ ...enterprise, sso: "turn-on" }))?.href, "#sso-connection");
});

function fakeSso(): DenOrgSsoConnection {
  return {
    id: "sso_1",
    providerId: "openwork-sso-org_1",
    kind: "saml",
    issuer: "https://idp.example.com",
    domain: "acme.com",
    status: "disabled",
    testStatus: "untested",
    testExpiresAt: null,
    signInPath: "/sso/acme",
    signInUrl: "https://app.example.com/sso/acme",
    redirectUrl: "https://app.example.com/api/auth/sso/callback",
    acsUrl: null,
    metadataUrl: null,
    domainVerified: false,
    domainVerificationHost: "_openwork",
    domainVerificationDnsName: "_openwork.acme.com",
    oidc: null,
    saml: null,
    lastTestedAt: null,
    lastError: null,
    createdAt: null,
    updatedAt: null,
  };
}
