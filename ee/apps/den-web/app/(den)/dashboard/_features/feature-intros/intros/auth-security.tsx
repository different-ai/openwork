import { KeyRound, ShieldCheck, UsersRound } from "lucide-react";
import { getAuthSecurityRoute, getBillingRoute, permissionLockReason } from "../../../../_lib/den-org";
import { ENTERPRISE_CONTACT_URL } from "../../../_lib/enterprise-contact";
import { defineFeatureIntro, type FeatureIntroContext, type FeatureIntroCta } from "../types";
import { docsPage } from "./docs";
import { AuthSecurityExample } from "./examples/auth-security/auth-security-example";
import { ScimExample } from "./examples/auth-security/scim-example";
import { SsoExample } from "./examples/auth-security/sso-example";

/** SSO connection, from `GET /v1/sso`: none, saved but domain not verified, verified but not on, on. */
export type AuthSecuritySsoState = "none" | "verify-domain" | "turn-on" | "on";
/** SCIM connector, from `GET /v1/scim`: none, created but nobody synced yet, syncing people. */
export type AuthSecurityScimState = "none" | "waiting" | "syncing";

/**
 * Facts the Auth & Security page reports from data it already loads. A
 * missing fact means "not loaded yet": a section never takes over the page on a guess.
 */
export type AuthSecurityFacts = {
  sso?: AuthSecuritySsoState;
  scim?: AuthSecurityScimState;
  /** SSO is in the organization's plan (Team and up, `entitlements.sso`). */
  ssoIncluded?: boolean;
  /** SCIM is in the organization's plan (Enterprise, `entitlements.scim`). */
  scimIncluded?: boolean;
  /** An enabled SSO connection exists, which SCIM needs (`GET /v1/scim` `ssoReady`). */
  ssoReady?: boolean;
};

type Ctx = FeatureIntroContext<AuthSecurityFacts>;
type Cta = FeatureIntroCta<AuthSecurityFacts>;

const PATH = getAuthSecurityRoute();
const SSO_SETUP = getAuthSecurityRoute(null, "sso", { setup: true });
const SCIM_SETUP = getAuthSecurityRoute(null, "scim", { setup: true });
const SSO_TAB = getAuthSecurityRoute(null, "sso");
const DOCS = "cloud/auth-and-security";

function sectionSetUp(ctx: Ctx): boolean {
  return (ctx.facts.sso ?? "none") !== "none" || (ctx.facts.scim ?? "none") !== "none";
}

/** Plan lock (P4, I6): upgrade where this person can, else say whose call it is. */
const ssoPlanCtas: readonly Cta[] = [
  { when: (ctx) => ctx.facts.ssoIncluded === false && ctx.can("canManageBilling"), label: "Upgrade to Team", href: getBillingRoute() },
  {
    when: (ctx) => ctx.facts.ssoIncluded === false,
    label: "Upgrade to Team",
    href: getBillingRoute(),
    locked: { reason: `Single sign-on is part of the Team plan. ${permissionLockReason("billing.manage")}` },
  },
];

const scimPlanCtas: readonly Cta[] = [
  { when: (ctx) => ctx.facts.scimIncluded === false && ctx.can("canManageBilling"), label: "Talk to us about Enterprise", href: ENTERPRISE_CONTACT_URL },
  {
    when: (ctx) => ctx.facts.scimIncluded === false,
    label: "Talk to us about Enterprise",
    href: ENTERPRISE_CONTACT_URL,
    locked: { reason: `User provisioning is part of the Enterprise plan. ${permissionLockReason("billing.manage")}` },
  },
];

export const authSecurityIntros = [
  defineFeatureIntro<AuthSecurityFacts>({
    key: "auth-security",
    version: 1,
    match: { path: PATH },
    icon: ShieldCheck,
    title: "Auth & Security",
    summary: "Let your team sign in with your company account, and keep who has access in sync on its own.",
    highlights: [
      { title: "Single sign-on.", text: "People sign in with the identity provider you already use, such as Okta, Microsoft Entra ID or Google Workspace." },
      { title: "Your domain, verified.", text: "People at your verified domain see your company sign-in first." },
      { title: "Joiners and leavers.", text: "With user provisioning, people added or removed in Okta or Microsoft Entra ID are added or removed here." },
      { title: "Groups become teams.", text: "Keep OpenWork teams in step with the groups in your identity provider." },
    ],
    example: {
      Component: AuthSecurityExample,
      alt: "Example: single sign-on with Okta turned on for acme.com, user provisioning from Okta syncing, and recent sign-ins and people added.",
    },
    docsUrl: docsPage(DOCS),
    ctas: [
      ...ssoPlanCtas,
      { when: (ctx) => ctx.can("canManageSso"), label: "Set up single sign-on", href: SSO_SETUP },
      { when: () => true, label: "Set up single sign-on", href: SSO_SETUP, locked: { reason: permissionLockReason("sso.manage") } },
    ],
    // Full screen only once both are known and neither is set up.
    setupState: (ctx) => {
      if (ctx.facts.sso === undefined || ctx.facts.scim === undefined) return "done";
      return sectionSetUp(ctx) ? "done" : "none";
    },
  }),

  defineFeatureIntro<AuthSecurityFacts>({
    key: "auth-security.sso",
    parent: "auth-security",
    version: 1,
    match: { path: PATH, tab: "sso" },
    icon: KeyRound,
    title: "Single sign-on (SSO)",
    summary: "Let people sign in with your company's identity provider instead of another password.",
    bannerText: "Your SSO connection is saved but not on yet. People can use it once your domain is verified, a test sign-in works and you turn it on.",
    highlights: [
      { title: "Any SAML or OIDC provider.", text: "Step-by-step guides for Okta, Microsoft Entra ID and Google Workspace." },
      { title: "Tested before it's on.", text: "Verify your domain and try a real sign-in. SSO stays off until you turn it on." },
      { title: "New people join on their own.", text: "Someone from your domain who signs in for the first time joins as a Member." },
    ],
    example: {
      Component: SsoExample,
      alt: "Example: an Acme sign-in page with Continue with Okta, the Okta connection on, acme.com verified and SSO required for the organization.",
    },
    docsUrl: docsPage(`${DOCS}#single-sign-on`),
    ctas: [
      ...ssoPlanCtas,
      { when: (ctx) => ctx.facts.sso === "verify-domain" && ctx.can("canManageSso"), label: "Verify your domain", href: "#sso-domain-verification" },
      { when: (ctx) => ctx.facts.sso === "turn-on" && ctx.can("canManageSso"), label: "Test and turn on SSO", href: "#sso-connection" },
      { when: (ctx) => ctx.can("canManageSso"), label: "Set up single sign-on", href: SSO_SETUP },
      { when: () => true, label: "Set up single sign-on", href: SSO_SETUP, locked: { reason: permissionLockReason("sso.manage") } },
    ],
    // Box with no connection; banner while a saved connection isn't on yet.
    setupState: (ctx) => {
      if (ctx.facts.sso === undefined || ctx.facts.sso === "none") return "none";
      return ctx.facts.sso === "on" ? "done" : "partial";
    },
  }),

  defineFeatureIntro<AuthSecurityFacts>({
    key: "auth-security.scim",
    parent: "auth-security",
    version: 1,
    match: { path: PATH, tab: "scim" },
    icon: UsersRound,
    title: "User provisioning (SCIM)",
    summary: "Add and remove people automatically when they join or leave in your identity provider.",
    bannerText: "Your SCIM connector is ready, but no one has synced yet. Add the base URL and token to your identity provider and assign people to OpenWork.",
    highlights: [
      { title: "Joiners and leavers.", text: "People assigned in Okta or Microsoft Entra ID get access, and lose it when they're removed there." },
      { title: "Groups become teams.", text: "Optionally create OpenWork teams from your identity provider's groups and keep them in sync." },
      { title: "Nothing missed quietly.", text: "Failed syncs are retried and shown here until they're resolved." },
    ],
    example: {
      Component: ScimExample,
      alt: "Example: a sync log from Okta: Priya Shah added, Sam Lee removed after being deactivated in Okta, and the Engineering group synced with 12 people.",
    },
    docsUrl: docsPage(`${DOCS}#user-provisioning`),
    ctas: [
      ...scimPlanCtas,
      { when: (ctx) => ctx.facts.scim === "waiting" && ctx.can("canManageScim"), label: "Connect your identity provider", href: "#scim-base-url" },
      {
        when: (ctx) => ctx.facts.ssoReady === false && ctx.can("canManageScim") && ctx.can("canManageSso"),
        label: "Set up single sign-on first",
        href: SSO_TAB,
        note: () => "User provisioning needs single sign-on turned on.",
      },
      {
        when: (ctx) => ctx.facts.ssoReady === false,
        label: "Set up single sign-on first",
        href: SSO_TAB,
        locked: { reason: `User provisioning needs single sign-on turned on. ${permissionLockReason("sso.manage")}` },
      },
      { when: (ctx) => ctx.can("canManageScim"), label: "Create a SCIM connector", href: SCIM_SETUP },
      { when: () => true, label: "Create a SCIM connector", href: SCIM_SETUP, locked: { reason: permissionLockReason("scim.manage") } },
    ],
    // Box with no connector; banner while nobody has synced from the identity provider yet.
    setupState: (ctx) => {
      if (ctx.facts.scim === undefined || ctx.facts.scim === "none") return "none";
      return ctx.facts.scim === "syncing" ? "done" : "partial";
    },
  }),
];
