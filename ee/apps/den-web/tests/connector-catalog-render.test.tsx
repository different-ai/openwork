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
      onManage: noop,
      onRemove: noop,
      addingPresetId: null,
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
    expect(markup).toContain("Browse all 9 integrations");
    expect(markup).not.toContain('data-testid="more-connectors"');
  });

  test("configured rows get the options menu while unconfigured rows explain the next step", () => {
    const markup = render();

    expect(markup).toContain('data-testid="connector-options-conn-notion"');
    expect(markup).not.toContain('data-testid="connector-add-notion"');
    expect(markup).toContain('data-testid="connector-add-github"');
    expect(markup).toContain('aria-label="Set up GitHub"');
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

  test("every row opens its detail page: stable catalog identity even when configured", () => {
    const markup = render({ filter: "o" });

    expect(markup).toContain('href="/dashboard/mcp-connections/notion"');
    expect(markup).toContain('data-testid="connector-open-notion"');
    expect(markup).toContain('href="/dashboard/mcp-connections/github"');
    expect(markup).toContain('href="/dashboard/mcp-connections/google-drive"');
    expect(markup).toContain('href="/dashboard/mcp-connections/microsoft-365"');
    expect(markup).toContain('href="/dashboard/mcp-connections/granola"');
    expect(markup).not.toContain('href="/dashboard/mcp-connections/conn-notion"');
  });
});
