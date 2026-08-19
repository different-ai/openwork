import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { briefTest, claim, testBrief } from "@openwork/testkit";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

briefTest(testBrief({
  behavior: "Testing surfaces use industry-standard E2E and evidence terminology.",
  claims: {
    e2eTests: claim("app-driving tests use the E2E filename and project convention", {
      never: "classify tests by expected runtime",
    }),
    evidencePackages: claim("evidence packages and commands describe test evidence, artifacts, and runs", {
      never: "expose internal brand or photo-roll terminology on the paved path",
    }),
    workflows: claim("scheduled workflows describe regression and critical-path E2E coverage", {
      never: "use vague sweep or mega labels",
    }),
  },
}), async ({ prove }) => {
  const testEntries = await readdir(join(repoRoot, "evals", "specs"), { recursive: true, withFileTypes: true });
  const testFiles = testEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const e2eFiles = testFiles.filter((file) => file.endsWith(".e2e.test.ts"));
  const runtimeNamedFiles = testFiles.filter((file) => file.endsWith(".slow.test.ts"));
  const vitestConfig = await readFile(join(repoRoot, "evals", "vitest.config.ts"), "utf8");

  expect(e2eFiles.length).toBeGreaterThan(0);
  expect(runtimeNamedFiles).toEqual([]);
  expect(vitestConfig).toContain('name: "e2e"');
  expect(vitestConfig).toContain('include: ["specs/**/*.e2e.test.ts"]');
  prove.e2eTests(
    true,
    `${e2eFiles.length} app-driving tests use .e2e.test.ts and the Vitest project is named e2e`,
  );

  const packageDirectories = await readdir(join(repoRoot, "evals", "packages"));
  const testEvidencePackage = await readFile(join(repoRoot, "evals", "packages", "test-evidence", "package.json"), "utf8");
  const testArtifactsPackage = await readFile(join(repoRoot, "evals", "packages", "test-artifacts", "package.json"), "utf8");
  const evalsPackage = await readFile(join(repoRoot, "evals", "package.json"), "utf8");
  const evalsCli = await readFile(join(repoRoot, "evals", "bin", "evals.mjs"), "utf8");

  expect(packageDirectories).toContain("test-evidence");
  expect(packageDirectories).toContain("test-artifacts");
  expect(testEvidencePackage).toContain('"name": "@openwork/test-evidence"');
  expect(testArtifactsPackage).toContain('"name": "@openwork/test-artifacts"');
  expect(evalsPackage).not.toContain('"@openwork/fraimz"');
  expect(evalsPackage).not.toContain('"@openwork/evidence"');
  expect(evalsPackage).toContain('"evidence:judge"');
  expect(evalsPackage).toContain('"artifacts:publish"');
  expect(evalsCli).toContain("--test-run");
  expect(evalsCli).not.toContain("--roll");
  prove.evidencePackages(
    true,
    "the workspace exposes @openwork/test-evidence, @openwork/test-artifacts, evidence:judge, artifacts:publish, and --test-run",
  );

  const workflowFiles = await readdir(join(repoRoot, ".github", "workflows"));
  const currentWorkflows = [
    "daytona-e2e-regression-suite.yml",
    "e2e-test-failure-alerts.yml",
    "nightly-critical-path-e2e.yml",
  ];
  const replacedWorkflows = [
    "slow-specs-sweep.yml",
    "slow-test-failure-alerts.yml",
    "nightly-mega-eval.yml",
  ];
  const ciWorkflow = await readFile(join(repoRoot, ".github", "workflows", "ci-tests.yml"), "utf8");
  const regressionWorkflow = await readFile(
    join(repoRoot, ".github", "workflows", "daytona-e2e-regression-suite.yml"),
    "utf8",
  );

  for (const workflow of currentWorkflows) expect(workflowFiles).toContain(workflow);
  for (const workflow of replacedWorkflows) expect(workflowFiles).not.toContain(workflow);
  expect(ciWorkflow).toContain("pnpm --dir evals run test:pr");
  expect(ciWorkflow).not.toContain("pnpm --dir evals run spec");
  expect(regressionWorkflow).toContain("pnpm --dir evals install --frozen-lockfile --ignore-scripts");
  prove.workflows(
    true,
    "active workflows use the regression and critical-path names, CI invokes test:pr, and privileged E2E installs disable lifecycle scripts",
  );
});
