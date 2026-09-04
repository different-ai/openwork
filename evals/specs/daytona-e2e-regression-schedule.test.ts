import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/daytona-e2e-regression-suite.yml", import.meta.url),
);

test("the regression suite runs the full eligible suite bi-daily without manual approval", async ({ evidence }) => {
  const workflow = await readFile(workflowPath, "utf8");
  const wardenAuthorization = workflow.indexOf("- name: Authorize Warden-cleared pull request");
  const guardedPathCheck = workflow.indexOf("E2E regression withheld: PR changes trusted review machinery.");
  const setupBun = workflow.indexOf("- name: Setup Bun");
  const installDependencies = workflow.indexOf("- name: Install dependencies");

  expect(workflow).toContain('cron: "0 6,18 * * *"');
  expect(workflow).toContain(
    "id: authorize-scheduled\n        if: github.event_name == 'schedule'",
  );
  expect(workflow).toContain("steps.authorize-scheduled.outputs.authorized");
  expect(workflow).toContain("github.event_name == 'schedule'");
  expect(workflow).toContain(
    "environment: ${{ github.event_name == 'workflow_run' && 'pr-slow-specs' || 'scheduled-e2e-regression' }}",
  );
  expect(workflow).toContain(
    "uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2",
  );
  expect(workflow).toContain("bun-version: 1.3.14");
  expect(setupBun).toBeLessThan(installDependencies);
  expect(wardenAuthorization).toBeGreaterThan(-1);
  expect(guardedPathCheck).toBeGreaterThan(wardenAuthorization);

  evidence.recordAssertionEvidence(
    "The Daytona E2E regression suite runs the full eligible suite bi-daily without manual approval",
    "The workflow schedules 06:00 and 18:00 UTC runs, installs pinned Bun before dependencies, routes schedule and workflow_dispatch events to an unprotected environment, and preserves Warden, reviewer approval, and trusted-review-machinery guards for workflow_run pull requests.",
    true,
  );
});

test("PR-triggered selection intersects matched tests as basenames", async ({ evidence }) => {
  const workflow = await readFile(workflowPath, "utf8");
  const matchedAssignment = String.raw`matched_tests="$(git diff --name-only --diff-filter=ACMR "$BASE_SHA...$HEAD_SHA" | { grep -E '^evals/specs/[^/]+\.e2e\.test\.ts$' || true; } | sed 's#^evals/specs/##' | jq -Rsc 'split("\n") | map(select(length > 0))')"`;

  expect(workflow).toContain(matchedAssignment);
  expect(workflow).toContain("| sed 's#^evals/specs/##' \\");
  expect(workflow).not.toContain(["spec", "impact.mjs"].join("-"));

  evidence.recordAssertionEvidence(
    "PR-triggered Daytona E2E selection compares matched and eligible test basenames",
    "The workflow selects changed top-level E2E files with git diff and strips the evals/specs/ prefix before intersecting them with the basename inventory.",
    true,
  );
});
