import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  configuredConnectionForPopular,
  connectionForPresetUrl,
  connectorChatDeepLink,
  connectorChatPrompt,
  POPULAR_CONNECTORS,
  remainingPresets,
} from "../app/(den)/dashboard/_components/connector-catalog";
import type { ExternalMcpConnection, ExternalMcpPreset } from "../app/(den)/dashboard/_components/mcp-connections-data";

function readDashboardFile(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(`../app/(den)/dashboard/${relativePath}`, import.meta.url)), "utf8");
}

const PRESETS: ExternalMcpPreset[] = [
  { presetId: "github", displayName: "GitHub", description: "PRs", url: "https://api.githubcopilot.com/mcp/", authType: "oauth", requiresOAuthClient: true },
  { presetId: "notion", displayName: "Notion", description: "Docs", url: "https://mcp.notion.com/mcp", authType: "oauth" },
  { presetId: "slack", displayName: "Slack", description: "Chat", url: "https://mcp.slack.com/mcp", authType: "oauth", requiresOAuthClient: true },
  { presetId: "linear", displayName: "Linear", description: "Issues", url: "https://mcp.linear.app/mcp", authType: "oauth" },
  { presetId: "context7", displayName: "Context7", description: "Docs", url: "https://mcp.context7.com/mcp", authType: "none" },
];

function connection(overrides: Partial<ExternalMcpConnection> & Pick<ExternalMcpConnection, "id" | "name" | "url">): ExternalMcpConnection {
  return {
    authType: "oauth",
    credentialMode: "per_member",
    connected: false,
    connectedAt: null,
    updatedAt: null,
    connectedForMe: false,
    requiredBy: [],
    identityManagedBy: [],
    access: null,
    ...overrides,
  };
}

describe("popular connector catalog", () => {
  test("lists the six popular connectors in the approved order with starter prompts", () => {
    expect(POPULAR_CONNECTORS.map((connector) => connector.displayName)).toEqual([
      "Gmail",
      "GitHub",
      "Google Drive",
      "Google Calendar",
      "Notion",
      "Slack",
    ]);
    for (const connector of POPULAR_CONNECTORS) {
      expect(connector.chatPrompt.startsWith("Explain")).toBe(true);
      expect(connector.chatPrompt.toLowerCase()).toContain("if access is available");
      expect(connector.chatPrompt).toContain("Otherwise,");
      expect(connector.chatPrompt).toContain("without accessing");
    }
  });

  test("describes the native service management delivered with the catalog", () => {
    expect(POPULAR_CONNECTORS.find((connector) => connector.id === "gmail")?.description).toBe("Read, send, and manage Gmail");
    expect(POPULAR_CONNECTORS.find((connector) => connector.id === "google-calendar")?.description).toBe("Create, reschedule, and manage Google Calendar events");
    const drive = POPULAR_CONNECTORS.find((connector) => connector.id === "google-drive");
    expect(drive?.description).toBe("Organize files, read Docs and Slides, and edit Sheets");
    expect(drive?.chatPrompt).toContain("last 7 days");
    expect(drive?.chatPrompt).toContain("follow pagination");
    expect(drive?.chatPrompt).toContain("incomplete search");
    expect(drive?.chatPrompt).toContain("without accessing Drive");
  });

  test("builds an openwork:// chat deep link carrying the connector and its prompt", () => {
    const href = connectorChatDeepLink({ connector: "GitHub", prompt: connectorChatPrompt("GitHub") });
    const url = new URL(href);
    expect(url.protocol).toBe("openwork:");
    expect(url.hostname).toBe("chat");
    expect(url.searchParams.get("connector")).toBe("GitHub");
    expect(url.searchParams.get("prompt")).toBe(
      "Explain how I can review a GitHub repo's authentication. Ask which repo to use; if access is available, inspect its code and docs. Otherwise, outline a review checklist without accessing the repo.",
    );
  });

  test("falls back to an explain prompt for connectors without a curated one", () => {
    expect(connectorChatPrompt("Render")).toBe(
      "Explain how I could use Render: suggest three useful tasks and distinguish general ideas from tools available here. If access is unavailable, help me plan without connecting.",
    );
  });

  test("resolves Gmail, Drive, and Calendar to the single Google Workspace connection", () => {
    const google = connection({ id: "conn-google", name: "Google Workspace", url: "https://www.googleapis.com", nativeProviderKey: "google-workspace" });
    for (const id of ["gmail", "google-drive", "google-calendar"]) {
      const popular = POPULAR_CONNECTORS.find((connector) => connector.id === id);
      expect(popular).toBeDefined();
      expect(configuredConnectionForPopular(popular!, [google], PRESETS)?.id).toBe("conn-google");
      expect(configuredConnectionForPopular(popular!, [], PRESETS)).toBeUndefined();
    }
  });

  test("matches preset-backed rows by comparable URL, ignoring a trailing slash", () => {
    const github = connection({ id: "conn-github", name: "GitHub", url: "https://api.githubcopilot.com/mcp" });
    const popularGithub = POPULAR_CONNECTORS.find((connector) => connector.id === "github")!;
    expect(configuredConnectionForPopular(popularGithub, [github], PRESETS)?.id).toBe("conn-github");
    expect(connectionForPresetUrl([github], "https://api.githubcopilot.com/mcp/")?.id).toBe("conn-github");
    expect(connectionForPresetUrl([github], "https://mcp.notion.com/mcp")).toBeUndefined();
  });

  test("keeps only non-popular presets for the More section", () => {
    expect(remainingPresets(PRESETS).map((preset) => preset.presetId)).toEqual(["linear", "context7"]);
  });
});

describe("connector pages", () => {
  test("the old editor routes are gone and the list page only renders the new list", () => {
    const page = readDashboardFile("(admin)/mcp-connections/page.tsx");
    expect(page).toContain("<AdminConnectorsScreen />");
    expect(page).not.toContain("McpConnectionsScreen");
    expect(page).toContain("redirect(getAddConnectorRoute(null, catalogId))");
    for (const removed of ["(admin)/mcp-connections/all/page.tsx", "(admin)/mcp-connections/configured/page.tsx", "_components/mcp-connections-screen.tsx"]) {
      expect(() => readDashboardFile(removed)).toThrow();
    }
  });

  test("Google Workspace and Microsoft 365 set up on their own page in the new flow", () => {
    const setupPage = readDashboardFile("(admin)/mcp-connections/new/[catalogId]/page.tsx");
    expect(setupPage).toContain("isNativeProviderCatalogId(id)");
    expect(setupPage).toContain("<NativeProviderSetupScreen providerKey={id} />");
  });
});
