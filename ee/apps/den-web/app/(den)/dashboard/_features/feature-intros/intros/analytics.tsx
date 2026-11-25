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

export type AnalyticsPage = "usage" | "library" | "workflow-runs";
export type AnalyticsLibraryView = "plugins" | "skills" | "connectors";

export type AnalyticsFacts = {
  page?: AnalyticsPage;
  included?: boolean;
  activity?: boolean;
  members?: number;
  pendingInvites?: number;
  libraryView?: AnalyticsLibraryView;
  libraryItems?: number;
  libraryUsageRecorded?: boolean;
  workflowRuns?: number;
};

type Ctx = FeatureIntroContext<AnalyticsFacts>;
type Cta = FeatureIntroCta<AnalyticsFacts>;

export const OPENWORK_INSTALL_ROUTE = "/install";

const DOCS_ANALYTICS = "cloud/analytics#usage-and-adoption";
const DOCS_LIBRARY = "cloud/analytics#plugins-and-connectors";
const DOCS_WORKFLOWS = "cloud/analytics#workflow-runs";

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
      { when: (ctx) => ctx.facts.libraryItems === 0, label: "Create a plugin", href: getNewPluginRoute() },
      { when: () => true, label: "Download OpenWork", href: OPENWORK_INSTALL_ROUTE },
    ],
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
    summary: "See each run of your saved workflows and one-off tasks, and whether it worked.",
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
