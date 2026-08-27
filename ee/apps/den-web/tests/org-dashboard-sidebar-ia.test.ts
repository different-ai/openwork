import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const shell = readFileSync(
  fileURLToPath(new URL("../app/(den)/dashboard/_components/org-dashboard-shell.tsx", import.meta.url)),
  "utf8",
);
const legacyRunsPage = readFileSync(
  fileURLToPath(new URL("../app/(den)/dashboard/(admin)/script-runs/page.tsx", import.meta.url)),
  "utf8",
);

function indexOfNeedle(needle: string) {
  const index = shell.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  return index;
}

describe("Den org sidebar information architecture", () => {
  test("members get Work labels and never see Collections or Workflow Runs as member destinations", () => {
    expect(shell).toContain('label: "My Library"');
    expect(shell).toContain('label: "My Automations"');
    expect(shell).toContain('label: "OpenWork Web"');
    expect(shell).toContain('label: "Work"');
    expect(shell).not.toContain('label: "Your Connections"');
    expect(shell).not.toContain('label: "Extensions"');
    expect(shell).not.toContain('label: "Script runs"');
    expect(shell).toContain("access.isAdmin && activeOrg");
    expect(shell).toContain("manageItems.length > 0");
    expect(shell).toContain("observabilityItems.length > 0");
    expect(shell).toContain("const showWeb = runtimeConfigLoaded\n    && orgContext?.capabilities.openworkWeb === true");
    expect(shell).not.toMatch(/const showWeb =[\s\S]{0,160}runtimeConfig\.orgMode/);
    expect(shell).toContain("orgContext?.capabilities.openworkWeb === true");
    expect(shell).not.toContain("orgContext?.capabilities.cloud");
    expect(shell).not.toMatch(/label: "OpenWork Web"[\s\S]{0,120}badge:/);
  });

  test("admins see Manage then Observability then Team, with Models as a Providers category", () => {
    const marketplace = indexOfNeedle('label: "Collections"');
    const pluginDirectory = indexOfNeedle('label: "Plugin Directory"');
    const connectors = indexOfNeedle('label: "Connectors"');
    const sources = indexOfNeedle('label: "Sources"');
    const managedDashboards = indexOfNeedle('label: "Dashboards"');
    const workflowRuns = indexOfNeedle('label: "Workflow Runs"');
    const analytics = indexOfNeedle('label: "Analytics"');
    const workSection = indexOfNeedle('{ label: "Work", items: workItems }');
    const manageSection = indexOfNeedle('{ label: "Manage", items: manageItems }');
    const observabilitySection = indexOfNeedle('{ label: "Observability", items: observabilityItems }');
    const teamSection = indexOfNeedle('{ label: "Team", items: teamItems }');

    expect(marketplace).toBeLessThan(pluginDirectory);
    expect(pluginDirectory).toBeLessThan(connectors);
    expect(connectors).toBeLessThan(sources);
    expect(sources).toBeLessThan(managedDashboards);
    expect(workflowRuns).toBeLessThan(analytics);
    expect(workSection).toBeLessThan(manageSection);
    expect(manageSection).toBeLessThan(observabilitySection);
    expect(observabilitySection).toBeLessThan(teamSection);
    expect(shell).toContain('badge: "Providers"');
    expect(shell).toContain('badge: "MCPs"');
    expect(shell).toContain('label: "Tool Tester"');
    expect(shell).toContain("mcpConnectionsEnabled && access.isAdmin");
  });

  test("redirects the old Script runs path to Workflow runs", () => {
    expect(legacyRunsPage).toContain('redirect("/dashboard/workflow-runs")');
  });
});
