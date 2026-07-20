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
  test("puts Marketplace first and renames the org connection surface to Connectors beta", () => {
    const shell = readDashboardComponent("org-dashboard-shell.tsx");
    const marketplaceIndex = shell.indexOf('{ href: getMarketplacesRoute(activeOrg.slug), label: "Marketplace" }');
    const sourcesIndex = shell.indexOf('{ href: getIntegrationsRoute(activeOrg.slug), label: "Sources" }');
    const pluginsIndex = shell.indexOf('{ href: getPluginsRoute(activeOrg.slug), label: "Plugins" }');
    const connectorsIndex = shell.indexOf('{ href: getMcpConnectionsRoute(activeOrg.slug), label: "Connectors", badge: "Beta" }');

    expect(marketplaceIndex).toBeGreaterThan(-1);
    expect(marketplaceIndex).toBeLessThan(sourcesIndex);
    expect(sourcesIndex).toBeLessThan(pluginsIndex);
    expect(pluginsIndex).toBeLessThan(connectorsIndex);
  });

  test("uses one Add MCP action and the approved connector copy", () => {
    const screen = readDashboardComponent("mcp-connections-screen.tsx");

    expect(screen).toContain('title="Connectors"');
    expect(screen).toContain('badgeLabel="Beta"');
    expect(screen).toContain('description="Connectors is where you can add MCP servers that your whole team can use."');
    expect(screen).toContain("Add MCP");
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
