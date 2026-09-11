import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { type DenOrgCapabilities, getOrgAccessFlags } from "../app/(den)/_lib/den-org";
import type { getGatewayDashboardAccess } from "../app/(den)/dashboard/_lib/gateway-dashboard-access";
import {
  buildDashboardNavSections,
  flattenNavigationForSearch,
} from "../app/(den)/dashboard/_lib/dashboard-navigation";

const shell = readFileSync(
  fileURLToPath(new URL("../app/(den)/dashboard/_components/org-dashboard-shell.tsx", import.meta.url)),
  "utf8",
);
const searchBar = readFileSync(
  fileURLToPath(new URL("../app/(den)/dashboard/_components/command-palette/den-search-bar.tsx", import.meta.url)),
  "utf8",
);

const baseCapabilities: DenOrgCapabilities = {
  gatewayDashboard: false,
  cloud: true,
  installLinks: true,
  mcpConnections: true,
  openworkWeb: true,
  orgManagedDashboards: true,
  workflows: false,
};

function buildFor(
  role: "member" | "admin",
  capabilities = baseCapabilities,
  gatewayAccess: ReturnType<typeof getGatewayDashboardAccess> = capabilities.gatewayDashboard ? "unavailable" : "denied",
  orgMode: "multi_org" | "single_org" = "multi_org",
  runtimeConfigLoaded = true,
) {
  return buildDashboardNavSections({
    orgSlug: "example",
    access: getOrgAccessFlags(role, false),
    capabilities,
    gatewayAccess,
    orgMode,
    runtimeConfigLoaded,
  });
}

describe("dashboard navigation index", () => {
  test.each([false, true])("Gateway opt-in %s without deployment support changes only Gateway navigation and search", (gatewayDashboard) => {
    const sections = buildFor("admin", { ...baseCapabilities, gatewayDashboard });
    const models = sections.flatMap((section) => section.items).find((item) => item.label === "Models");
    expect(models?.children?.some((child) => child.label === "Gateway")).toBe(gatewayDashboard);
    const search = flattenNavigationForSearch(sections);
    expect(search.some((entry) => entry.href === "/dashboard/gateway-providers")).toBe(gatewayDashboard);
    expect(search.some((entry) => entry.label === "Models › OpenWork Models")).toBe(true);
    expect(search.some((entry) => entry.label === "Models › Bring Your Own Keys (Legacy)")).toBe(true);
    expect(flattenNavigationForSearch(buildFor("member", { ...baseCapabilities, gatewayDashboard }))
      .some((entry) => entry.href === "/dashboard/gateway-providers")).toBe(false);
  });

  test.each(["checking", "denied", "unavailable", "enabled"] satisfies ReturnType<typeof getGatewayDashboardAccess>[])("Models navigation and search respect %s access without hiding BYOK or billing/keys", (gatewayAccess) => {
    const sections = buildFor("admin", { ...baseCapabilities, gatewayDashboard: true }, gatewayAccess);
    const entries = flattenNavigationForSearch(sections);
    const hrefs = entries.map((entry) => entry.href);
    expect(hrefs.includes("/dashboard/gateway-providers")).toBe(gatewayAccess === "enabled" || gatewayAccess === "unavailable");
    expect(hrefs.includes("/dashboard/inference")).toBe(gatewayAccess === "denied" || gatewayAccess === "unavailable");
    for (const href of ["/dashboard/custom-llm-providers", "/dashboard/billing", "/dashboard/api-keys"]) expect(hrefs).toContain(href);
    if (gatewayAccess === "enabled" || gatewayAccess === "checking") {
      expect(sections.flatMap((section) => section.items).some((item) => item.href === "/dashboard/inference")).toBe(false);
    }
  });

  test("Models stays hidden for self-hosted or unresolved runtime config; members never receive either admin page", () => {
    for (const sections of [
      buildFor("admin", baseCapabilities, "denied", "single_org"),
      buildFor("admin", baseCapabilities, "denied", "multi_org", false),
      buildFor("member", { ...baseCapabilities, gatewayDashboard: true }, "enabled"),
    ]) {
      expect(flattenNavigationForSearch(sections).some((entry) => entry.href === "/dashboard/inference")).toBe(false);
    }
    expect(flattenNavigationForSearch(buildFor("member", { ...baseCapabilities, gatewayDashboard: true }, "unavailable"))
      .some((entry) => entry.href === "/dashboard/gateway-providers")).toBe(false);
  });

  test("keeps members in Work while admins receive Manage, Observability, and Team", () => {
    expect(buildFor("member").map((section) => section.label)).toEqual(["Work"]);
    expect(buildFor("admin").map((section) => section.label)).toEqual([
      "Work",
      "Manage",
      "Observability",
      "Team",
    ]);
  });

  test("keeps workflow analytics inside the Analytics destination", () => {
    const withoutWorkflows = buildFor("admin").flatMap((section) => section.items);
    const withWorkflows = buildFor("admin", { ...baseCapabilities, workflows: true })
      .flatMap((section) => section.items);

    expect(withoutWorkflows.some((item) => item.label === "Workflow Runs")).toBe(false);
    expect(withWorkflows.some((item) => item.label === "Workflow Runs")).toBe(false);
    expect(withWorkflows.some((item) => item.label === "Analytics")).toBe(true);
  });

  test("flattens grouped pages with their plain-language search keywords", () => {
    const billing = flattenNavigationForSearch(buildFor("admin"))
      .find((item) => item.label === "Settings › Billing");

    expect(billing?.href).toBe("/dashboard/billing");
    expect(billing?.keywords).toContain("plan");
    expect(billing?.keywords).toContain("invoice");
    expect(billing?.keywords).toContain("payment");
  });

  test("makes the navigation builder the shell source of truth and mounts the search trigger", () => {
    expect(shell).toContain("buildDashboardNavSections");
    expect(shell).not.toContain("const workItems");
    expect(shell).toContain("<DenSearchBar");
    expect(searchBar).toContain('data-testid="den-command-palette-trigger"');
  });
});
