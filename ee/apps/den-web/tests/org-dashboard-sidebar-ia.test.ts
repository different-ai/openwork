import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const shell = readFileSync(
  fileURLToPath(new URL("../app/(den)/dashboard/_components/org-dashboard-shell.tsx", import.meta.url)),
  "utf8",
);
const navigation = readFileSync(
  fileURLToPath(new URL("../app/(den)/dashboard/_lib/dashboard-navigation.ts", import.meta.url)),
  "utf8",
);
const legacyRunsPage = readFileSync(
  fileURLToPath(new URL("../app/(den)/dashboard/(admin)/script-runs/page.tsx", import.meta.url)),
  "utf8",
);

function indexOfNeedle(needle: string) {
  const index = navigation.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  return index;
}

describe("Den org sidebar information architecture", () => {
  test("members get Work labels and never see Collections or Workflow Runs as member destinations", () => {
    expect(navigation).toContain('label: "My Library"');
    expect(navigation).toContain('label: "My Automations"');
    expect(navigation).toContain('label: "OpenWork Web"');
    expect(navigation).toContain('label: "Work"');
    expect(navigation).not.toContain('label: "Your Connections"');
    expect(navigation).not.toContain('label: "Extensions"');
    expect(navigation).not.toContain('label: "Script runs"');
    expect(navigation).toContain("access.isAdmin && orgSlug");
    expect(navigation).toContain("manageItems.length > 0");
    expect(navigation).toContain("observabilityItems.length > 0");
    expect(navigation).toContain("const showWeb = runtimeConfigLoaded && capabilities.openworkWeb;");
    expect(navigation).not.toMatch(/const showWeb =[\s\S]{0,160}orgMode/);
    expect(navigation).not.toContain("capabilities.cloud");
    expect(navigation).not.toMatch(/label: "OpenWork Web"[\s\S]{0,120}badge:/);
  });

  test("admins see the streamlined Manage section before Observability and Team", () => {
    const pluginDirectory = indexOfNeedle('label: "Plugin Directory"');
    const connectors = indexOfNeedle('label: "Connectors"');
    const toolTester = indexOfNeedle('label: "Tool Tester"');
    const managedDashboards = indexOfNeedle('label: "Dashboards"');
    const advanced = indexOfNeedle('label: "Advanced"');
    const workflowRuns = indexOfNeedle('label: "Workflow Runs"');
    const analytics = indexOfNeedle('label: "Analytics"');
    const workSection = indexOfNeedle('{ label: "Work", items: workItems }');
    const manageSection = indexOfNeedle('{ label: "Manage", items: manageItems }');
    const observabilitySection = indexOfNeedle('{ label: "Observability", items: observabilityItems }');
    const teamSection = indexOfNeedle('{ label: "Team", items: teamItems }');

    expect(pluginDirectory).toBeLessThan(connectors);
    expect(connectors).toBeLessThan(toolTester);
    expect(toolTester).toBeLessThan(managedDashboards);
    expect(managedDashboards).toBeLessThan(advanced);
    expect(workflowRuns).toBeLessThan(analytics);
    expect(workSection).toBeLessThan(manageSection);
    expect(manageSection).toBeLessThan(observabilitySection);
    expect(observabilitySection).toBeLessThan(teamSection);
    expect(navigation).toContain('badge: "Providers"');
    expect(navigation).toContain('badge: "MCPs"');
    expect(navigation).toContain("capabilities.mcpConnections && access.isAdmin");
    expect(navigation.slice(navigation.indexOf("const settingsChildren"), navigation.indexOf("const settingsGroup"))).not.toContain('label: "Tool Tester"');
    expect(navigation).toMatch(
      /matchHrefs:\s*\[\s*getDesktopPoliciesRoute\(orgSlug\),\s*getBrandAppearanceRoute\(orgSlug\),\s*\]/,
    );
    expect(navigation).not.toContain('label: "Collections"');
    expect(navigation).not.toContain('label: "Sources"');
    expect(navigation).not.toContain('label: "Brand appearance"');
    expect(navigation).not.toContain('label: "Desktop Policies"');
  });

  test("redirects the old Script runs path to Workflow runs", () => {
    expect(legacyRunsPage).toContain('redirect("/dashboard/workflow-runs")');
  });
});
