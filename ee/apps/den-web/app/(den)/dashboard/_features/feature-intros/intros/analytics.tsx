import { BarChart3, Blocks, ScrollText } from "lucide-react";
import {
  getAddConnectorRoute,
  getAnalyticsRoute,
  getLibraryUsageRoute,
  getNewPluginRoute,
  getWorkflowRunsRoute,
  permissionLockReason,
} from "../../../../_lib/den-org";
import { ENTERPRISE_CONTACT_URL } from "../../../_lib/enterprise-contact";
import { defineFeatureIntro, type FeatureIntroContext, type FeatureIntroCta } from "../types";
import { docsPage } from "./docs";
import { AnalyticsExample } from "./examples/analytics/analytics-example";
import { LibraryUsageExample } from "./examples/analytics/library-usage-example";
import { WorkflowRunsExample } from "./examples/analytics/workflow-runs-example";
import { MEMBERS_INVITE_ROUTE } from "./members";

/** Which Analytics page reported the facts. Each view loads its own data. */
export type AnalyticsPage = "usage" | "library" | "workflow-runs";
/** The Plugins & connectors view the person is looking at (`?view=`). */
export type AnalyticsLibraryView = "plugins" | "skills" | "connectors";

/**
 * Facts the Analytics pages report from data they already load
 * (`GET /v1/telemetry/analytics`, `GET /v1/library-usage/:kind`,
 * `GET /v1/workflow-runs`, `entitlements.analytics` from `GET /v1/org`).
 * A missing fact means "not loaded yet": nothing takes over the page on a guess.
 */
export type AnalyticsFacts = {
  page?: AnalyticsPage;
  /** Usage & adoption is in the organization's plan (Enterprise when plan gating is on). */
  included?: boolean;
  /** Any active person, session or task in the last 30 days, across all projects. */
  activity?: boolean;
  /** People in the organization and invitations still open (`members`, `pendingInvites`). */
  members?: number;
  pendingInvites?: number;
  libraryView?: AnalyticsLibraryView;
  /** Plugins, skills or connectors in this view, used or not. */
  libraryItems?: number;
  /** Any use of them has been recorded (`trackingSince` or a use in the window). */
  libraryUsageRecorded?: boolean;
  /** Runs on the Workflow runs page (`GET /v1/workflow-runs`). */
  workflowRuns?: number;
};

type Ctx = FeatureIntroContext<AnalyticsFacts>;
type Cta = FeatureIntroCta<AnalyticsFacts>;

/** Usage only shows up once someone uses the OpenWork app, so the install page is the action that creates data. */
export const OPENWORK_INSTALL_ROUTE = "/install";

/* Docs: one Analytics page, a section per tab. */
const DOCS_ANALYTICS = "cloud/analytics#usage-and-adoption";
const DOCS_LIBRARY = "cloud/analytics#plugins-and-connectors";
const DOCS_WORKFLOWS = "cloud/analytics#workflow-runs";

/** Only the person in the organization so far: inviting people comes before usage. */
function alone(ctx: Ctx): boolean {
  return (ctx.facts.members ?? 0) <= 1 && (ctx.facts.pendingInvites ?? 0) === 0;
}

const USAGE_NOTE = "Usage shows up once someone signs in to the OpenWork app and runs a task.";

export const analyticsIntros = [
  defineFeatureIntro<AnalyticsFacts>({
    key: "analytics",
    version: 1,
    match: { path: getAnalyticsRoute() },
    icon: BarChart3,
    title: "Analytics",
    summary: "See who on your team uses OpenWork, how often, and whether their tasks work.",
    highlights: [
      { title: "Adoption at a glance.", text: "Active people, sessions and tasks each week, with daily and weekly trends." },
      { title: "Models in use.", text: "Which models people pick, and how often they keep the default." },
      { title: "One project at a time.", text: "Narrow every number to a single project to follow a rollout." },
      { title: "Never your content.", text: "Only counts. Prompts, code and file contents are never included." },
    ],
    example: {
      Component: AnalyticsExample,
      alt: "Example: this week 18 of 24 people active, 412 sessions and 1,280 tasks with a 96% success rate, daily active users rising over two weeks, and sessions by model: Claude Sonnet 5 214, GPT-6 Luna 131 and Gemini 3 Pro 67.",
    },
    docsUrl: docsPage(DOCS_ANALYTICS),
    ctas: [
      // Enterprise is sold by talking to us, like SCIM; billing has no Enterprise checkout.
      { when: (ctx) => ctx.facts.included === false && ctx.can("canManageBilling"), label: "Talk to us about Enterprise", href: ENTERPRISE_CONTACT_URL, note: () => "Usage analytics is part of the Enterprise plan." },
      {
        when: (ctx) => ctx.facts.included === false,
        label: "Talk to us about Enterprise",
        href: ENTERPRISE_CONTACT_URL,
        locked: { reason: `Usage analytics is part of the Enterprise plan. ${permissionLockReason("billing.manage")}` },
      },
      { when: (ctx) => alone(ctx) && ctx.can("canInviteMembers"), label: "Invite your team", href: MEMBERS_INVITE_ROUTE, note: () => USAGE_NOTE },
      { when: () => true, label: "Download OpenWork", href: OPENWORK_INSTALL_ROUTE, note: () => USAGE_NOTE },
    ],
    // Takes over Usage & adoption only (tabs stay): Plugins & connectors works on every plan, and
    // workflow runs also come from AI tools connected through OpenWork MCP, so neither is "nothing".
    setupState: (ctx) => {
      if (ctx.facts.page !== "usage") return "done";
      if (ctx.facts.included === false) return "none";
      if (ctx.facts.activity === undefined) return "done";
      return ctx.facts.activity ? "done" : "none";
    },
  }),

  defineFeatureIntro<AnalyticsFacts>({
    key: "analytics.library",
    parent: "analytics",
    version: 1,
    match: { path: getLibraryUsageRoute() },
    icon: Blocks,
    title: "Plugin and connector usage",
    summary: "See which skills, plugins and connectors your team uses, and which ones fail.",
    bannerText: "Nothing has been used yet. Counts start once people use these in OpenWork.",
    highlights: [
      { title: "Find what nobody uses.", text: "Spot the skills and plugins to improve, or to retire." },
      { title: "Catch failures early.", text: "See which connectors fail, so you can fix them before people give up." },
      { title: "Down to each person.", text: "Open any item to see who uses it and how often." },
    ],
    example: {
      Component: LibraryUsageExample,
      alt: "Example: skills used in the last 30 days. Release notes 214 uses, last used 2 hours ago; Brand voice 96 uses; Deal summary 41 uses; Weekly report not used.",
    },
    docsUrl: docsPage(DOCS_LIBRARY),
    ctas: [
      { when: (ctx) => ctx.facts.libraryItems === 0 && ctx.facts.libraryView === "connectors" && ctx.can("canManageConnections"), label: "Add a connector", href: getAddConnectorRoute() },
      {
        when: (ctx) => ctx.facts.libraryItems === 0 && ctx.facts.libraryView === "connectors",
        label: "Add a connector",
        href: getAddConnectorRoute(),
        locked: { reason: permissionLockReason("connections.manage") },
      },
      // Any member can create a plugin (`plugin.create` needs no permission), so there is no locked variant.
      { when: (ctx) => ctx.facts.libraryItems === 0, label: "Create a plugin", href: getNewPluginRoute() },
      { when: () => true, label: "Download OpenWork", href: OPENWORK_INSTALL_ROUTE },
    ],
    // Box while this view has nothing in it; banner while it has items nobody has used yet.
    setupState: (ctx) => {
      if (ctx.facts.libraryItems === undefined || ctx.facts.libraryUsageRecorded === undefined) return "done";
      if (ctx.facts.libraryItems === 0) return "none";
      return ctx.facts.libraryUsageRecorded ? "done" : "partial";
    },
  }),

  defineFeatureIntro<AnalyticsFacts>({
    key: "analytics.workflow-runs",
    parent: "analytics",
    version: 1,
    match: { path: getWorkflowRunsRoute() },
    icon: ScrollText,
    title: "Workflow runs",
    summary: "See every run of a saved workflow or one-off task, and whether it worked.",
    highlights: [
      { title: "Worked or failed.", text: "Each run with its result and when it finished." },
      { title: "See the steps.", text: "Open a run to see its workflow and the tools it used." },
      { title: "From anywhere.", text: "Runs from OpenWork, Automations and AI tools connected through OpenWork MCP." },
    ],
    example: {
      Component: WorkflowRunsExample,
      alt: "Example: Weekly sales digest succeeded today at 9:00, a one-off task succeeded at 8:42, and Invoice follow-up failed yesterday.",
    },
    docsUrl: docsPage(DOCS_WORKFLOWS),
    ctas: [{ when: () => true, label: "Download OpenWork", href: OPENWORK_INSTALL_ROUTE }],
    setupState: (ctx) => {
      if (ctx.facts.workflowRuns === undefined) return "done";
      return ctx.facts.workflowRuns > 0 ? "done" : "none";
    },
  }),
];
