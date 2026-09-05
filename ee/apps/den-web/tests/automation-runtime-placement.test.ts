import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("Automation runtime placement", () => {
  test("Den's My Automations is a monitor that routes management to the creating surface", () => {
    const screen = read("../app/(den)/dashboard/_components/automations-screen.tsx");

    expect(screen).toContain("Create and edit Cloud Automations in OpenWork Web; Desktop Automations are managed in the desktop app.");
    expect(screen).toContain("Open in OpenWork Web");
    expect(screen).toContain("Manage in OpenWork Web");
    expect(screen).toContain("Manage in OpenWork Desktop");
    for (const heading of ["Running now", "Needs attention", "Scheduled", "Paused"]) {
      expect(screen).toContain(`title: "${heading}"`);
    }
    expect(screen).not.toContain("New Automation");
    expect(screen).not.toContain("cloud-automation-form");
  });

  test("cancelling an in-flight run is the only Den control", () => {
    const screen = read("../app/(den)/dashboard/_components/automations-screen.tsx");
    const data = read("../app/(den)/dashboard/_components/automation-data.tsx");

    expect(screen).toContain("Cancel run");
    expect(data).toContain("export function useCancelAutomationRun");
    for (const removed of ["useCreateCloudAutomation", "useUpdateAutomation", "useSetAutomationState", "useRunAutomationNow", "useArchiveAutomation"]) {
      expect(data).not.toContain(removed);
      expect(screen).not.toContain(removed);
    }
    for (const control of [">Edit<", ">Run now<", ">Activate<", ">Deactivate<", ">Archive<", ">Save revision<", ">Create in Cloud<"]) {
      expect(screen).not.toContain(control);
    }
    expect(existsSync(fileURLToPath(new URL("../app/(den)/dashboard/_components/cloud-automation-form.tsx", import.meta.url)))).toBe(false);
  });

  test("Workflow → Automate deep-links into the OpenWork Web editor with the exact version pinned", () => {
    const detail = read("../app/(den)/dashboard/_components/workflow-detail-screen.tsx");

    expect(detail).toContain("Automate in OpenWork Web");
    expect(detail).toContain("/automations?create=1&workflow=${encodeURIComponent(workflowId)}&version=${encodeURIComponent(detail.script.currentVersion.id)}");
    expect(detail).not.toContain("href={`/dashboard/automations?workflow=");
  });
});
