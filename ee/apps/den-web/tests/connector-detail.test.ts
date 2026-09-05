import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  connectorAccountStatus,
  connectorDetailEffort,
  connectorDetailFacts,
  connectorDetailIdentity,
  connectorDetailPrimaryAction,
  resolveConnectorDetailSubject,
} from "../app/(den)/dashboard/_components/connector-detail";
import type { ExternalMcpConnection, ExternalMcpPreset } from "../app/(den)/dashboard/_components/mcp-connections-data";

const PRESETS: ExternalMcpPreset[] = [
  { presetId: "github", displayName: "GitHub", description: "PRs", url: "https://api.githubcopilot.com/mcp/", authType: "oauth", requiresOAuthClient: true },
  { presetId: "notion", displayName: "Notion", description: "Docs", url: "https://mcp.notion.com/mcp", authType: "oauth" },
  { presetId: "context7", displayName: "Context7", description: "Library docs", url: "https://mcp.context7.com/mcp", authType: "none" },
];

const NOTION: ExternalMcpConnection = {
  id: "conn-notion",
  name: "Notion",
  url: "https://mcp.notion.com/mcp/",
  authType: "oauth",
  credentialMode: "per_member",
  exposeDirectly: false,
  connected: true,
  connectedAt: "2026-09-02T10:00:00.000Z",
  createdByName: "Jalil",
  updatedAt: "2026-09-02T10:00:00.000Z",
  connectedForMe: true,
  requiredBy: [{ pluginId: "plg_1", name: "Research kit" }],
  identityManagedBy: [],
  access: { orgWide: true, memberIds: [], teamIds: [] },
};

const GOOGLE: ExternalMcpConnection = {
  id: "google-workspace",
  name: "Google Workspace",
  url: "https://www.googleapis.com/",
  authType: "oauth",
  credentialMode: "per_member",
  exposeDirectly: false,
  connected: false,
  connectedAt: null,
  updatedAt: null,
  connectedForMe: false,
  nativeProviderKey: "google-workspace",
  requiredBy: [],
  identityManagedBy: [],
  access: null,
};

const PLUGIN_OWNED: ExternalMcpConnection = {
  ...NOTION,
  id: "conn-plugin",
  name: "Team wiki",
  url: "https://wiki.example.com/mcp",
  requiredBy: [{ pluginId: "plg_wiki", name: "Wiki plugin" }],
  identityManagedBy: [{ pluginId: "plg_wiki", name: "Wiki plugin" }],
};

const context = { orgName: "Acme", pluginHref: (pluginId: string) => `/dashboard/plugins/${pluginId}` };

describe("resolveConnectorDetailSubject", () => {
  test("a connection id resolves to the connection with its catalog identity", () => {
    const subject = resolveConnectorDetailSubject("conn-notion", [NOTION], PRESETS);
    expect(subject.kind).toBe("connection");
    if (subject.kind !== "connection") return;
    expect(subject.preset?.presetId).toBe("notion");
    expect(subject.popular?.id).toBe("notion");
  });

  test("a popular id resolves to its configured connection when one exists, else stays a catalog entry", () => {
    const configured = resolveConnectorDetailSubject("notion", [NOTION], PRESETS);
    expect(configured.kind).toBe("connection");

    const unconfigured = resolveConnectorDetailSubject("notion", [], PRESETS);
    expect(unconfigured.kind).toBe("popular");
    if (unconfigured.kind === "popular") expect(unconfigured.preset?.presetId).toBe("notion");
  });

  test("Gmail keeps its own identity while the Google Workspace connection keeps Google's", () => {
    const gmail = resolveConnectorDetailSubject("gmail", [GOOGLE], PRESETS);
    expect(gmail.kind).toBe("connection");
    expect(connectorDetailIdentity(gmail).name).toBe("Gmail");

    const google = resolveConnectorDetailSubject("google-workspace", [GOOGLE], PRESETS);
    expect(google.kind).toBe("connection");
    expect(connectorDetailIdentity(google).name).toBe("Google Workspace");
  });

  test("a preset id outside the popular list resolves by URL and Microsoft 365 has a page before setup", () => {
    expect(resolveConnectorDetailSubject("context7", [], PRESETS).kind).toBe("preset");
    expect(resolveConnectorDetailSubject("microsoft-365", [], PRESETS).kind).toBe("microsoft-365");
    expect(resolveConnectorDetailSubject("nope", [NOTION], PRESETS)).toEqual({ kind: "not_found", connectorId: "nope" });
  });
});

describe("connector detail copy", () => {
  test("effort drives the primary action for unconfigured connectors", () => {
    expect(connectorDetailEffort(resolveConnectorDetailSubject("context7", [], PRESETS))).toBe("instant");
    expect(connectorDetailPrimaryAction("instant").label).toBe("Add");
    expect(connectorDetailEffort(resolveConnectorDetailSubject("notion", [], PRESETS))).toBe("one_click");
    expect(connectorDetailPrimaryAction("one_click").label).toBe("Connect");
    expect(connectorDetailEffort(resolveConnectorDetailSubject("github", [], PRESETS))).toBe("oauth_app");
    expect(connectorDetailPrimaryAction("oauth_app").label).toBe("Set up");
    expect(connectorDetailEffort(resolveConnectorDetailSubject("gmail", [], PRESETS))).toBe("guided");
    expect(connectorDetailEffort(resolveConnectorDetailSubject("conn-notion", [NOTION], PRESETS))).toBeNull();
  });

  test("information facts come from what the page already knows", () => {
    const facts = connectorDetailFacts(resolveConnectorDetailSubject("conn-notion", [NOTION], PRESETS), context);
    const byLabel = Object.fromEntries(facts.map((fact) => [fact.label, fact]));
    expect(byLabel.Provider).toMatchObject({ value: "notion.com", href: "https://notion.com" });
    expect(byLabel.Type.value).toBe("Remote MCP server");
    expect(byLabel.Server).toMatchObject({ value: "https://mcp.notion.com/mcp/", mono: true });
    expect(byLabel["Sign-in"].value).toBe("OAuth sign-in · each person connects their own account");
    expect(byLabel.Access.value).toBe("Everyone in Acme");
    expect(byLabel.Added.value).toContain("Added by Jalil");
    expect(byLabel["Required by"]).toMatchObject({ value: "Research kit", href: "/dashboard/plugins/plg_1" });
    expect(byLabel.Docs.href).toContain("shared-mcp-connections");
  });

  test("plugin-owned connections say so once, and native providers skip the server URL", () => {
    const pluginFacts = connectorDetailFacts(resolveConnectorDetailSubject("conn-plugin", [PLUGIN_OWNED], PRESETS), context);
    expect(pluginFacts.filter((fact) => fact.label === "Managed by")).toHaveLength(1);
    expect(pluginFacts.some((fact) => fact.label === "Required by")).toBe(false);
    expect(pluginFacts.find((fact) => fact.label === "Type")?.value).toBe("MCP server from a plugin");

    const googleFacts = connectorDetailFacts(resolveConnectorDetailSubject("gmail", [GOOGLE], PRESETS), context);
    expect(googleFacts.find((fact) => fact.label === "Provider")?.value).toBe("Google");
    expect(googleFacts.some((fact) => fact.label === "Server")).toBe(false);
    expect(googleFacts.find((fact) => fact.label === "Part of")?.value).toContain("Google Workspace");
  });
});

describe("connectors screen surface", () => {
  const root = join(import.meta.dir, "..", "app", "(den)", "dashboard");
  const screen = readFileSync(join(root, "_components", "mcp-connections-screen.tsx"), "utf8");

  test("leads with the flat page header instead of the gradient hero", () => {
    expect(screen).toContain("<DenPageHeader");
    expect(screen).not.toContain("DashboardPageTemplate");
    expect(screen).toContain('title={configuredView ? "Configured connectors" : "Connectors"}');
    expect(screen).toContain('data-testid="connectors-open-configured"');
  });

  test("has a detail view that composes the connection row, tools, and information", () => {
    expect(screen).toContain('export type McpConnectionsScreenView = "catalog" | "configured" | "detail";');
    for (const testId of [
      "connector-detail-back",
      "connector-detail",
      "connector-detail-state",
      "connector-detail-copy-link",
      "connector-detail-chat",
      "connector-detail-primary",
      "connector-detail-connection",
      "connector-detail-tools",
      "connector-detail-information",
      "connector-detail-not-found",
    ]) {
      expect(screen).toContain(`data-testid="${testId}"`);
    }
    expect(screen).toContain("router.push(getMcpConnectionRoute(orgSlug, connection.id));");
    expect(screen).toContain('connectorHref={(id) => getMcpConnectionRoute(orgSlug, id)}');
  });

  test("the detail route renders the screen in detail view", () => {
    const route = readFileSync(join(root, "(admin)", "mcp-connections", "[connectorId]", "page.tsx"), "utf8");
    expect(route).toContain('<McpConnectionsScreen view="detail" connectorId={connectorId} />');
  });
});


describe("connectorAccountStatus", () => {
  test("another member's authorization never makes this account connected", () => {
    expect(connectorAccountStatus({ ...NOTION, connected: true, connectedForMe: false })).toBe("Needs your account");
    expect(connectorAccountStatus(NOTION)).toBe("Connected as you");
    expect(connectorAccountStatus({ ...NOTION, credentialMode: "shared", connectedForMe: false })).toBe("Connected");
  });

  test("setup and credential recovery take precedence over old connected flags", () => {
    expect(connectorAccountStatus({ ...NOTION, setupRequired: true })).toBe("Setup required");
    expect(connectorAccountStatus({ ...NOTION, issuerReviewRequired: true })).toBe("OAuth settings need review");
    expect(connectorAccountStatus({ ...NOTION, credentialHealth: "reconnect_required" })).toBe("Reconnect required");
    expect(connectorAccountStatus({ ...NOTION, oauthClientRequired: true, oauthClientConfigured: false })).toBe("Setup required");
  });
});
