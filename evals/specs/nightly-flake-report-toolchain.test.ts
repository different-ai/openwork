import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/nightly-flake-report.yml", import.meta.url),
);

test("the nightly flake report installs Bun before running the PR lane", async ({ evidence }) => {
  const workflow = await readFile(workflowPath, "utf8");
  const setupBun = workflow.indexOf("- name: Setup Bun");
  const installDependencies = workflow.indexOf("- name: Install dependencies");
  const collectRuns = workflow.indexOf("- name: Collect pr-lane runs");

  expect(setupBun).toBeGreaterThan(-1);
  expect(workflow).toContain(
    "uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2",
  );
  expect(workflow).toContain("bun-version: 1.3.14");
  expect(setupBun).toBeLessThan(installDependencies);
  expect(installDependencies).toBeLessThan(collectRuns);

  evidence.recordAssertionEvidence(
    "Nightly PR-lane reliability runs have their required Bun runtime",
    "The workflow installs pinned Bun 1.3.14 before dependencies and before collecting any PR-lane run, preventing Bun-backed specs from being misreported as unreliable when the executable is absent.",
    true,
  );
});
