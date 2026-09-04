import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

function readDashboardComponent(name: string) {
  return readFileSync(
    fileURLToPath(new URL(`../app/(den)/dashboard/_components/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("connector and marketplace polish", () => {
  test("keeps Plugin Directory before Connectors and removes the Sources sidebar item", () => {
    const shell = readDashboardComponent("org-dashboard-shell.tsx");
    const pluginsIndex = shell.indexOf('getPluginsRoute(activeOrg.slug),\n          label: "Plugin Directory"');
    const connectorsIndex = shell.indexOf('getMcpConnectionsRoute(activeOrg.slug),\n          label: "Connectors"');

    expect(pluginsIndex).toBeGreaterThan(-1);
    expect(pluginsIndex).toBeLessThan(connectorsIndex);
    expect(shell).toContain('badge: "MCPs"');
    expect(shell).not.toContain('label: "Sources"');
    expect(shell).not.toContain('badge: "Alpha"');
  });

  test("renders Sources as the last Plugin Directory tab", () => {
    const integrationsScreen = readDashboardComponent("integrations-screen.tsx");
    const pluginsScreen = readDashboardComponent("plugins-screen.tsx");

    expect(integrationsScreen).toContain("export function IntegrationsPanel()");
    expect(integrationsScreen).not.toContain("DashboardPageTemplate");
    expect(pluginsScreen).toContain('label: "Sources"');
    expect(pluginsScreen).toContain('searchParams.get("view")');
  });

  test("uses the smart connector bar and the approved connector copy", () => {
    const screen = readDashboardComponent("mcp-connections-screen.tsx");

    expect(screen).toContain('title="Connectors"');
    expect(screen).not.toContain("badgeLabel");
    expect(screen).toContain('description="Connectors is where you can add MCP servers that your whole team can use."');
    expect(screen).toContain('data-testid="connector-smart-bar"');
    expect(screen).not.toMatch(/>\s*Add MCP\s*</);
    expect(screen).not.toContain("<ImportPluginConnectionDialog");
  });

  test("adds plugins from a marketplace and carries that marketplace into the editor", () => {
    const detail = readDashboardComponent("marketplace-detail-screen.tsx");
    const editor = readDashboardComponent("plugin-editor-screen.tsx");

    expect(detail).toContain("Add a plugin");
    expect(detail).toContain("?marketplaceId=${encodeURIComponent(marketplace.id)}");
    expect(editor).toContain('searchParams.get("marketplaceId")');
  });

  test("reuses Quick add on the admin dashboard and opens the selected connector flow", () => {
    const home = readDashboardComponent("dashboard-home-screen.tsx");
    const overview = readDashboardComponent("dashboard-overview-screen.tsx");
    const connectorScreen = readDashboardComponent("mcp-connections-screen.tsx");

    expect(home).toContain("return access.isAdmin ? <DashboardOverviewScreen /> : <MemberDashboardScreen />");
    expect(overview).toContain("<ConnectorQuickAddGrid");
    expect(overview).toContain("?quickAdd=${encodeURIComponent(id)}");
    expect(connectorScreen).toContain('searchParams.get("quickAdd")');
  });
});
