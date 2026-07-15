declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toHaveLength: (expected: number) => void;
};

import type { DenExternalMcpConnection, DenOrgPlugin } from "@/app/lib/den";
import type { ExtensionItem } from "@/react-app/domains/settings/extension-items";
import { buildConnectRows } from "./connect-view";

const notionConnection = {
  id: "connection-notion",
  name: "Customer Briefing / notion",
  url: "https://mcp.notion.com/mcp",
  authType: "oauth",
  credentialMode: "per_member",
  connected: false,
  connectedAt: null,
  connectedForMe: false,
} satisfies DenExternalMcpConnection;

const customerBriefing = {
  id: "plugin-customer-briefing",
  name: "Customer Briefing",
  description: "Prepare customer briefings.",
  status: "active",
  memberCount: 2,
  updatedAt: null,
  componentCounts: { skill: 1, mcp: 1 },
  cloudReadiness: {
    state: "needs_signin",
    hasInstructional: true,
    connections: [{
      id: notionConnection.id,
      name: notionConnection.name,
      url: notionConnection.url,
      credentialMode: notionConnection.credentialMode,
      connectedForMe: false,
    }],
  },
} satisfies DenOrgPlugin;

const customerBriefingItem = {
  id: "marketplace:team-workflows:plugin-customer-briefing",
  source: "marketplace",
  name: customerBriefing.name,
  description: customerBriefing.description,
  installState: "available",
  setupState: "needs_setup",
  active: false,
  enablement: null,
  resources: [],
  marketplaceId: "team-workflows",
  marketplaceName: "Team Workflows",
  plugin: customerBriefing,
} satisfies ExtensionItem;

describe("buildConnectRows", () => {
  test("shows a marketplace workflow once instead of duplicating its MCP connection", () => {
    const rows = buildConnectRows({
      connections: [notionConnection],
      items: [customerBriefingItem],
      role: "member",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("plugin");
    expect(rows[0]?.name).toBe("Customer Briefing");
    expect(rows[0]?.group).toBe("needs_signin");
  });

  test("keeps standalone organization connections visible", () => {
    const rows = buildConnectRows({
      connections: [notionConnection],
      items: [],
      role: "member",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("connection");
  });
});
