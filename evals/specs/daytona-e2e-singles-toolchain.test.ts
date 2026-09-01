import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { listSinglesTests } from "../scripts/list-singles-tests.mjs";

const profilePath = fileURLToPath(
  new URL("./daytona-e2e-regression-profile.json", import.meta.url),
);
const specsDirectory = new URL("./", import.meta.url);
const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/daytona-e2e-singles.yml", import.meta.url),
);
const alertsWorkflowPath = fileURLToPath(
  new URL("../../.github/workflows/e2e-test-failure-alerts.yml", import.meta.url),
);

const SINGLES_CATEGORIES = new Set(["fresh-den-url", "fault-proxy"]);
const DISALLOWED_CATEGORIES = new Set([
  "per-test-den-env",
  "local-bun-world",
  "raw-or-local-placement",
  "unavailable-secret-or-docker",
]);
const DENIED_TEST = "capability-search-latency.e2e.test.ts";

type ProfileEntry = {
  test: string;
  category: string;
};

function profileEntries(value: unknown): ProfileEntry[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("profile must be an object");
  }
  const excluded = Reflect.get(value, "excluded");
  if (!Array.isArray(excluded)) throw new Error("profile excluded must be an array");

  return excluded.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`profile excluded[${index}] must be an object`);
    }
    const profileTest = Reflect.get(entry, "test");
    const category = Reflect.get(entry, "category");
    if (typeof profileTest !== "string" || typeof category !== "string") {
      throw new Error(`profile excluded[${index}] must have test and category strings`);
    }
    return { test: profileTest, category };
  });
}

test("the singles selection is exactly the standalone-runnable excluded categories", async ({ evidence }) => {
  const [selected, profileSource] = await Promise.all([
    listSinglesTests(),
    readFile(profilePath, "utf8"),
  ]);
  const profile: unknown = JSON.parse(profileSource);
  const entries = profileEntries(profile);
  const expected = entries
    .filter(({ category, test: profileTest }) => SINGLES_CATEGORIES.has(category) && profileTest !== DENIED_TEST)
    .map(({ test: profileTest }) => profileTest);

  expect(new Set(selected)).toEqual(new Set(expected));
  expect(selected).toHaveLength(expected.length);
  await Promise.all(selected.map((selectedTest) => access(new URL(selectedTest, specsDirectory))));

  const selectedEntries = entries.filter(({ test: profileTest }) => selected.includes(profileTest));
  expect(selectedEntries).toHaveLength(selected.length);
  expect(selectedEntries.every(({ category }) => SINGLES_CATEGORIES.has(category))).toBe(true);
  expect(selectedEntries.some(({ category }) => DISALLOWED_CATEGORIES.has(category))).toBe(false);
  expect(selected).not.toContain(DENIED_TEST);

  evidence.recordAssertionEvidence(
    "The singles selector contains exactly the standalone-runnable profile exclusions",
    "Selection equals the fresh-den-url and fault-proxy profile entries after the explicit local-placement denial; every selected spec exists and no incompatible category enters the lane.",
    true,
  );
});

test("the singles workflow runs one spec per vitest invocation on a bi-daily schedule", async ({ evidence }) => {
  const workflow = await readFile(workflowPath, "utf8");
  const vitestInvocations = workflow
    .split("\n")
    .filter((line) => line.includes("pnpm --dir evals exec vitest run"));

  expect(workflow).toContain('cron: "30 6,18 * * *"');
  expect(workflow).toContain("node evals/scripts/list-singles-tests.mjs");
  expect(vitestInvocations).toHaveLength(1);
  expect(vitestInvocations[0]).toContain('--project e2e "specs/${MATRIX_TEST}"');
  expect(vitestInvocations[0]).not.toMatch(/\*|\[@\]|TESTS_JSON|mapfile/);
  expect(workflow).toMatch(
    /elif grep -Eq "Tests\[\[:space:\]\]\.\*skipped"[^\n]*; then\n\s+result="failed"/,
  );
  expect(workflow).toContain("environment: scheduled-e2e-singles");
  expect(workflow).not.toContain("pr-slow-specs");

  evidence.recordAssertionEvidence(
    "The scheduled singles workflow preserves per-spec topology isolation",
    "The twice-daily lane derives its matrix from the selector, invokes Vitest once with one matrix file, fails skips, uses its dedicated environment, and never reuses the batched regression environment.",
    true,
  );
});

test("singles failures alert developers", async ({ evidence }) => {
  const alertsWorkflow = await readFile(alertsWorkflowPath, "utf8");

  expect(alertsWorkflow).toContain("      - Daytona E2E Singles");
  expect(alertsWorkflow).toContain(
    '"Daytona E2E Singles") issue_title="Daytona E2E singles lane failed" ;;',
  );

  evidence.recordAssertionEvidence(
    "Daytona E2E singles failures reach the developer alert workflow",
    "The failure-alert trigger watches the singles workflow and maps it to the dedicated Daytona E2E singles lane issue title.",
    true,
  );
});
