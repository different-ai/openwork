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

  expect(workflow).toContain('cron: "0 6,18 * * *"');
  expect(workflow).toContain(
    "id: authorize-scheduled\n        if: github.event_name == 'schedule'",
  );
  expect(workflow).toContain("steps.authorize-scheduled.outputs.authorized");
  expect(workflow).toContain("github.event_name == 'schedule'");
  expect(workflow).toContain(
    "environment: ${{ github.event_name == 'schedule' && 'scheduled-e2e-regression' || 'pr-slow-specs' }}",
  );
  expect(wardenAuthorization).toBeGreaterThan(-1);
  expect(guardedPathCheck).toBeGreaterThan(wardenAuthorization);

  evidence.recordAssertionEvidence(
    "The Daytona E2E regression suite runs the full eligible suite bi-daily without manual approval",
    "The workflow schedules 06:00 and 18:00 UTC runs, authorizes and configures schedule events, routes them to an unprotected environment, and preserves Warden plus trusted-review-machinery guards for pull requests.",
    true,
  );
});

test("PR-triggered selection intersects matched tests as basenames", async ({ evidence }) => {
  const workflow = await readFile(workflowPath, "utf8");
  const rawMatchedAssignment =
    'matched_tests="$(node evals/scripts/spec-impact.mjs --base "$BASE_SHA" --head "$HEAD_SHA" --matched-tests)"';

  expect(workflow).toContain(
    'matched_tests="$(node evals/scripts/spec-impact.mjs --base "$BASE_SHA" --head "$HEAD_SHA" --matched-tests | jq -c \'map(sub("^evals/specs/"; ""))\')"',
  );
  expect(workflow).toContain("| sed 's#^evals/specs/##' \\");
  expect(workflow).not.toContain(rawMatchedAssignment);

  evidence.recordAssertionEvidence(
    "PR-triggered Daytona E2E selection compares matched and eligible test basenames",
    "The workflow strips the evals/specs/ prefix from spec-impact output before intersecting it with the basename inventory, and the former raw assignment is absent.",
    true,
  );
});
