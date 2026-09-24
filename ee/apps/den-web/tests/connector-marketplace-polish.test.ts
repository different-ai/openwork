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
  test("keeps Plugins before Connectors and removes the Sources sidebar item", () => {
    const navigation = readFileSync(new URL("../app/(den)/dashboard/_lib/dashboard-navigation.ts", import.meta.url), "utf8");
    const pluginsIndex = navigation.indexOf('label: "Plugins"');
    const connectorsIndex = navigation.indexOf('label: "Connectors"');

    expect(pluginsIndex).toBeGreaterThan(-1);
    expect(pluginsIndex).toBeLessThan(connectorsIndex);
    expect(navigation).toContain('badge: "MCPs"');
    expect(navigation).not.toContain('label: "Sources"');
    expect(navigation).not.toContain('badge: "Alpha"');
  });

  test("renders Sources as the last Plugin Directory tab", () => {
    const integrationsScreen = readDashboardComponent("integrations-screen.tsx");
    const pluginsScreen = readDashboardComponent("plugins-screen.tsx");

    expect(integrationsScreen).toContain("export function IntegrationsPanel()");
    expect(integrationsScreen).not.toContain("DashboardPageTemplate");
    expect(pluginsScreen).toContain('label: "Sources"');
    expect(pluginsScreen).toContain('searchParams.get("view")');
  });

  test("adds connectors on the full-page catalog, with Add any MCP inline and no editor fallback", () => {
    const catalog = readDashboardComponent("connector-catalog-screen.tsx");
    const picker = readDashboardComponent("connector-picker.tsx");

    expect(catalog).toContain('data-testid="add-any-mcp"');
    expect(catalog).toContain('variant="secondary"');
    expect(catalog).not.toContain("Advanced setup");
    expect(catalog).not.toContain("addMcp");
    expect(catalog).not.toContain("quickAdd");
    expect(picker).toContain('"Filter by name, or paste an MCP URL"');
    expect(picker).toContain("No catalog connectors match this address.");
    expect(picker).toContain(">Add MCP</DenButton>");
  });

  test("adds plugins from a marketplace and carries that marketplace into the editor", () => {
    const detail = readDashboardComponent("marketplace-detail-screen.tsx");
    const editor = readDashboardComponent("plugin-editor-screen.tsx");

    expect(detail).toContain("Add a plugin");
    expect(detail).toContain("?marketplaceId=${encodeURIComponent(marketplace.id)}");
    expect(editor).toContain('searchParams.get("marketplaceId")');
  });

  test("reuses Quick add on the admin dashboard and opens the selected connector's setup page", () => {
    const home = readDashboardComponent("dashboard-home-screen.tsx");
    const overview = readDashboardComponent("dashboard-overview-screen.tsx");

    expect(home).toContain("return access.isAdmin ? <DashboardOverviewScreen /> : <MemberDashboardScreen />");
    expect(overview).toContain("<ConnectorQuickAddGrid");
    expect(overview).toContain("router.push(getAddConnectorRoute(activeOrg?.slug, id))");
    expect(overview).not.toContain("quickAdd=");
  });
});
