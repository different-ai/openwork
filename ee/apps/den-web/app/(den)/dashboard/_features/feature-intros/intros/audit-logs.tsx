import { ScrollText } from "lucide-react";
import { getAuditLogsRoute, permissionLockReason } from "../../../../_lib/den-org";
import { ENTERPRISE_CONTACT_URL } from "../../../_lib/enterprise-contact";
import { defineFeatureIntro, type FeatureIntroContext } from "../types";
import { docsPage } from "./docs";
import { AuditLogsExample } from "./examples/audit-logs/audit-logs-example";
import { MEMBERS_INVITE_ROUTE } from "./members";

/**
 * Facts Audit logs reports from data it already loads (`entitlements.auditLogs`
 * from `GET /v1/org`, the first unfiltered page of `GET /v1/audit/operations`).
 * A missing fact means "not loaded yet": the intro never takes over the page on a guess.
 */
export type AuditLogsFacts = {
  /**
   * New activity can be recorded: Enterprise plan or a self-hosted install that turned it on
   * (`entitlements.auditLogs`). Reading history doesn't need it, so old entries stay visible.
   */
  included?: boolean;
  /** Operations on the first unfiltered page; 0 means nothing has been kept yet. */
  operations?: number;
};

type Ctx = FeatureIntroContext<AuditLogsFacts>;

/* Docs: no Audit logs page yet; "Security and operations" lists what is recorded. */
const DOCS = "cloud/security-and-operations#audit-events";

function notIncluded(ctx: Ctx): boolean {
  return ctx.facts.included === false;
}

export const auditLogsIntros = [
  defineFeatureIntro<AuditLogsFacts>({
    key: "audit-logs",
    version: 1,
    match: { path: getAuditLogsRoute() },
    icon: ScrollText,
    title: "Audit logs",
    summary: "See who changed what in your organization, and when.",
    bannerText: "New activity isn't recorded on your plan. Your history so far stays here.",
    highlights: [
      { title: "Every admin change.", text: "Invitations, roles, teams, API keys and single sign-on, with who made each change and whether it worked." },
      { title: "Before and after.", text: "Open an entry to see exactly what changed, step by step." },
      { title: "Find it fast.", text: "Filter by date, person, type of change or result." },
      { title: "No secrets kept.", text: "Tokens, API key secrets and certificates are never recorded." },
    ],
    example: {
      Component: AuditLogsExample,
      alt: "Example: recent changes. Priya Shah requested team creation for Engineering, Ada Lovelace created the API key CI deploy key and removed member jo@acme.com, and Sam Lee's request to delete the Design team failed.",
    },
    docsUrl: docsPage(DOCS),
    ctas: [
      // Seen from `?` by someone without access: the page itself shows the lock, so say the same here.
      { when: (ctx) => !ctx.can("canViewAuditLogs"), label: "View audit history", href: getAuditLogsRoute(), locked: { reason: permissionLockReason("audit.view") } },
      // Enterprise is sold by talking to us, like SCIM; billing has no Enterprise checkout.
      { when: (ctx) => notIncluded(ctx) && ctx.can("canManageBilling"), label: "Talk to us about Enterprise", href: ENTERPRISE_CONTACT_URL, note: () => "Recording audit logs is part of the Enterprise plan." },
      {
        when: notIncluded,
        label: "Talk to us about Enterprise",
        href: ENTERPRISE_CONTACT_URL,
        locked: { reason: `Recording audit logs is part of the Enterprise plan. ${permissionLockReason("billing.manage")}` },
      },
      // Recording is on but nothing kept yet: inviting someone is the first change it records.
      { when: (ctx) => ctx.can("canInviteMembers"), label: "Invite your team", href: MEMBERS_INVITE_ROUTE },
      { when: () => true, label: "Invite your team", href: MEMBERS_INVITE_ROUTE, locked: { reason: permissionLockReason("invitations.manage") } },
    ],
    // Full screen with no history; banner when history exists but the plan no longer records new activity.
    setupState: (ctx) => {
      if (ctx.facts.included === undefined || ctx.facts.operations === undefined) return "done";
      if (ctx.facts.operations === 0) return "none";
      return notIncluded(ctx) ? "partial" : "done";
    },
  }),
];
