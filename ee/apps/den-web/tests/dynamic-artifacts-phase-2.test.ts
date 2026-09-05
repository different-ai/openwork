import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("Workflow Artifact surfaces", () => {
  test("Den Web exposes the test-gated editable Script lifecycle", () => {
    const detail = read("../app/(den)/dashboard/_components/workflow-detail-panel.tsx");
    const plugin = read("../app/(den)/dashboard/_components/plugin-detail-screen.tsx");

    expect(plugin).toContain("WorkflowDetailPanel")
    expect(detail).toContain("matching successful test")
    expect(detail).toContain("setTested(null)")
    expect(detail).toContain("Save new version")
    expect(detail).toContain("Update Automation…")
    expect(detail).toContain("Audit facts will remain")
  });

  test("Den Web Automation detail reuses Preview, Data, and Lineage snapshots", () => {
    const screen = read("../app/(den)/dashboard/_components/automations-screen.tsx");
    const result = read("../app/(den)/dashboard/_components/workflow-artifact-result.tsx");
    const shell = read("../app/(den)/dashboard/_components/org-dashboard-shell.tsx");

    expect(shell).toContain("getAutomationsRoute")
    expect(screen).toContain("Latest validated result")
    expect(screen).toContain("WorkflowArtifactResult")
    expect(result).toContain('["preview", "data", "lineage"]')
    expect(result).toContain("Exact Workflow version")
    expect(result).toContain("OpenWork Cloud")
  });
});
