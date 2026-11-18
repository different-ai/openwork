import { CreditCard, Laptop, Receipt, SlidersHorizontal, Stethoscope } from "lucide-react";
import {
  getBillingInvoicesRoute,
  getBillingRoute,
  getDesktopPoliciesRoute,
  getDiagnosticsRoute,
  getNewDesktopPolicyRoute,
  getOrgSettingsRoute,
  permissionLockReason,
} from "../../../../_lib/den-org";
import { ENTERPRISE_CONTACT_URL } from "../../../_lib/enterprise-contact";
import { defineFeatureIntro, type FeatureIntroContext } from "../types";
import { docsPage } from "./docs";
import { InvoicesExample } from "./examples/billing/invoices-example";

/** Invoices on the first page of `GET /v1/billing/stripe/invoices`; missing until it loads. */
export type BillingInvoicesFacts = { invoices?: number };

/*
 * Settings pages that are forms or reports, with nothing to set up: they never
 * take over the page and never get a dot (`helpOnly`), but `?` always has
 * something to say (DESIGN.md I1, I8). No live example: those are for the full
 * screen and box sizes (I7).
 */

/** The Allowed email domains card on General (`id` in org-settings-screen). */
export const ORG_SETTINGS_EMAIL_DOMAINS_ANCHOR = "#allowed-email-domains";

/** Desktop policy management is part of Enterprise (`entitlements.desktopPolicies`). */
function desktopPoliciesNotIncluded(ctx: FeatureIntroContext): boolean {
  return !ctx.orgContext.entitlements.desktopPolicies;
}

export const settingsIntros = [
  defineFeatureIntro({
    key: "org-settings",
    version: 1,
    helpOnly: true,
    match: { path: getOrgSettingsRoute() },
    icon: SlidersHorizontal,
    title: "General",
    summary: "Your organization's name, who can join it, and how people sign in.",
    highlights: [
      { title: "Allowed email domains.", text: "Only people with an email address at the domains you list can join." },
      { title: "Require single sign-on.", text: "People whose email matches your SSO connection sign in through it instead of a password." },
      { title: "Where Automations run.", text: "On each member's own desktop, in OpenWork Cloud even when every computer is off, or both." },
      { title: "Allowed desktop versions.", text: "Choose which supported versions of the desktop app can sign in." },
    ],
    docsUrl: docsPage("cloud/members-and-rbac#restrict-who-can-join"),
    ctas: [
      { when: (ctx) => ctx.can("canManageSettings"), label: "Restrict who can join", href: ORG_SETTINGS_EMAIL_DOMAINS_ANCHOR },
      { when: () => true, label: "Restrict who can join", href: ORG_SETTINGS_EMAIL_DOMAINS_ANCHOR, locked: { reason: permissionLockReason("organization.update") } },
    ],
    setupState: () => "done",
  }),

  defineFeatureIntro({
    key: "diagnostics",
    version: 1,
    helpOnly: true,
    match: { path: getDiagnosticsRoute() },
    icon: Stethoscope,
    title: "Diagnostics",
    summary: "See whether desktop apps, AI providers and connectors work, before someone runs into a problem.",
    highlights: [
      { title: "Desktop app.", text: "How long desktop apps take to start and connect in the last 24 hours, and why any launch failed." },
      { title: "AI providers.", text: "Whether each provider accepts its key and serves your models. No prompt is sent, so checks cost nothing." },
      { title: "Connectors.", text: "Whether the Slack assistant and Google Workspace connector can do their work." },
      { title: "Copy a report.", text: "Share every result in one message when you ask for help." },
    ],
    docsUrl: docsPage("self-host/diagnostics"),
    // Nothing to set up: the page itself is the action ("Check now").
    ctas: [],
    setupState: () => "done",
  }),

  defineFeatureIntro({
    key: "billing",
    version: 1,
    helpOnly: true,
    match: { path: getBillingRoute() },
    icon: CreditCard,
    title: "Billing",
    summary: "Your plan, how many people it covers, and how you pay.",
    highlights: [
      { title: "Free for up to 5 people.", text: "People who joined and invitations still waiting both count." },
      { title: "Team.", text: "$10 per person a month, paid by card." },
      { title: "Enterprise.", text: "SCIM, audit logs, required single sign-on and desktop policies, invoiced by OpenWork." },
    ],
    docsUrl: docsPage("cloud/billing"),
    // Plans are bought on this page itself; Enterprise is invoiced, not bought here.
    ctas: [],
    setupState: () => "done",
  }),

  defineFeatureIntro<BillingInvoicesFacts>({
    key: "billing.invoices",
    parent: "billing",
    version: 1,
    match: { path: getBillingInvoicesRoute() },
    icon: Receipt,
    title: "Invoices",
    summary: "Every invoice for your plan and add-ons, ready to view, pay or download.",
    highlights: [
      { title: "One a month.", text: "Stripe sends an invoice each time a subscription renews." },
      { title: "Pay what's due.", text: "Open an unpaid invoice to pay it by card." },
      { title: "For your records.", text: "Download each invoice and its receipt as a PDF." },
    ],
    example: {
      Component: InvoicesExample,
      alt: "Example: three monthly invoices. 1 November, $60, due; 1 October, $60, paid; 1 September, $50, paid.",
    },
    docsUrl: docsPage("cloud/billing"),
    // Invoices start with a paid plan, which is bought on Billing.
    ctas: [
      { when: (ctx) => ctx.can("canManageBilling"), label: "Choose a plan", href: getBillingRoute() },
      { when: () => true, label: "Choose a plan", href: getBillingRoute(), locked: { reason: permissionLockReason("billing.manage") } },
    ],
    // A box in place of the empty list; never on a guess before the list loads.
    setupState: (ctx) => (ctx.facts.invoices === 0 ? "none" : "done"),
  }),

  defineFeatureIntro({
    key: "desktop-policies",
    version: 1,
    helpOnly: true,
    match: { path: getDesktopPoliciesRoute() },
    icon: Laptop,
    title: "Desktop policies",
    summary: "Choose what the OpenWork desktop app lets members and teams do.",
    // Most policy enforcement is suspended (DESKTOP_POLICY_ENFORCEMENT_ENABLED): never promise more than model access.
    highlights: [
      { title: "A default for everyone.", text: "The default policy covers every member. Give some members or teams their own." },
      { title: "Model access works today.", text: "Turn off Custom providers to stop members adding their own AI providers." },
      { title: "Most switches are paused.", text: "Other switches and Restricted mode are saved, but the desktop app doesn't apply them yet." },
    ],
    docsUrl: docsPage("cloud/share-with-your-team/desktop-policies"),
    ctas: [
      { when: (ctx) => desktopPoliciesNotIncluded(ctx) && ctx.can("canManageBilling"), label: "Talk to us about Enterprise", href: ENTERPRISE_CONTACT_URL, note: () => "Desktop policy management is part of the Enterprise plan." },
      {
        when: desktopPoliciesNotIncluded,
        label: "Talk to us about Enterprise",
        href: ENTERPRISE_CONTACT_URL,
        locked: { reason: `Desktop policy management is part of the Enterprise plan. ${permissionLockReason("billing.manage")}` },
      },
      { when: (ctx) => ctx.can("canManageDesktopPolicies"), label: "Create a desktop policy", href: getNewDesktopPolicyRoute() },
      { when: () => true, label: "Create a desktop policy", href: getNewDesktopPolicyRoute(), locked: { reason: permissionLockReason("desktop_policies.manage") } },
    ],
    setupState: () => "done",
  }),
];
