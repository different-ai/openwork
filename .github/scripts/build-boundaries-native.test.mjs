import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildInputPatterns, isBuildAffected } from "./build-inputs.mjs";

const workflows = new Map([
  ["desktop", "alpha-macos-aarch64.yml"],
  ["headless-runner", "celld-runner-deploy.yml"],
  ["review", "review-app-deploy.yml"],
].map(([target, name]) => [target, readFileSync(new URL(`../workflows/${name}`, import.meta.url), "utf8")]));

function job(workflow, name) {
  const body = workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z0-9-]*:\n/)[0];
  assert.ok(body, `Missing ${name} job`);
  return body;
}

for (const [target, workflow] of workflows) {
  test(`${target} classifies every dev push before requesting expensive runners or deployment approval`, () => {
    const triggers = workflow.split("\non:\n")[1]?.split("\npermissions:\n")[0];
    assert.match(triggers, /push:[\s\S]*branches:[\s\S]*dev/);
    assert.match(triggers, /workflow_dispatch:/);
    // A copied workflow path list can filter a new graph edge out before the
    // dependency-aware classifier ever sees it. Only this cheap job is broad.
    assert.doesNotMatch(triggers, /^\s+paths(?:-ignore)?:/m);
    // Workflow-level locks would let an unrelated broad-trigger push cancel a
    // running build or replace a queued deployment before classification.
    assert.doesNotMatch(workflow.split("\njobs:\n")[0], /^concurrency:/m);

    const changes = job(workflow, "changes");
    assert.match(changes, /runs-on: ubuntu-latest/);
    assert.match(changes, /affected: \$\{\{ steps\.classify\.outputs\.affected \}\}/);
    assert.match(changes, /persist-credentials: false/);
    assert.match(changes, /node-version: 24\.22\.1/);
    assert.match(changes, /BUILD_BASE: \$\{\{ github\.event\.before \}\}/);
    assert.match(changes, /BUILD_HEAD: \$\{\{ github\.sha \}\}/);
    assert.ok(changes.includes(`node .github/scripts/build-inputs.mjs --target ${target} --base "\${BUILD_BASE:-${"0".repeat(40)}}" --head "$BUILD_HEAD"`));
    assert.doesNotMatch(changes, /\bpnpm\b|setup-bun|environment:|secrets\.|swift build|celld deploy|vercel@/);
    assert.equal(isBuildAffected(target, null), true, "Unknown comparisons must run, including dispatches without a push base");
    assert.equal(isBuildAffected(target, []), false);
    assert.ok(buildInputPatterns(target).includes(".github/scripts/build-inputs.mjs"));
  });
}

test("the workflow CLI commands force manual builds but skip a known empty push range", () => {
  for (const [target, workflow] of workflows) {
    const command = job(workflow, "changes").match(/^        run: (node .*)$/m)?.[1];
    assert.ok(command, target);
    for (const [base, affected] of [["", true], ["HEAD", false]]) {
      const result = spawnSync("bash", ["-euc", command], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: { ...process.env, BUILD_BASE: base, BUILD_HEAD: "HEAD", GITHUB_OUTPUT: "", GITHUB_ACTIONS: "false" },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, 0, `${target}: ${result.stderr}`);
      assert.ok(result.stdout.split("\n").includes(`affected=${affected}`), `${target}: ${result.stdout}`);
      assert.match(result.stdout, /fingerprint=[a-f0-9]{64}/);
    }
  }
});

test("both alpha platforms depend on the desktop scope while retaining manual platform selection", () => {
  const workflow = workflows.get("desktop");
  for (const [name, otherPlatform] of [
    ["publish-alpha-macos-aarch64", "windows-x64"],
    ["publish-alpha-windows-x64", "macos-arm64"],
  ]) {
    const publish = job(workflow, name);
    assert.match(publish, /needs: changes/);
    assert.ok(publish.includes(`if: needs.changes.outputs.affected == 'true' && (github.event_name == 'push' || inputs.platform != '${otherPlatform}')`));
    assert.match(publish, /pnpm --filter @openwork\/desktop\.\.\. --filter @openwork\/app\.\.\. --filter openwork-server\.\.\. install --frozen-lockfile --prefer-offline/);
  }
});

test("deployment scope gates retain repository, environment and authentication checks", () => {
  const runner = job(workflows.get("headless-runner"), "deploy");
  const review = job(workflows.get("review"), "deploy");
  for (const deploy of [runner, review]) {
    assert.match(deploy, /needs: changes/);
    assert.match(deploy, /github\.repository == 'different-ai\/openwork'/);
    assert.match(deploy, /needs\.changes\.outputs\.affected == 'true'/);
  }
  assert.match(runner, /concurrency:\n      group: celld-runner-deploy\n      cancel-in-progress: false/);
  assert.match(review, /concurrency:\n      group: review-app-deploy\n      cancel-in-progress: false/);
  assert.match(runner, /environment: celld-production/);
  assert.match(runner, /name: Check the live runner and this one can serve each other/);
  assert.match(runner, /name: Preflight on a throwaway prefix/);
  assert.match(runner, /name: Wait for every node to adopt it/);
  assert.match(review, /name: review-app/);
  assert.match(review, /vars\.OPENWORK_REVIEW_URL != ''/);
  assert.match(review, /vars\.OPENWORK_REVIEW_VERCEL_ORG_ID != ''/);
  assert.match(review, /vars\.OPENWORK_REVIEW_VERCEL_PROJECT_ID != ''/);
  assert.match(review, /name: Verify the alias still requires Vercel Authentication/);
});

test("Electron source selects desktop packaging, not backend builds or deployments", () => {
  const files = ["apps/desktop/electron/main.mjs"];
  assert.equal(isBuildAffected("desktop", files), true);
  for (const target of ["den-api", "den-web", "inference", "client-web", "workbot", "headless-runner", "review", "swift"]) {
    assert.equal(isBuildAffected(target, files), false, target);
  }
});

test("alpha includes transitive workspace packages and native/release inputs", () => {
  for (const path of [
    "packages/browser-tabs/src/index.ts",
    "packages/remote-sessions/src/index.ts",
    "packages/sandbox-freestyle/src/index.ts",
    "packages/codemode/src/index.ts",
    "packages/free-auto/src/index.ts",
    "packages/headless-threads/src/index.ts",
    "packages/computer-use/native/Sources/ComputerUse/main.swift",
    ".github/actions/windows-signing/action.yml",
    "scripts/release/stamp-version.mjs",
    ".github/workflows/alpha-macos-aarch64.yml",
  ]) {
    assert.equal(isBuildAffected("desktop", [path]), true, path);
  }
});

test("embedded docs include Markdown, MDX and navigation, not screenshots or website-only files", () => {
  for (const path of [
    "packages/docs/start-here/overview.md",
    "packages/docs/cloud/run-in-the-cloud/cloud-mcp.mdx",
    "packages/docs/docs.json",
  ]) {
    assert.equal(isBuildAffected("desktop", [path]), true, path);
  }
  for (const path of [
    "packages/docs/images/screenshot.png",
    "packages/docs/images/screenshot.svg",
    "packages/docs/openapi.json",
    "docs/codeql-results.md",
    "ee/apps/landing/app/page.tsx",
  ]) {
    assert.equal(isBuildAffected("desktop", [path]), false, path);
  }
});

test("review follows all evidence dependencies and its external shared-color import", () => {
  for (const path of [
    "apps/review/app/page.tsx",
    "packages/review/src/schema.ts",
    "packages/evidence-provider/src/provider.ts",
    "packages/daytona-evidence/src/review-provider.ts",
    "packages/freestyle/src/builder.ts",
    "apps/app/src/styles/colors.css",
    ".vercelignore",
    ".github/workflows/review-app-deploy.yml",
  ]) {
    assert.equal(isBuildAffected("review", [path]), true, path);
  }
  for (const path of ["apps/app/src/app.tsx", "apps/app/src/styles/base.css", "ee/apps/landing/app/page.tsx"]) {
    assert.equal(isBuildAffected("review", [path]), false, path);
  }
});

test("celld includes the runner's transitive dependencies and desktop-image cross-file edge", () => {
  for (const path of [
    "ee/apps/headless-runner/scripts/celld-bundle.ts",
    "ee/packages/headless-protocol/src/index.ts",
    "ee/packages/headless-computer/scripts/desktop-identity.mjs",
    "packages/workbook/src/index.ts",
    "packages/sandbox/src/index.ts",
    "packages/sandbox-freestyle/src/index.ts",
    "packages/sandbox-daytona/src/index.ts",
    "packages/sandbox-differently/src/index.ts",
    "packages/computer-use/computer-x11-driver.mjs",
    "packages/codemode/src/index.ts",
    "packages/types/src/browser-demonstration.ts",
    "ee/apps/den-worker-runtime/scripts/cloud-desktop.sh",
    ".github/workflows/celld-runner-deploy.yml",
  ]) {
    assert.equal(isBuildAffected("headless-runner", [path]), true, path);
  }
  for (const path of ["ee/apps/den-worker-runtime/src/index.ts", "ee/apps/workbot/src/index.ts", "apps/desktop/electron/main.mjs"]) {
    assert.equal(isBuildAffected("headless-runner", [path]), false, path);
  }
});

test("every native deployment includes its dependency configuration and classifier", () => {
  for (const target of workflows.keys()) {
    for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "patches/example.patch", ".github/scripts/build-inputs.mjs"]) {
      assert.equal(isBuildAffected(target, [path]), true, `${target}: ${path}`);
    }
  }
});
