import { describe, expect, test } from "bun:test";

import type { McpDirectoryInfo } from "../src/app/constants";
import type { DenExternalMcpConnection } from "../src/app/lib/den";
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
  };
}

describe("extension item projection", () => {
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
