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
    expect(navigation).not.toContain('label: "Dashboard"');
    expect(navigation).toContain("const showWeb = runtimeConfigLoaded && capabilities.openworkWeb;");
    expect(navigation).not.toMatch(/const showWeb =[\s\S]{0,160}orgMode/);
    expect(navigation).not.toContain("capabilities.cloud");
    expect(navigation).not.toMatch(/label: "OpenWork Web"[\s\S]{0,120}badge:/);
  });

  test("admins see Manage before Team, with Advanced moved into Settings", () => {
    const plugins = indexOfNeedle('label: "Plugins"');
    const connectors = indexOfNeedle('label: "Connectors"');
    const managedDashboards = indexOfNeedle('label: "Dashboards"');
    const models = indexOfNeedle('label: "Models"');
    const desktopPolicies = indexOfNeedle('label: "Desktop policies"');
    const workSection = indexOfNeedle('{ label: "Work", items: workItems }');
    const manageSection = indexOfNeedle('{ label: "Manage", items: manageItems }');
    const teamSection = indexOfNeedle('{ label: "Team", items: teamItems }');

    expect(plugins).toBeLessThan(connectors);
    expect(connectors).toBeLessThan(managedDashboards);
    expect(managedDashboards).toBeLessThan(models);
    expect(models).toBeLessThan(desktopPolicies);
    expect(workSection).toBeLessThan(manageSection);
    expect(manageSection).toBeLessThan(teamSection);
    expect(navigation).not.toContain('label: "Observability"');
    expect(navigation).not.toContain('label: "Plugin Directory"');
    expect(navigation).not.toContain('label: "Workflow Runs"');
    expect(navigation).not.toContain('label: "Old Gateway"');
    expect(navigation).not.toContain("getGatewayProvidersRoute");
    expect(shell).not.toContain("getGatewayProvidersRoute");
    expect(shell).toContain('return "AI Gateway";');
    expect(navigation.slice(navigation.indexOf("const manageItems"), navigation.indexOf("const settingsChildren"))).not.toContain('label: "Tool Tester"');
    const settings = navigation.slice(navigation.indexOf("const settingsChildren"), navigation.indexOf("const settingsGroup"));
    expect(settings).toContain('label: "Tool Tester"');
    expect(settings).toContain('label: "Advanced"');
    expect(navigation).not.toContain('label: "Collections"');
    expect(navigation).not.toContain('label: "Sources"');
    expect(navigation).not.toContain('label: "Brand appearance"');
    expect(navigation).not.toContain('label: "Desktop Policies"');
  });

  test("redirects the old Script runs path to Workflow runs", () => {
    expect(legacyRunsPage).toContain('redirect(getWorkflowRunsRoute())');
  });
});
