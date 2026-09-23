import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { type DenOrgCapabilities, getOrgAccessFlags, getToolTesterRoute } from "../app/(den)/_lib/den-org";
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
  orgMode: "multi_org" | "single_org" = "multi_org",
  runtimeConfigLoaded = true,
) {
  return buildDashboardNavSections({
    orgSlug: "example",
    access: getOrgAccessFlags(role, false),
    capabilities,
    orgMode,
    runtimeConfigLoaded,
  });
}

describe("dashboard navigation index", () => {
  test("keeps canonical navigation without the removed Gateway link", () => {
    const sections = buildFor("admin");
    const models = sections.flatMap((section) => section.items).find((item) => item.label === "AI Gateway");
    expect(models?.href).toBe("/dashboard/ai-gateway");
    expect(models?.children).toBeUndefined();
    const search = flattenNavigationForSearch(sections);
    expect(search.some((entry) => entry.href.startsWith("/dashboard/gateway-providers"))).toBe(false);
    expect(search.some((entry) => entry.label === "AI Gateway › OpenWork Models")).toBe(false);
    expect(search.some((entry) => entry.label === "AI Gateway › Bring Your Own Keys (Legacy)")).toBe(false);
    expect(search.find((entry) => entry.label === "AI Gateway")?.href).toBe("/dashboard/ai-gateway");
    expect(flattenNavigationForSearch(buildFor("member"))
      .some((entry) => entry.href === "/dashboard/gateway-providers")).toBe(false);
  });

  test("AI Gateway remains a top-level admin item without hiding billing/keys", () => {
    const sections = buildFor("admin");
    const entries = flattenNavigationForSearch(sections);
    const hrefs = entries.map((entry) => entry.href);
    expect(hrefs.some((href) => href.startsWith("/dashboard/gateway-providers"))).toBe(false);
    expect(hrefs.includes("/dashboard/inference")).toBe(false);
    for (const href of ["/dashboard/ai-gateway", "/dashboard/billing", "/dashboard/api-keys"]) expect(hrefs).toContain(href);
    expect(hrefs).not.toContain("/dashboard/custom-llm-providers");
    const models = sections.flatMap((section) => section.items).find((item) => item.label === "AI Gateway");
    expect(models?.href).toBe("/dashboard/ai-gateway");
    expect(models?.children).toBeUndefined();
    expect(models?.badge).toBe("Models");
  });

  test("hosted admins have one normal AI Gateway navigation item without children", () => {
    const sections = buildFor("admin");
    const models = sections.flatMap((section) => section.items).find((item) => item.label === "AI Gateway");
    expect(models?.children).toBeUndefined();
    const search = flattenNavigationForSearch(sections);
    expect(search.find((entry) => entry.label === "AI Gateway › Old Gateway")).toBeUndefined();
    expect(models?.href).toBe("/dashboard/ai-gateway");
    expect(search.find((entry) => entry.label === "AI Gateway › OpenWork Models")).toBeUndefined();
    expect(shell).not.toContain("getInferenceRoute");
  });

  test("no duplicate Models child appears before runtime config or on single-org deployments", () => {
    for (const sections of [
      buildFor("admin", baseCapabilities, "single_org"),
      buildFor("admin", baseCapabilities, "multi_org", false),
    ]) {
      const models = sections.flatMap((section) => section.items).find((item) => item.label === "AI Gateway");
      expect(models?.href).toBe("/dashboard/ai-gateway");
      expect(models?.children).toBeUndefined();
      expect(flattenNavigationForSearch(sections).some((entry) => entry.href === "/dashboard/inference")).toBe(false);
    }
  });

  test("members never receive AI Gateway, Old Gateway or OpenWork Models navigation", () => {
    const sections = buildFor("member");
    expect(sections.flatMap((section) => section.items).some((item) => item.label === "AI Gateway")).toBe(false);
    expect(flattenNavigationForSearch(sections).some((entry) => ["/dashboard/ai-gateway", "/dashboard/inference", "/dashboard/gateway-providers"].includes(entry.href))).toBe(false);
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

  test.each([
    { role: "owner", isOwner: false, allowed: true },
    { role: "member", isOwner: true, allowed: true },
    { role: "super-admin", isOwner: false, allowed: true },
    { role: "admin", isOwner: false, allowed: true },
    { role: "admin, qa-reviewer", isOwner: false, allowed: true },
    { role: "member", isOwner: false, allowed: false },
    { role: "qa-reviewer", isOwner: false, allowed: false },
  ])("Tool Tester is only a Settings child for $role (owner=$isOwner) with MCP support", ({ role, isOwner, allowed }) => {
    const access = getOrgAccessFlags(role, isOwner, [{
      id: "custom-role", role: "qa-reviewer", permission: { organization: ["update"] },
      builtIn: false, protected: false, createdAt: null, updatedAt: null,
    }]);
    for (const orgSlug of ["example", null]) {
      for (const mcpConnections of [true, false]) {
        for (const orgMode of ["multi_org", "single_org"] satisfies ("multi_org" | "single_org")[]) {
          for (const runtimeConfigLoaded of [true, false]) {
            const sections = buildDashboardNavSections({
              orgSlug, access, capabilities: { ...baseCapabilities, mcpConnections },
              orgMode, runtimeConfigLoaded,
            });
            const visible = allowed && mcpConnections && orgSlug !== null;
            const items = sections.flatMap((section) => section.items);
            const settings = items.find((item) => item.label === "Settings");
            expect(items.some((item) => item.label === "Tool Tester")).toBe(false);
            expect(settings?.children?.filter((child) => child.label === "Tool Tester") ?? []).toEqual(
              visible ? [{ href: "/dashboard/tool-tester", label: "Tool Tester" }] : [],
            );
            if (settings) expect(settings.href).toBe("/dashboard/org-settings");
            const search = flattenNavigationForSearch(sections).filter((entry) => entry.href === "/dashboard/tool-tester");
            expect(search).toHaveLength(visible ? 1 : 0);
            if (visible) {
              expect(search[0].label).toBe("Settings › Tool Tester");
              expect(search[0].section).toBe("Team");
              expect(search[0].keywords).toEqual(expect.arrayContaining(["tools", "test", "mcp"]));
            }
          }
        }
      }
    }
  });

  test("keeps the existing Tool Tester URL for direct links and active-organization navigation", () => {
    expect(getToolTesterRoute()).toBe("/dashboard/tool-tester");
    expect(getToolTesterRoute("example")).toBe("/dashboard/tool-tester");
    expect(getToolTesterRoute("another-workspace")).toBe("/dashboard/tool-tester");
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
