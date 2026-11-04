import { Wrench } from "lucide-react";
import { getMcpConnectionsRoute, getToolTesterRoute, permissionLockReason } from "../../../../_lib/den-org";
import { defineFeatureIntro, type FeatureIntroContext } from "../types";
import type { ConnectorsFacts } from "./connectors";
import { docsPage } from "./docs";
import { ToolTesterExample } from "./examples/settings/tool-tester-example";

/**
 * Settings › Tool Tester sits under the Connectors section: with no connector
 * at all the Connectors full screen shows; with connectors but none the viewer
 * can test yet, this box replaces "No connected, testable MCP connections".
 */
export type ToolTesterFacts = ConnectorsFacts & {
  /** Connectors the viewer can run tools on now: connected, not a built-in provider, no reconnect needed. */
  testableConnectors?: number;
};

type Ctx = FeatureIntroContext<ToolTesterFacts>;

export const toolTesterIntros = [
  defineFeatureIntro<ToolTesterFacts>({
    key: "connectors.tool-tester",
    parent: "connectors",
    version: 1,
    match: { path: getToolTesterRoute() },
    icon: Wrench,
    title: "Tool Tester",
    summary: "Try any tool a connector offers before your team's AI relies on it.",
    highlights: [
      { title: "Runs as you.", text: "Each run uses your own sign-in and is never written to OpenWork logs." },
      { title: "See what was sent.", text: "Inspect the exact request and the app's answer." },
      { title: "Turn tools off.", text: "A tool you turn off can't be found or called by anyone's AI in your organization." },
    ],
    example: {
      Component: ToolTesterExample,
      alt: "Example: running list_issues on Linear as you, returning 12 issues in 318 ms, with delete_issue turned off for the organization.",
    },
    docsUrl: docsPage("cloud/share-with-your-team/tool-tester"),
    ctas: [
      { when: (ctx: Ctx) => ctx.can("canManageConnections"), label: "Connect a connector", href: getMcpConnectionsRoute() },
      { when: () => true, label: "Connect a connector", href: getMcpConnectionsRoute(), locked: { reason: permissionLockReason("connections.manage") } },
    ],
    setupState: (ctx) => {
      if (ctx.facts.testableConnectors === undefined) return "done";
      return ctx.facts.testableConnectors > 0 ? "done" : "none";
    },
  }),
];
