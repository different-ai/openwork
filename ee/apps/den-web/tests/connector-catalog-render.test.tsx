import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { ConnectorCatalog } from "../app/(den)/dashboard/_components/connector-catalog-list";
import type { ExternalMcpConnection, ExternalMcpPreset } from "../app/(den)/dashboard/_components/mcp-connections-data";

const PRESETS: ExternalMcpPreset[] = [
  { presetId: "github", displayName: "GitHub", description: "PRs", url: "https://api.githubcopilot.com/mcp/", authType: "oauth", requiresOAuthClient: true },
  { presetId: "notion", displayName: "Notion", description: "Docs", url: "https://mcp.notion.com/mcp", authType: "oauth" },
  { presetId: "slack", displayName: "Slack", description: "Chat", url: "https://mcp.slack.com/mcp", authType: "oauth", requiresOAuthClient: true },
  { presetId: "granola", displayName: "Granola", description: "Meeting notes", url: "https://mcp.granola.ai/mcp", authType: "oauth" },
  { presetId: "context7", displayName: "Context7", description: "Docs", url: "https://mcp.context7.com/mcp", authType: "none" },
];

const NOTION: ExternalMcpConnection = {
  id: "conn-notion",
  name: "Notion",
  url: "https://mcp.notion.com/mcp",
  authType: "oauth",
  credentialMode: "per_member",
  connected: true,
  connectedAt: null,
  updatedAt: null,
  connectedForMe: true,
  requiredBy: [],
  identityManagedBy: [],
  access: null,
};

const noop = () => {};

function render(overrides: Partial<Parameters<typeof ConnectorCatalog>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ConnectorCatalog, {
      connections: [NOTION],
      presets: PRESETS,
      filter: "",
      configuredHref: "/dashboard/mcp-connections/configured",
      configuredConnectionHref: (connectionId: string) => `/dashboard/mcp-connections/configured?connectionId=${connectionId}`,
      connectorHref: (connectorId: string) => `/dashboard/mcp-connections/${connectorId}`,
      onAddPopular: noop,
      onAddPreset: noop,
      onAddMicrosoft365: noop,
      onConnect: noop,
      onManage: noop,
      onRemove: noop,
      addingPresetId: null,
      connectingConnectionId: null,
      ...overrides,
    }),
  );
}

describe("ConnectorCatalog", () => {
  test("shows the configured strip, six popular rows, and the collapsed More teaser", () => {
    const markup = render();

    expect(markup.indexOf('data-testid="configured-connector-strip"')).toBeLessThan(markup.indexOf('data-testid="popular-connectors"'));
    expect(markup).toContain('href="/dashboard/mcp-connections/configured"');
    expect(markup).toContain('href="/dashboard/mcp-connections/configured?connectionId=conn-notion"');
    for (const id of ["gmail", "github", "google-drive", "google-calendar", "notion", "slack"]) {
      expect(markup).toContain(`data-testid="connector-row-${id}"`);
    }
    expect(markup).toContain("See Outlook Email, Granola, and more");
    expect(markup).not.toContain('data-testid="more-connectors"');
  });

  test("configured rows get the options menu while unconfigured rows keep the plus", () => {
    const markup = render();

    expect(markup).toContain('data-testid="connector-options-conn-notion"');
    expect(markup).not.toContain('data-testid="connector-add-notion"');
    expect(markup).toContain('data-testid="connector-add-github"');
    expect(markup).toContain('aria-label="Add GitHub"');
  });

  test("filtering opens the More section and hides the configured strip", () => {
    const markup = render({ filter: "gran" });

    expect(markup).not.toContain('data-testid="configured-connector-strip"');
    expect(markup).not.toContain('data-testid="popular-connectors"');
    expect(markup).toContain('data-testid="more-connectors"');
    expect(markup).toContain('data-testid="connector-row-granola"');
    expect(markup).not.toContain('data-testid="connector-row-context7"');
  });

  test("a filter with no matches says so", () => {
    expect(render({ filter: "zzzz" })).toContain("No connectors match");
  });

  test("every row opens its detail page: connection id when configured, catalog id otherwise", () => {
    const markup = render({ filter: "o" });

    expect(markup).toContain('href="/dashboard/mcp-connections/conn-notion"');
    expect(markup).toContain('data-testid="connector-open-notion"');
    expect(markup).toContain('href="/dashboard/mcp-connections/github"');
    expect(markup).toContain('href="/dashboard/mcp-connections/google-drive"');
    expect(markup).toContain('href="/dashboard/mcp-connections/microsoft-365"');
    expect(markup).toContain('href="/dashboard/mcp-connections/granola"');
    expect(markup).not.toContain('href="/dashboard/mcp-connections/notion"');
  });

  test("Gmail, Drive, and Calendar offer Connect while the org-wide Google client is published but this person has not signed in", () => {
    // The org-wide Google Workspace entry (org's own or OpenWork-provided client) as the usable list reports it.
    const googleWorkspace: ExternalMcpConnection = {
      id: "google-workspace",
      name: "Google Workspace",
      url: "https://workspace.google.com",
      authType: "oauth",
      credentialMode: "per_member",
      nativeProviderKey: "google-workspace",
      connected: false,
      connectedAt: null,
      updatedAt: null,
      connectedForMe: false,
      requiredBy: [],
      identityManagedBy: [],
      access: null,
    };
    const markup = render({ connections: [NOTION, googleWorkspace] });
    for (const id of ["gmail", "google-drive", "google-calendar"]) {
      expect(markup).toContain(`data-testid="connector-connect-${id}"`);
      expect(markup).not.toContain(`data-testid="connector-add-${id}"`);
    }
    // Still the options menu (Chat / Manage), never Uninstall for the org-wide Google entry.
    expect(markup).toContain('data-testid="connector-options-google-workspace"');
    // Already-connected rows keep just the menu.
    expect(markup).not.toContain('data-testid="connector-connect-notion"');

    const connected = render({ connections: [NOTION, { ...googleWorkspace, connected: true, connectedForMe: true }] });
    expect(connected).not.toContain('data-testid="connector-connect-gmail"');

    const busy = render({ connections: [NOTION, googleWorkspace], connectingConnectionId: "google-workspace" });
    expect(busy).toContain("animate-spin");
  });
});
