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
  test("labels Sources alpha and keeps Collections first with Connectors as MCPs", () => {
    const shell = readDashboardComponent("org-dashboard-shell.tsx");
    const marketplaceIndex = shell.indexOf('getMarketplacesRoute(activeOrg.slug),\n          label: "Collections"');
    const pluginsIndex = shell.indexOf('getPluginsRoute(activeOrg.slug),\n          label: "Plugin Directory"');
    const connectorsIndex = shell.indexOf('getMcpConnectionsRoute(activeOrg.slug),\n          label: "Connectors"');
    const sourcesIndex = shell.indexOf('getIntegrationsRoute(activeOrg.slug),\n          label: "Sources"');

    expect(marketplaceIndex).toBeGreaterThan(-1);
    expect(marketplaceIndex).toBeLessThan(pluginsIndex);
    expect(pluginsIndex).toBeLessThan(connectorsIndex);
    expect(connectorsIndex).toBeLessThan(sourcesIndex);
    expect(shell).toContain('badge: "MCPs"');
    expect(shell).toContain('badge: "Alpha"');
  });

  test("keeps the Sources page title free of maturity badges", () => {
    const screen = readDashboardComponent("integrations-screen.tsx");

    expect(screen).toContain('title="Sources"');
    expect(screen).not.toContain("badgeLabel");
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
