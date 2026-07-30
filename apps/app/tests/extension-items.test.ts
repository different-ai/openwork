import { describe, expect, test } from "bun:test";

import type { McpDirectoryInfo } from "../src/app/constants";
import type { DenExternalMcpConnection } from "../src/app/lib/den";
import type { McpServerEntry } from "../src/app/types";
import {
  buildExtensionItems,
  isOpenworkProvidedSkill,
  resolveExtensionInventoryGroup,
  type ExtensionItem,
} from "../src/react-app/domains/settings/extension-items";

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

describe("extension item projection", () => {
  test("attributes only current OpenWork-provided local skills", () => {
    expect(isOpenworkProvidedSkill({
      name: "skill-creator",
      path: "/workspace/.opencode/skills/skill-creator/SKILL.md",
    })).toBe(true);
    expect(isOpenworkProvidedSkill({
      name: "workspace-guide",
      path: String.raw`C:\workspace\.opencode\skills\workspace-guide\SKILL.md`,
    })).toBe(true);

    for (const name of [
      "get-started",
      "command-creator",
      "agent-creator",
      "plugin-creator",
      "customer-creator",
    ]) {
      expect(isOpenworkProvidedSkill({
        name,
        path: `/workspace/.opencode/skills/${name}/SKILL.md`,
      })).toBe(false);
    }
  });

  test("lists built-ins that are not set up yet, but never uninstalled directory entries", () => {
    const result = buildExtensionItems({
      quickConnect: [connectedBuiltIn, availableBuiltIn, notionQuickConnect],
      mcpServers: [],
      installedSkills: [],
      importedCloudPlugins: {},
      cloudMarketplaces: [],
      enablementContext: {},
      isBuiltInConnected: (entry) => entry.id === connectedBuiltIn.id,
    });

    expect(result.installedMcpEntries.map((entry) => entry.name)).toEqual(["OpenWork Browser"]);
    expect(result.builtInItems.map((item) => item.name)).toEqual(["OpenWork Browser", "Computer Use"]);
    expect(result.quickConnectEntries.map((entry) => entry.name)).toEqual(["OpenWork Browser", "Computer Use"]);
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

  test("hides an unfinished shared org MCP instead of offering it as something to add", () => {
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
    expect(result.quickConnectEntries).toEqual([]);
  });
});

describe("resolveExtensionInventoryGroup", () => {
  const baseItem = (overrides: Partial<ExtensionItem> = {}): ExtensionItem => ({
    id: "builtin:openwork-browser",
    source: "builtin",
    name: "OpenWork Browser",
    description: null,
    installState: "installed",
    setupState: "ready",
    active: true,
    enablement: null,
    resources: [],
    ...overrides,
  });

  test("marks disabled items first", () => {
    expect(resolveExtensionInventoryGroup(baseItem({ installState: "available" }), {
      disabledReason: "Disabled by organization",
    })).toBe("disabled");
  });

  test("maps available install state", () => {
    expect(resolveExtensionInventoryGroup(baseItem({ installState: "available" }))).toBe("available");
  });

  test("maps installed local items to ready", () => {
    expect(resolveExtensionInventoryGroup(baseItem())).toBe("ready");
  });

  test("maps org connection readiness", () => {
    expect(resolveExtensionInventoryGroup(baseItem({
      source: "org-connection",
      installState: "available",
      orgMcpConnection: orgMcpConnection({ connectedForMe: false }),
    }))).toBe("needs_signin");
  });
});
