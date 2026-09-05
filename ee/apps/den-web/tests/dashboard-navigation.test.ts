import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { type DenOrgCapabilities, getOrgAccessFlags } from "../app/(den)/_lib/den-org";
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
  coworkerTeams: false,
  openworkWeb: true,
  orgManagedDashboards: true,
  workflows: false,
};

function buildFor(role: "member" | "admin", capabilities = baseCapabilities) {
  return buildDashboardNavSections({
    orgSlug: "example",
    access: getOrgAccessFlags(role, false),
    capabilities,
    orgMode: "multi_org",
    runtimeConfigLoaded: true,
  });
}

describe("dashboard navigation index", () => {
  test("keeps members in Work while admins receive Manage, Observability, and Team", () => {
    expect(buildFor("member").map((section) => section.label)).toEqual(["Work"]);
    expect(buildFor("admin").map((section) => section.label)).toEqual([
      "Work",
      "Manage",
      "Observability",
      "Team",
    ]);
  });

  test("gates Workflow Runs on the workflows capability", () => {
    const withoutWorkflows = buildFor("admin").flatMap((section) => section.items);
    const withWorkflows = buildFor("admin", { ...baseCapabilities, workflows: true })
      .flatMap((section) => section.items);

    expect(withoutWorkflows.some((item) => item.label === "Workflow Runs")).toBe(false);
    expect(withWorkflows.some((item) => item.label === "Workflow Runs")).toBe(true);
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
