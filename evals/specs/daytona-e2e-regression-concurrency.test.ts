import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/daytona-e2e-regression-suite.yml", import.meta.url),
);
const specsPath = fileURLToPath(new URL("./", import.meta.url));
const profilePath = fileURLToPath(new URL("./daytona-e2e-regression-profile.json", import.meta.url));
const rawDesktopScriptPath = fileURLToPath(
  new URL("../scripts/list-daytona-raw-desktop-tests.mjs", import.meta.url),
);
const execFileAsync = promisify(execFile);
const allowedCategories = new Set([
  "per-test-den-env",
  "fresh-den-url",
  "fault-proxy",
  "local-bun-world",
  "unavailable-secret-or-docker",
  "raw-or-local-placement",
]);
const productFailuresThatMustRemainEligible = [
  "active-session-workspace-storm.e2e.test.ts",
  "composer-model-picker-no-subscribe-promo.e2e.test.ts",
  "responsive-session-layout.e2e.test.ts",
];
const dedicatedWorkflowTests = ["org-team-lifecycle-critical-path.e2e.test.ts"];

interface ProfileEntry {
  test: string;
  category: string;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProfile(value: unknown): { version: number; lane: string; excluded: ProfileEntry[] } {
  if (!isRecord(value) || value.version !== 2 || value.lane !== "daytona-ci" || !Array.isArray(value.excluded)) {
    throw new Error("The Daytona E2E regression profile has an invalid envelope.");
  }
  const excluded = value.excluded.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.test !== "string"
      || typeof entry.category !== "string"
      || typeof entry.reason !== "string"
    ) {
      throw new Error(`Invalid Daytona E2E regression exclusion: ${JSON.stringify(entry)}`);
    }
    return { test: entry.test, category: entry.category, reason: entry.reason };
  });
  return { version: value.version, lane: value.lane, excluded };
}

async function regressionInventory(): Promise<{
  all: string[];
  rawDesktop: string[];
  profile: ProfileEntry[];
  eligible: string[];
}> {
  const all = (await readdir(specsPath)).filter((file) => file.endsWith(".e2e.test.ts")).sort();
  const rawDesktop: string[] = [];
  for (const file of all) {
    const source = await readFile(`${specsPath}/${file}`, "utf8");
    if (/import\s*\{[^}]*\bdesktop\b[^}]*\}\s*from\s*["']@openwork\/hosts["']/s.test(source)) {
      rawDesktop.push(file);
    }
  }
  const profile = readProfile(JSON.parse(await readFile(profilePath, "utf8"))).excluded;
  const excluded = new Set([...rawDesktop, ...profile.map((entry) => entry.test), ...dedicatedWorkflowTests]);
  return { all, rawDesktop, profile, eligible: all.filter((file) => !excluded.has(file)) };
}

test("Daytona E2E regression concurrency is isolated by pull request", async ({ evidence }) => {
  const workflow = await readFile(workflowPath, "utf8");

  expect(workflow).toContain(
    "group: daytona-e2e-regression-suite-${{ github.event.workflow_run.pull_requests[0].number || github.run_id }}",
  );
  expect(workflow).toContain("cancel-in-progress: true");
  expect(workflow).not.toContain("group: daytona-e2e-regression-suite\n");

  evidence.recordAssertionEvidence(
    "A waiting Daytona regression run cannot block unrelated pull requests",
    "The workflow uses a PR-scoped concurrency key, falls back to a unique manual-run key, and supersedes only an older run with the same key.",
    true,
  );
});

test("Daytona E2E regression profile excludes only audited shared-topology incompatibilities", async ({ evidence }) => {
  const inventory = await regressionInventory();
  const rawDesktopOutput = await execFileAsync(process.execPath, [rawDesktopScriptPath]);
  const scriptedRawDesktop = rawDesktopOutput.stdout.trim().split("\n").filter(Boolean);
  const profileTests = inventory.profile.map((entry) => entry.test);
  const categoryByTest = new Map(inventory.profile.map((entry) => [entry.test, entry.category]));

  expect(profileTests).toEqual([...profileTests].sort());
  expect(new Set(profileTests).size).toBe(profileTests.length);
  expect(inventory.profile.every((entry) => allowedCategories.has(entry.category) && entry.reason.length > 20)).toBe(true);
  expect(inventory.profile.every((entry) => inventory.all.includes(entry.test))).toBe(true);
  expect(profileTests.filter((file) => inventory.rawDesktop.includes(file))).toEqual([]);
  expect(scriptedRawDesktop).toEqual(inventory.rawDesktop);
  expect(categoryByTest.get("dashboard-deployment-gate.e2e.test.ts")).toBe("per-test-den-env");
  expect(categoryByTest.get("automation-desktop-lifecycle.e2e.test.ts")).toBe("per-test-den-env");
  expect(categoryByTest.get("automation-model-needs-attention.e2e.test.ts")).toBe("per-test-den-env");
  expect(categoryByTest.get("automation-proposal-model-resolution.e2e.test.ts")).toBe("per-test-den-env");
  expect(categoryByTest.get("automations-den-hosted.e2e.test.ts")).toBe("per-test-den-env");
  expect(categoryByTest.get("opencode-mcp-agent-oauth.e2e.test.ts")).toBe("fresh-den-url");
  expect(categoryByTest.get("library-advanced-refresh.e2e.test.ts")).toBe("fault-proxy");
  expect(categoryByTest.get("headless-world-lifecycle.e2e.test.ts")).toBe("local-bun-world");
  expect(categoryByTest.get("model-lands-mid-run.e2e.test.ts")).toBe("unavailable-secret-or-docker");
  expect(categoryByTest.get("connect-state-provenance.e2e.test.ts")).toBe("raw-or-local-placement");
  expect(categoryByTest.get("library-mcp-connect-error.e2e.test.ts")).toBe("raw-or-local-placement");
  expect(categoryByTest.get("local-managed-mcp-oauth.e2e.test.ts")).toBe("raw-or-local-placement");
  expect(categoryByTest.get("slack-style-mcp-connector.e2e.test.ts")).toBe("raw-or-local-placement");

  expect(inventory.all).toHaveLength(150);
  expect(inventory.rawDesktop).toHaveLength(55);
  expect(inventory.profile).toHaveLength(75);
  expect(inventory.eligible).toHaveLength(19);
  expect(inventory.rawDesktop).toContain("den-litellm-provider.e2e.test.ts");
  expect(inventory.eligible).not.toContain("org-team-lifecycle-critical-path.e2e.test.ts");
  expect(inventory.eligible).not.toContain("library-mcp-connect-error.e2e.test.ts");
  expect(inventory.eligible).not.toContain("local-managed-mcp-oauth.e2e.test.ts");
  expect(inventory.eligible).not.toContain("slack-style-mcp-connector.e2e.test.ts");
  expect(inventory.eligible).toEqual(expect.arrayContaining(productFailuresThatMustRemainEligible));

  evidence.recordAssertionEvidence(
    "The shared Daytona topology has a non-vacuous, audited E2E inventory",
    `${inventory.all.length} total files minus ${inventory.rawDesktop.length} raw desktop files, ${inventory.profile.length} non-overlapping profile exclusions, and ${dedicatedWorkflowTests.length} dedicated-workflow file leaves ${inventory.eligible.length} eligible files, including known product failures.`,
    true,
  );
});

test("Daytona E2E regression workflow fails skipped or empty matrices", async ({ evidence }) => {
  const workflow = await readFile(workflowPath, "utf8");

  expect(workflow).toContain("profile_excluded_json=\"$(jq -c '[.excluded[].test]' \"$profile\")\"");
  expect(workflow).toContain('raw_desktop="$(node evals/scripts/list-daytona-raw-desktop-tests.mjs)"');
  expect(workflow).toContain('dedicated_workflow_json=\'["org-team-lifecycle-critical-path.e2e.test.ts"]\'');
  expect(workflow).toContain("Inventory: $(echo \"$all_tests\" | jq 'length') total;");
  expect(workflow).not.toContain("OPENWORK_EVAL_CRITICAL_PATH_E2E_JOURNEY=1");
  expect(workflow).toContain('if [ "$result" != "passed" ]; then');
  expect(workflow).toContain("if: steps.run.outputs.result == 'passed'");
  expect(workflow).toContain('if [ "$E2E_RESULT" != "success" ]; then');
  expect(workflow).not.toContain('if [ "$result" = "failed" ]; then');
  expect(workflow).not.toContain('if [ "$E2E_RESULT" = "failure" ]; then');

  evidence.recordAssertionEvidence(
    "Skipped and empty Daytona matrices cannot report success",
    "The batch exits non-zero for every result except passed, deferred judging runs only after a passed batch, and the final verdict exits non-zero unless the matrix job succeeded.",
    true,
  );
});
