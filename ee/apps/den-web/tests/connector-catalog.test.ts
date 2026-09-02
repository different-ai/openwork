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
    }
  });

  test("builds an openwork:// chat deep link carrying the connector and its prompt", () => {
    const href = connectorChatDeepLink({ connector: "GitHub", prompt: connectorChatPrompt("GitHub") });
    const url = new URL(href);
    expect(url.protocol).toBe("openwork:");
    expect(url.hostname).toBe("chat");
    expect(url.searchParams.get("connector")).toBe("GitHub");
    expect(url.searchParams.get("prompt")).toBe(
      "Explain this repo's authentication using code and docs: components, request flow, and how credentials and tokens are handled",
    );
  });

  test("falls back to an explain prompt for connectors without a curated one", () => {
    expect(connectorChatPrompt("Render")).toBe(
      "Explain what you can do with Render: list the tools it exposes and suggest three useful tasks to start with.",
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
  test("the catalog page shows Configured first, then Popular, then More, and never the configured list", () => {
    const screen = readDashboardFile("_components/mcp-connections-screen.tsx");
    const catalog = readDashboardFile("_components/connector-catalog-list.tsx");

    expect(screen).toContain("<ConnectorCatalog");
    expect(screen).not.toContain("<ConnectorQuickAddGrid");
    expect(catalog.indexOf("ConfiguredConnectorStrip connections")).toBeLessThan(catalog.indexOf('data-testid="popular-connectors"'));
    expect(catalog.indexOf('data-testid="popular-connectors"')).toBeLessThan(catalog.indexOf('data-testid="more-connectors"'));
    expect(catalog).toContain("{MORE_CONNECTORS_TEASER}");
    expect(catalog).toContain("Chat\n          </a>");
    expect(catalog).toContain("Manage\n          </button>");
    expect(catalog).toContain("Uninstall\n              </button>");
  });

  test("the configured page reuses the admin screen in its configured view", () => {
    const page = readDashboardFile("(admin)/mcp-connections/configured/page.tsx");
    const screen = readDashboardFile("_components/mcp-connections-screen.tsx");

    expect(page).toContain('<McpConnectionsScreen view="configured" />');
    expect(screen).toContain('title={configuredView ? "Configured connectors" : "Connectors"}');
    expect(screen).toContain('data-testid="configured-add-connector"');
    expect(screen).toContain("chat-mcp-connection-");
  });

  test("one-click OAuth presets are added for everyone and open the authorization tab in the same gesture", () => {
    const screen = readDashboardFile("_components/mcp-connections-screen.tsx");
    const oneClick = screen.slice(screen.indexOf("async function handleOneClickAdd"), screen.indexOf("async function handleUpdate"));

    expect(oneClick).toContain('credentialMode: "per_member"');
    expect(oneClick).toContain("{ startOAuth: true }");
    expect(screen).toContain('if (effort === "one_click") {');
  });
});
