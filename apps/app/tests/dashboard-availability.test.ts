import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (relative: string) =>
  readFileSync(join(import.meta.dir, "..", relative), "utf8");

describe("Dashboard availability", () => {
  test("fails closed unless fresh desktop config explicitly enables the deployment", () => {
    const availability = read("src/react-app/domains/dashboard/dashboard-availability.ts");
    const provider = read("src/react-app/domains/cloud/desktop-config-provider.tsx");
    expect(availability).toContain('freshConfigStatus === "pending"');
    expect(availability).toContain('freshConfigStatus === "ready"');
    expect(availability).toContain("config.dashboardEnabled === true");
    expect(availability).not.toContain("localStorage");
    expect(provider).toContain('if (denAuth.status === "checking")');
    expect(provider).toContain('freshConfigStatus: "pending"');
    expect(provider).toContain('freshConfigStatus: "ready"');
    expect(provider).toContain('freshConfigStatus: "failed"');
  });

  test("gates the route and sidebar without a local developer override", () => {
    const route = read("src/react-app/shell/session-route.tsx");
    const advanced = read("src/react-app/domains/settings/pages/advanced-view-sections.tsx");

    expect(route).toContain("useDashboardDeploymentAvailability()");
    expect(route).toContain("dashboardAvailabilityLoading || mcpAppsDashboardEnabled");
    expect(route).toContain("dashboardWorkspaceRoute ? \"dashboard\" : \"session\"");
    expect(route).toContain("mcpAppsDashboardEnabled && dashboardRouteRequested");
    expect(route).toContain("onOpenDashboard: mcpAppsDashboardEnabled");
    expect(advanced).not.toContain("MCP Apps dashboard");
    expect(advanced).not.toContain("setMcpAppsDashboardEnabled");
  });
});
