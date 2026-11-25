import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { isBuildAffected } from "./build-inputs.mjs";
import { QUICK_CHECKS, assertQuickChecks, classifyQuickChanges, pullRequestChanges } from "./classify-ci-changes.mjs";

const electron = "apps/desktop/electron/main.ts";
const landing = "ee/apps/landing/app/page.tsx";
const backend = "ee/apps/den-api/src/routes/example.ts";
const base = "a".repeat(40);
const head = "b".repeat(40);
const modified = (filename) => ({ filename, status: "modified" });
const quick = (files, expectedCount = files?.length) => classifyQuickChanges({ eventName: "pull_request", files, expectedCount }, isBuildAffected);
// PR quick check: the Den API auth and permission tests follow their inputs.
test("PRs run the Den API auth tests only when Den API inputs change", () => {
  for (const path of [backend, "ee/packages/den-db/src/schema.ts", "packages/types/src/index.ts", "pnpm-lock.yaml", ".github/workflows/ci-tests.yml", "packaging/docker/docker-compose.ci-mysql.yml"]) {
    assert.deepEqual(quick([modified(path)]), { den_quick: true }, path);
  }
  for (const path of [landing, electron, "apps/app/src/index.ts", "ee/apps/den-web/app/page.tsx", "packages/docs/guide.mdx", "evals/specs/drive-files.e2e.test.ts"]) {
    assert.deepEqual(quick([modified(path)]), { den_quick: false }, path);
  }
  // Renames keep both ends.
  assert.deepEqual(quick([{ filename: landing, previous_filename: backend, status: "renamed" }]), { den_quick: true });
});

test("the Den API auth tests follow every file they read", () => {
  const dir = new URL("../../ee/apps/den-api/test/api/", import.meta.url);
  const repo = new URL("../../", import.meta.url);
  const sources = readdirSync(dir).filter((name) => name.endsWith(".ts")).map((name) => readFileSync(new URL(name, dir), "utf8"));
  const outside = new Set();
  for (const source of sources) {
    for (const [, literal] of source.matchAll(/["'`]((?:\.\.\/){2,}[^"'`$]+)["'`]/g)) {
      // A directory reference stands for a file inside it.
      const resolved = new URL(literal, dir).href.slice(repo.href.length).replace(/\/$/, "");
      const path = resolved.split("/").pop().includes(".") ? resolved : `${resolved}/x`;
      if (!path.startsWith("ee/apps/den-api/") && !path.includes("node_modules/")) outside.add(path);
    }
  }
  assert.ok(outside.size > 0, "the scan finds files read outside den-api");
  for (const path of [...outside, "ee/apps/den-api/test/api/harness.ts", "ee/apps/den-api/package.json"]) {
    assert.deepEqual(quick([modified(path)]), { den_quick: true }, path);
  }
});

test("an unknown, incomplete or broken PR comparison runs the Den API tests", () => {
  for (const expectedCount of [null, -1, 0, 2, 3001, "1"]) assert.deepEqual(quick([modified(landing)], expectedCount), { den_quick: true });
  assert.deepEqual(classifyQuickChanges({ eventName: "pull_request", files: [modified(landing)] }, isBuildAffected), { den_quick: true });
  for (const files of [null, undefined, [null], ["../outside"], [{ filename: landing, status: "renamed" }], [landing]]) assert.deepEqual(quick(files), { den_quick: true });
  for (const isAffected of [() => { throw new Error("missing manifest"); }, () => undefined, () => "false"]) {
    assert.deepEqual(classifyQuickChanges({ eventName: "pull_request", files: [modified(landing)], expectedCount: 1 }, isAffected), { den_quick: true });
  }
  // Only PRs are narrowed: a dev push and a manual run check everything, whatever changed.
  for (const eventName of ["push", "workflow_dispatch", "schedule", "unknown-event"]) {
    assert.deepEqual(classifyQuickChanges({ eventName, files: [modified(landing)], expectedCount: 1 }, () => false), { den_quick: true }, eventName);
  }
});

test("a known empty PR may skip work; an empty PR still runs the always-on quick checks", () => {
  assert.deepEqual(quick([], 0), { den_quick: false });
});

function pullFixture({ files, count = files.length, before = {}, after = {}, fail } = {}) {
  const meta = { head: { sha: head }, base: { sha: base }, changed_files: count };
  const calls = [];
  let gets = 0;
  const listFiles = async () => { throw new Error("listFiles must be paginated"); };
  const github = {
    rest: { pulls: {
      listFiles,
      get: async (request) => {
        calls.push(["get", request]);
        if (fail === "get") throw new Error("API unavailable");
        return { data: { ...meta, ...(gets++ === 0 ? before : after) } };
      },
    } },
    paginate: async (method, request) => {
      assert.equal(method, listFiles);
      calls.push(["paginate", request]);
      if (fail === "paginate") throw new Error("page 2 failed");
      return files;
    },
  };
  return { calls, read: () => pullRequestChanges({ github, owner: "test", repo: "repository", number: 1, head }) };
}

test("PR collection uses pagination past 100 files and retains rename origins", async () => {
  const files = Array.from({ length: 100 }, (_, i) => modified(`ee/apps/landing/pages/${i}.tsx`));
  files.push({ filename: "ee/apps/landing/moved.ts", status: "renamed", previous_filename: backend });
  const fixture = pullFixture({ files });
  const result = await fixture.read();
  assert.equal(result.files.length, 101);
  assert.deepEqual(fixture.calls, [
    ["get", { owner: "test", repo: "repository", pull_number: 1 }],
    ["paginate", { owner: "test", repo: "repository", pull_number: 1, per_page: 100 }],
    ["get", { owner: "test", repo: "repository", pull_number: 1 }],
  ]);
  assert.deepEqual(classifyQuickChanges({ eventName: "pull_request", ...result }, isBuildAffected), { den_quick: true });
});

for (const [name, options] of [
  ["an incomplete page", { count: 101 }],
  ["GitHub's file cap", { count: 3001 }],
  ["an unavailable count", { before: { changed_files: undefined } }],
  ["a stale event head", { before: { head: { sha: "c".repeat(40) } } }],
  ["a head moving during pagination", { after: { head: { sha: "c".repeat(40) } } }],
  ["a base moving during pagination", { after: { base: { sha: "c".repeat(40) } } }],
  ["a changed count during pagination", { after: { changed_files: 2 } }],
  ["a failed page", { fail: "paginate" }],
  ["a failed metadata lookup", { fail: "get" }],
]) {
  test(`PR collection fails open for ${name}`, async () => {
    const result = await pullFixture({ files: [modified(landing)], ...options }).read();
    assert.equal(result.files, null);
    assert.deepEqual(classifyQuickChanges({ eventName: "pull_request", ...result }, isBuildAffected), { den_quick: true });
  });
}

// The PR gate (`openwork-tests-required` in quick-check.yml).
const quickReport = (denQuick, denResult = denQuick ? "success" : "skipped") => ({
  classification: "success",
  always: { static: "success", typecheck: "success", desktop_build: "success" },
  selected: { den_quick: String(denQuick) },
  results: { den_quick: denResult },
});

test("the PR gate passes only when always-run checks pass and the Den tests match their selection", () => {
  assert.deepEqual(QUICK_CHECKS, ["den_quick"]);
  assert.doesNotThrow(() => assertQuickChecks(quickReport(true)));
  assert.doesNotThrow(() => assertQuickChecks(quickReport(false)));
  for (const result of ["skipped", "cancelled", "failure", "", null]) assert.throws(() => assertQuickChecks(quickReport(true, result)), /den_quick/);
  for (const result of ["success", "cancelled", "failure", "", null]) assert.throws(() => assertQuickChecks(quickReport(false, result)), /den_quick/);
  for (const check of ["static", "typecheck", "desktop_build"]) {
    for (const result of ["skipped", "cancelled", "failure", "", undefined]) {
      const report = quickReport(false);
      assert.throws(() => assertQuickChecks({ ...report, always: { ...report.always, [check]: result } }), new RegExp(check));
    }
  }
  for (const result of ["skipped", "cancelled", "failure", "", undefined]) assert.throws(() => assertQuickChecks({ ...quickReport(false), classification: result }), /blocking merge/);
  assert.throws(() => assertQuickChecks({ ...quickReport(false), always: {} }), /blocking merge/);
  for (const value of ["", "TRUE", undefined, null, 0]) assert.throws(() => assertQuickChecks({ ...quickReport(false), selected: { den_quick: value } }), /Invalid selection/);
  assert.throws(() => assertQuickChecks({ ...quickReport(false), selected: {} }), /Missing or unexpected/);
  assert.throws(() => assertQuickChecks({ ...quickReport(false), results: { den_quick: "skipped", extra: "skipped" } }), /Missing or unexpected/);
});

const ciTests = readFileSync(new URL("../workflows/ci-tests.yml", import.meta.url), "utf8");
const quickCheck = readFileSync(new URL("../workflows/quick-check.yml", import.meta.url), "utf8");
function job(name, workflow = ciTests) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name}`);
  const body = workflow.slice(start + 1);
  const end = body.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return end === -1 ? body : body.slice(0, end + 1);
}
const triggers = (workflow) => workflow.split("\njobs:\n")[0];

test("the critical checks run on PRs and dev pushes; the nightly regression gates nothing", () => {
  assert.match(triggers(quickCheck), /^  pull_request:\n    branches:\n      - dev\n  push:\n    branches:\n      - dev/m);
  assert.doesNotMatch(triggers(ciTests), /^  (push|pull_request|pull_request_target):/m);
  assert.match(triggers(ciTests), /^  schedule:/m);
  assert.match(triggers(ciTests), /^  workflow_dispatch:/m);
  // Only one workflow reports the required context.
  assert.equal(quickCheck.split("\n  openwork-tests-required:\n").length, 2);
  assert.doesNotMatch(ciTests, /\n  openwork-tests-(required|full):\n/);
  // Nothing in the nightly run is narrowed by changed files or left unselected.
  assert.doesNotMatch(ciTests, /classify-changes|^    (if|needs):/m);
});

test("cheap source guards need no install, build or classification", () => {
  const staticJob = job("quick-static", quickCheck);
  assert.doesNotMatch(staticJob, /\bneeds:|setup-tests|\bbuild:|continue-on-error: false/);
  assert.doesNotMatch(staticJob, /^    if:/m);
  for (const file of [
    ".github/scripts/contributor-pr.test.mjs", ".github/scripts/pr-proof-selection.test.mjs",
    ".github/scripts/build-inputs.test.mjs", ".github/scripts/classify-ci-changes.test.mjs", ".github/scripts/typecheck-shipped.test.mjs",
    ".github/scripts/build-boundaries-codeql.test.mjs", ".github/scripts/managed-stable-release.test.mjs",
    "scripts/ci/codeql-config.test.mjs", "scripts/ci/check-codeql-results.test.mjs",
  ]) assert.ok(staticJob.includes(`          ${file}\n`), file);
  for (const command of ["node scripts/check-outbound-access.mjs", "pnpm --filter @openwork/features test", "pnpm features:check"]) {
    assert.ok(staticJob.includes(`run: ${command}`), command);
  }
  // Every PR checks what production Node loads from TypeScript source, after the install that provides its parser.
  const importCheck = staticJob.indexOf("\n          node scripts/check-node-source-imports.mjs\n");
  assert.ok(importCheck > staticJob.indexOf('--filter "@different-ai/openwork-workspace"'), "check Node's source imports after installing the root's dependencies");
  assert.ok(staticJob.indexOf('--filter "@different-ai/openwork-workspace"') !== -1);
  // Every .github/scripts test runs in the quick check.
  const tests = readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".test.mjs"));
  for (const name of tests) assert.ok(staticJob.includes(`.github/scripts/${name}`), name);
});

test("the PR gate requires the always-run checks and the Den job only when selected", () => {
  const required = job("openwork-tests-required", quickCheck);
  assert.match(required, /needs: \[quick-select, quick-static, quick-typecheck, desktop-build, den-quick\]/);
  assert.match(required, /if: always\(\)/);
  assert.match(required, /assertQuickChecks\(checks\)/);
  assert.ok(required.includes("needs.quick-static.result"));
  assert.ok(required.includes("needs.quick-typecheck.result"));
  assert.ok(required.includes("needs.desktop-build.result"));
  assert.ok(required.includes("needs.quick-select.outputs.den_quick"));
  assert.ok(required.includes("needs.den-quick.result"));
  assert.ok(job("den-quick", quickCheck).includes("if: needs.quick-select.outputs.den_quick == 'true'"));
  assert.ok(job("quick-select", quickCheck).includes("den_quick: ${{ steps.classify.outputs.den_quick }}"));
  for (const name of ["quick-static", "quick-typecheck", "desktop-build"]) assert.doesNotMatch(job(name, quickCheck), /^    (if|needs):/m, name);
  assert.match(job("quick-typecheck", quickCheck), /node \.github\/scripts\/typecheck-shipped\.mjs --base HEAD\^1 --head HEAD/);
  assert.match(job("den-quick", quickCheck), /pnpm --filter @openwork-ee\/den-api test:api:security/);
  assert.match(job("den-quick", quickCheck), /pnpm --filter @openwork-ee\/den-api audit:coverage/);
  // The desktop build check bundles the server the way packaged builds do, then typechecks Electron main.
  const desktop = job("desktop-build", quickCheck);
  const bundle = desktop.indexOf("pnpm --filter openwork-server build");
  assert.ok(bundle !== -1 && bundle < desktop.indexOf("pnpm --filter @openwork/desktop typecheck:electron"));
  assert.match(desktop, /rm -rf packages\/types\/dist/);
});

test("the Den API auth and permission tests name real API test files", () => {
  const scripts = JSON.parse(readFileSync(new URL("../../ee/apps/den-api/package.json", import.meta.url), "utf8")).scripts;
  const files = scripts["test:api:security"].split(" ").filter((part) => part.startsWith("test/api/"));
  assert.ok(files.length >= 10);
  for (const file of files) {
    assert.match(file, /^test\/api\/[a-z0-9-]+\.api\.test\.ts$/);
    assert.ok(readdirSync(new URL("../../ee/apps/den-api/test/api/", import.meta.url)).includes(file.slice("test/api/".length)), file);
  }
  assert.ok(scripts["test:api:security"].startsWith("node --conditions=development --import tsx --test "));
});

test("daily and manual cross-platform regression and packaged macOS coverage remain", () => {
  for (const name of ["openwork-tests-extended", "packaged-desktop-macos", "validate-models-snapshot", "validate-docs"]) assert.ok(job(name));
  assert.match(job("openwork-tests-extended"), /blacksmith-16vcpu-ubuntu-2204, blacksmith-12vcpu-macos-15/);
  assert.match(job("openwork-tests-extended"), /pnpm test:e2e/);
  assert.match(job("packaged-desktop-macos"), /packaged-smoke-macos\.mjs --server-built/);
});
