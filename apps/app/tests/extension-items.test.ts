import { describe, expect, test } from "bun:test";

import type { McpDirectoryInfo } from "../src/app/constants";
import type { DenExternalMcpConnection, DenOrgPlugin } from "../src/app/lib/den";
import type { McpServerEntry } from "../src/app/types";
import { buildExtensionItems } from "../src/react-app/domains/settings/extension-items";

const connectedBuiltIn: McpDirectoryInfo = {
  id: "openwork-browser",
  name: "OpenWork Browser",
  serverName: "openwork-browser",
  description: "Connected by default.",
  oauth: false,
  kind: "extension",
  extensionManifest: {
    schemaVersion: 1,
    id: "openwork-browser",
    name: "OpenWork Browser",
    description: "Connected by default.",
    source: { format: "openwork-builtin", origin: "builtin", trusted: true },
    resources: [],
  },
};

const availableBuiltIn: McpDirectoryInfo = {
  id: "computer-use",
  name: "Computer Use",
  serverName: "computer-use",
  description: "Marketplace-only until installed.",
  oauth: false,
  kind: "extension",
  extensionManifest: {
    schemaVersion: 1,
    id: "computer-use",
    name: "Computer Use",
    description: "Marketplace-only until installed.",
    source: { format: "openwork-builtin", origin: "builtin", trusted: true },
    resources: [],
  },
};

const notionQuickConnect: McpDirectoryInfo = {
  name: "Notion",
  serverName: "notion",
  description: "Pages and databases.",
  url: "https://mcp.notion.com/mcp",
  type: "remote",
  oauth: true,
  kind: "mcp",
};

const directNotionServer: McpServerEntry = {
  name: "notion",
  config: {
    type: "remote",
    url: "https://mcp.notion.com/mcp",
  },
};

function orgMcpConnection(input: Partial<DenExternalMcpConnection> = {}): DenExternalMcpConnection {
  return {
    id: input.id ?? "externalMcpConnection_notion",
    name: input.name ?? "Notion",
    url: input.url ?? "https://mcp.notion.com/mcp",
    authType: input.authType ?? "oauth",
    credentialMode: input.credentialMode ?? "per_member",
    connected: input.connected ?? true,
    connectedAt: input.connectedAt ?? null,
    connectedForMe: input.connectedForMe ?? false,
    ...(input.needsReconnect !== undefined ? { needsReconnect: input.needsReconnect } : {}),
    ...(input.missingFeatures !== undefined ? { missingFeatures: input.missingFeatures } : {}),
  };
}

function marketplace(input: Partial<{ id: string; name: string; updatedAt: string; plugins: DenOrgPlugin[] }> = {}) {
  return {
    marketplace: {
      id: input.id ?? "mkt_test",
      name: input.name ?? "Test Marketplace",
      description: null,
      status: "active",
      pluginCount: input.plugins?.length ?? 0,
      updatedAt: input.updatedAt ?? "2026-07-19T00:00:00.000Z",
    },
    plugins: input.plugins ?? [],
  };
}

function plugin(input: Partial<DenOrgPlugin> = {}): DenOrgPlugin {
  return {
    id: input.id ?? "plg_test",
    name: input.name ?? "Test Plugin",
    description: input.description ?? null,
    status: input.status ?? "active",
    memberCount: input.memberCount ?? 0,
    updatedAt: input.updatedAt ?? "2026-07-19T00:00:00.000Z",
    componentCounts: input.componentCounts ?? {},
    extension: input.extension ?? null,
    cloudReadiness: input.cloudReadiness,
  };
}

describe("extension item projection", () => {
  test("dedupes cloud plugins that appear in multiple marketplaces", () => {
    const benhvienPhuTho = plugin({
      id: "plg_benhvienphutho",
      name: "benhvienphutho-skills",
      memberCount: 12,
      componentCounts: { skill: 12 },
    });
    const result = buildExtensionItems({
      quickConnect: [],
      mcpServers: [],
      installedSkills: [],
      importedCloudPlugins: {},
      cloudMarketplaces: [
        marketplace({ id: "mkt_old", name: "Old Marketplace", updatedAt: "2026-07-15T00:00:00.000Z", plugins: [benhvienPhuTho] }),
        marketplace({ id: "mkt_new", name: "New Marketplace", updatedAt: "2026-07-19T00:00:00.000Z", plugins: [benhvienPhuTho] }),
      ],
      enablementContext: {},
      isBuiltInConnected: () => false,
    });

    const cloudItems = result.items.filter((item) => item.source === "marketplace");
    expect(cloudItems.map((item) => item.marketplaceId)).toEqual(["mkt_new"]);
  });

  test("keeps unconnected built-ins out of My Extensions quick connect", () => {
    const result = buildExtensionItems({
      quickConnect: [connectedBuiltIn, availableBuiltIn],
      mcpServers: [],
      installedSkills: [],
      importedCloudPlugins: {},
      cloudMarketplaces: [],
      enablementContext: {},
      isBuiltInConnected: (entry) => entry.id === connectedBuiltIn.id,
    });

    expect(result.installedMcpEntries.map((entry) => entry.name)).toEqual(["OpenWork Browser"]);
    expect(result.builtInItems.map((item) => item.name)).toEqual(["OpenWork Browser", "Computer Use"]);
  });

  test("projects per-member org MCP grants as Marketplace items until connected", () => {
    const result = buildExtensionItems({
      quickConnect: [notionQuickConnect],
      mcpServers: [],
      installedSkills: [],
      importedCloudPlugins: {},
      cloudMarketplaces: [],
      orgMcpConnections: [orgMcpConnection()],
      enablementContext: {},
      isBuiltInConnected: () => false,
    });

    expect(result.orgMcpConnectionItems.map((item) => ({ name: item.name, state: item.installState, active: item.active }))).toEqual([
      { name: "Notion", state: "available", active: false },
    ]);
    expect(result.quickConnectEntries.map((entry) => entry.name)).toEqual([]);
  });

  test("moves connected per-member org MCP grants into My Extensions", () => {
    const result = buildExtensionItems({
      quickConnect: [notionQuickConnect],
      mcpServers: [],
      installedSkills: [],
      importedCloudPlugins: {},
      cloudMarketplaces: [],
      orgMcpConnections: [orgMcpConnection({ connectedForMe: true })],
      enablementContext: {},
      isBuiltInConnected: () => false,
    });

    expect(result.orgMcpConnectionItems.map((item) => ({ name: item.name, state: item.installState, active: item.active }))).toEqual([
      { name: "Notion", state: "installed", active: true },
    ]);
    expect(result.items.some((item) => item.source === "org-connection" && item.installState === "installed")).toBe(true);
  });

  test("keeps a connected grant with missing features out of ready state", () => {
    const result = buildExtensionItems({
      quickConnect: [notionQuickConnect],
      mcpServers: [],
      installedSkills: [],
      importedCloudPlugins: {},
      cloudMarketplaces: [],
      orgMcpConnections: [orgMcpConnection({
        connectedForMe: true,
        needsReconnect: false,
        missingFeatures: ["databaseWrite"],
      })],
      enablementContext: {},
      isBuiltInConnected: () => false,
    });

    expect(result.orgMcpConnectionItems.map((item) => ({
      state: item.installState,
      setup: item.setupState,
      active: item.active,
    }))).toEqual([{ state: "available", setup: "needs_setup", active: false }]);
  });

  test("keeps configured direct MCPs even when an org equivalent exists", () => {
    const result = buildExtensionItems({
      quickConnect: [notionQuickConnect],
      mcpServers: [directNotionServer],
      installedSkills: [],
      importedCloudPlugins: {},
      cloudMarketplaces: [],
      orgMcpConnections: [orgMcpConnection()],
      enablementContext: {},
      isBuiltInConnected: () => false,
    });

    expect(result.quickConnectEntries.map((entry) => entry.name)).toEqual(["Notion"]);
    expect(result.installedMcpEntries.map((entry) => entry.name)).toEqual(["Notion"]);
  });

  test("does not dedupe static Quick Connect for unfinished shared org MCPs", () => {
    const result = buildExtensionItems({
      quickConnect: [notionQuickConnect],
      mcpServers: [],
      installedSkills: [],
      importedCloudPlugins: {},
      cloudMarketplaces: [],
      orgMcpConnections: [orgMcpConnection({ credentialMode: "shared", connected: false, connectedForMe: false })],
      enablementContext: {},
      isBuiltInConnected: () => false,
    });

    expect(result.orgMcpConnectionItems).toEqual([]);
    expect(result.quickConnectEntries.map((entry) => entry.name)).toEqual(["Notion"]);
  });
});
