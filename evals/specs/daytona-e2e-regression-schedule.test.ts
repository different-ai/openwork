import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("PR-triggered selection falls back to the full eligible set when no eligible spec changed", async ({ evidence }) => {
  const workflow = await readFile(workflowPath, "utf8");
  const lines = workflow.split("\n");
  const stepIndex = lines.findIndex((line) => line.includes("- name: Build E2E test matrix"));
  const runIndex = lines.findIndex((line, index) => index > stepIndex && line.trim() === "run: |");
  const bodyLines: string[] = [];

  expect(stepIndex).toBeGreaterThan(-1);
  expect(runIndex).toBeGreaterThan(stepIndex);

  for (const line of lines.slice(runIndex + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    bodyLines.push(line.startsWith("          ") ? line.slice(10) : line);
  }

  const stepBody = bodyLines.join("\n");
  expect(stepBody.length).toBeGreaterThan(0);
  expect(stepBody).toContain("set -euo pipefail");

  const tempDir = mkdtempSync(join(tmpdir(), "e2e-matrix-"));
  const fixtureRepo = join(tempDir, "repo");
  const fixtureSpecs = join(fixtureRepo, "evals/specs");
  const fixtureScripts = join(fixtureRepo, "evals/scripts");
  mkdirSync(fixtureSpecs, { recursive: true });
  mkdirSync(fixtureScripts, { recursive: true });
  writeFileSync(join(fixtureSpecs, "alpha.e2e.test.ts"), "export const alpha = true;\n");
  writeFileSync(join(fixtureSpecs, "beta.e2e.test.ts"), "export const beta = true;\n");
  writeFileSync(join(fixtureSpecs, "excluded.e2e.test.ts"), "export const excluded = true;\n");
  writeFileSync(
    join(fixtureSpecs, "daytona-e2e-regression-profile.json"),
    JSON.stringify({ excluded: [{ test: "excluded.e2e.test.ts", reason: "fixture exclusion" }] }),
  );
  writeFileSync(
    join(fixtureScripts, "list-daytona-raw-desktop-tests.mjs"),
    await readFile(new URL("../scripts/list-daytona-raw-desktop-tests.mjs", import.meta.url)),
  );

  const git = (args: string[]): string => {
    const result = spawnSync("git", args, { cwd: fixtureRepo, encoding: "utf8" });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };

  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "-m", "base"]);
  const baseSha = git(["rev-parse", "HEAD"]);

  type MatrixBatch = { name: string; tests: string[] };
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
  const isMatrixBatches = (value: unknown): value is MatrixBatch[] =>
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        typeof entry.name === "string" &&
        "tests" in entry &&
        isStringArray(entry.tests),
    );

  const runPlan = ({
    eventName,
    baseSha: planBaseSha,
    headSha,
    only,
  }: {
    eventName: string;
    baseSha?: string;
    headSha?: string;
    only?: string;
  }): { batches: MatrixBatch[]; hasTests: string; summary: string } => {
    const scriptPath = join(tempDir, "matrix.sh");
    const summaryPath = join(tempDir, "summary.md");
    const outputPath = join(tempDir, "output.txt");
    writeFileSync(scriptPath, stepBody);
    writeFileSync(summaryPath, "");
    writeFileSync(outputPath, "");
    const result = spawnSync("bash", [scriptPath], {
      cwd: fixtureRepo,
      env: {
        ...process.env,
        EVENT_NAME: eventName,
        BASE_SHA: planBaseSha ?? "",
        HEAD_SHA: headSha ?? "",
        ONLY_FILTER: only ?? "",
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
      },
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);

    const output = readFileSync(outputPath, "utf8");
    const batchLine = output.split("\n").find((line) => line.startsWith("batches="));
    const hasTestsLine = output.split("\n").find((line) => line.startsWith("has_tests="));
    if (!batchLine || !hasTestsLine) throw new Error(`Invalid step output: ${output}`);
    const parsedBatches: unknown = JSON.parse(batchLine.slice("batches=".length));
    expect(isMatrixBatches(parsedBatches)).toBe(true);
    if (!isMatrixBatches(parsedBatches)) throw new Error("Invalid batches output");

    return {
      batches: parsedBatches,
      hasTests: hasTestsLine.slice("has_tests=".length),
      summary: readFileSync(summaryPath, "utf8"),
    };
  };

  const scenario = (file: string, content: string): string => {
    git(["checkout", "-q", "--detach", baseSha]);
    writeFileSync(join(fixtureRepo, file), content);
    git(["add", "-A"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "-m", file]);
    return git(["rev-parse", "HEAD"]);
  };

  const matrixTests = (batches: MatrixBatch[]): string[] => batches.flatMap((batch) => batch.tests).sort();
  const fallback = "No changed eligible E2E spec in this PR; running the full eligible set.";

  const excludedHead = scenario("evals/specs/excluded.e2e.test.ts", "export const excluded = false;\n");
  const excludedPlan = runPlan({ eventName: "workflow_run", baseSha, headSha: excludedHead });
  expect(matrixTests(excludedPlan.batches)).toEqual(["alpha.e2e.test.ts", "beta.e2e.test.ts"]);
  expect(excludedPlan.hasTests).toBe("true");
  expect(excludedPlan.summary).toContain(fallback);
  expect(excludedPlan.summary).not.toContain("Warden suggestion");

  const eligibleHead = scenario("evals/specs/alpha.e2e.test.ts", "export const alpha = false;\n");
  const eligiblePlan = runPlan({ eventName: "workflow_run", baseSha, headSha: eligibleHead });
  expect(matrixTests(eligiblePlan.batches)).toEqual(["alpha.e2e.test.ts"]);
  expect(eligiblePlan.hasTests).toBe("true");
  expect(eligiblePlan.summary).not.toContain(fallback);

  const readmeHead = scenario("README.md", "fixture\n");
  const readmePlan = runPlan({ eventName: "workflow_run", baseSha, headSha: readmeHead });
  expect(matrixTests(readmePlan.batches)).toEqual(["alpha.e2e.test.ts", "beta.e2e.test.ts"]);
  expect(readmePlan.hasTests).toBe("true");
  expect(readmePlan.summary).toContain(fallback);

  const scheduledPlan = runPlan({ eventName: "schedule", only: "beta" });
  expect(matrixTests(scheduledPlan.batches)).toEqual(["beta.e2e.test.ts"]);
  expect(scheduledPlan.hasTests).toBe("true");
  expect(scheduledPlan.summary).not.toContain(fallback);

  expect(workflow).not.toContain(["spec", "impact.mjs"].join("-"));

  evidence.recordAssertionEvidence(
    "The Daytona E2E matrix step selects eligible tests and falls back when needed",
    "The shell step extracted from the workflow ran against a fixture repository across excluded-change, eligible-change, non-E2E-change, and scheduled-filter scenarios.",
    true,
  );
});
