import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changedFiles, isBuildAffected } from "./build-inputs.mjs";
import { QUICK_CHECKS, REQUIRED_JOBS, assertQuickChecks, assertSelectedChecks, classifyCiChanges, classifyQuickChanges, pullRequestChanges, pushChanges } from "./classify-ci-changes.mjs";

const snapshot = "ee/apps/gateway/src/models/base.json";
const electron = "apps/desktop/electron/main.ts";
const landing = "ee/apps/landing/app/page.tsx";
const backend = "ee/apps/den-api/src/routes/example.ts";
const base = "a".repeat(40);
const head = "b".repeat(40);
const none = { core: false, den_api: false, snapshot: false, docs: false };
const all = Object.fromEntries(Object.keys(none).map((key) => [key, true]));
const modified = (filename) => ({ filename, status: "modified" });
const push = (files) => classifyCiChanges({ eventName: "push", files }, isBuildAffected);
const quick = (files, expectedCount = files?.length) => classifyQuickChanges({ eventName: "pull_request", files, expectedCount }, isBuildAffected);
const flags = ({ lane, ...selected }) => selected;
const expectFlags = (actual, expected) => assert.deepEqual(flags(actual), { ...none, ...expected });

for (const [name, files, expected] of [
  ["landing-only", [landing], {}],
  ["Electron-only", [electron], { core: true, den_api: true }],
  ["shared UI", ["packages/ui/src/components/button.tsx"], { core: true, den_api: true }],
  ["shared types", ["packages/types/src/index.ts"], { core: true, den_api: true }],
  ["backend-only", [backend], { core: true, den_api: true }],
  ["Den web-only", ["ee/apps/den-web/app/page.tsx"], { core: true, den_api: true }],
  ["a mixed app/backend push", [electron, backend, landing], { core: true, den_api: true }],
  ["a model snapshot mixed with landing", [snapshot, landing], { core: true, den_api: true, snapshot: true }],
  ["a model snapshot mixed with Electron", [snapshot, electron], { core: true, den_api: true, snapshot: true }],
  ["a docs page mixed with backend", ["packages/docs/guide.mdx", backend], { core: true, den_api: true, docs: true }],
  ["a deleted desktop file", [{ filename: electron, status: "removed" }], { core: true, den_api: true }],
  ["a no-renames push moving desktop source to landing", [electron, landing], { core: true, den_api: true }],
  ["outbound-only docs now guarded independently", ["docs/enterprise/outbound-access.md"], {}],
]) {
  test(`${name} dev push selects independent unit checks`, () => expectFlags(push(files), expected));
}

for (const path of ["packages/docs/guide.md", "packages/docs/guides/setup.mdx", "packages/docs/docs.json", "packages/docs/images/screenshot.png"]) {
  test(`${path} validates the docs site on dev pushes`, () => expectFlags(push([path]), { docs: true }));
}

test("the generated snapshot fast lane survives on push, not mixed changes", () => {
  expectFlags(push([snapshot]), { snapshot: true });
  assert.equal(push([snapshot]).lane, "snapshot");
  assert.equal(push([snapshot, landing]).lane, "affected");
  // A deleted snapshot must not claim a modified snapshot.
  expectFlags(push([{ filename: snapshot, status: "removed" }]), { core: true, den_api: true, snapshot: true });
});

for (const eventName of ["schedule", "workflow_dispatch", "pull_request", "unknown-event"]) {
  test(`${eventName} retains full regression without a changed-file shortcut`, () => {
    expectFlags(classifyCiChanges({ eventName, files: [landing] }, () => false), all);
  });
}

for (const files of [null, undefined, {}, [null], [""], ["../outside"], ["/absolute"], ["a\\b"], [landing, landing], [{ filename: landing, status: "invalid" }], [{ filename: landing, status: "renamed" }]]) {
  test(`unknown or malformed diff ${JSON.stringify(files)} selects full work`, () => expectFlags(push(files), all));
}

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
  // Dev pushes run the full suite in Build and core checks; manual runs check everything.
  assert.deepEqual(classifyQuickChanges({ eventName: "push", files: [backend] }, isBuildAffected), { den_quick: false });
  assert.deepEqual(classifyQuickChanges({ eventName: "workflow_dispatch", files: null }, isBuildAffected), { den_quick: true });
});

test("a broken dependency calculation fails open instead of green-skipping work", () => {
  for (const isAffected of [() => { throw new Error("missing workspace manifest"); }, () => undefined, () => "false"]) {
    expectFlags(classifyCiChanges({ eventName: "push", files: [landing] }, isAffected), all);
  }
});

test("a known empty push may skip work; an empty PR still runs the always-on quick checks", () => {
  expectFlags(push([]), {});
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

test("push collection compares before to sha and fetches only a missing endpoint", () => {
  const calls = [];
  let fetched = false;
  const files = pushChanges({
    base, head,
    readDiff: (range) => { calls.push(range); return fetched ? [electron, landing] : null; },
    fetchBase: (sha) => { calls.push(sha); fetched = true; },
  });
  assert.deepEqual(calls, [{ base, head }, base, { base, head }]);
  expectFlags(push(files), { core: true, den_api: true });
  assert.deepEqual(pushChanges({ base, head, readDiff: () => [landing], fetchBase: () => assert.fail("a known diff must not fetch") }), [landing]);
});

test("push base, fetch and git errors select full work rather than an empty diff", () => {
  for (const options of [
    { base: undefined }, { base: "0".repeat(40) }, { base: "--invalid" }, { head: undefined },
    { readDiff: () => { throw new Error("git failed"); } },
    { fetchBase: () => { throw new Error("fetch failed"); } },
  ]) {
    const files = pushChanges({ base, head, readDiff: () => null, fetchBase: () => {}, ...options });
    assert.equal(files, null);
    expectFlags(push(files), all);
  }
});

test("a multi-commit push includes earlier desktop changes, not just its landing tip", (t) => {
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "ci-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  const commit = () => { git("add", "--all"); git("-c", "user.name=CI fixture", "-c", "user.email=ci@example.invalid", "commit", "--quiet", "-m", "fixture"); return git("rev-parse", "HEAD"); };
  git("init", "--quiet");
  write(electron, "original desktop\n");
  write(landing, "original landing\n");
  const before = commit();
  write(electron, "changed desktop\n");
  commit();
  write(landing, "changed landing\n");
  const sha = commit();
  const files = pushChanges({ base: before, head: sha, readDiff: (range) => changedFiles({ ...range, root }), fetchBase: () => assert.fail("local endpoints exist") });
  assert.deepEqual(files, [electron, landing]);
  expectFlags(push(files), { core: true, den_api: true });
  expectFlags(push(changedFiles({ base: `${sha}^`, head: sha, root })), {});
  // The shared diff reader keeps deletions and both rename paths as input names.
  const moved = "ee/apps/landing/moved.ts";
  write(moved, readFileSync(join(root, electron), "utf8"));
  rmSync(join(root, electron));
  const renamed = commit();
  assert.deepEqual(changedFiles({ base: sha, head: renamed, root }), [electron, moved]);
  expectFlags(push(changedFiles({ base: sha, head: renamed, root })), { core: true, den_api: true });
});

function passingReport(selection) {
  const selected = flags(selection);
  return {
    classification: "success",
    selected: Object.fromEntries(Object.entries(selected).map(([check, value]) => [check, String(value)])),
    results: Object.fromEntries(Object.entries(REQUIRED_JOBS).map(([job, check]) => [job, selected[check] ? "success" : "skipped"])),
  };
}

test("the dev-push summary accepts exactly the actual selected checks", () => {
  for (const selection of [push([landing]), push([backend]), push(["packages/docs/guide.mdx"]), push([snapshot]), push(null)]) {
    assert.doesNotThrow(() => assertSelectedChecks(passingReport(selection)));
  }
});

test("every selection output gates at least one job", () => {
  assert.deepEqual([...new Set(Object.values(REQUIRED_JOBS))].sort(), Object.keys(none).sort());
});

test("every selected job must pass; skipped, cancelled and failed are not success", () => {
  const report = passingReport(push(null));
  for (const job of Object.keys(REQUIRED_JOBS)) {
    for (const result of ["skipped", "cancelled", "failure", "", undefined]) {
      assert.throws(() => assertSelectedChecks({ ...report, results: { ...report.results, [job]: result } }), new RegExp(job));
    }
  }
});

test("every unselected job must be skipped; unexpected runs cannot mask a mismatch", () => {
  const report = passingReport(push([landing]));
  for (const job of Object.keys(REQUIRED_JOBS)) {
    for (const result of ["success", "cancelled", "failure", "", undefined]) {
      assert.throws(() => assertSelectedChecks({ ...report, results: { ...report.results, [job]: result } }), new RegExp(job));
    }
  }
});

test("classification failure cannot green-skip the dev-push summary", () => {
  const report = passingReport(push([landing]));
  for (const result of ["skipped", "cancelled", "failure", "", undefined]) assert.throws(() => assertSelectedChecks({ ...report, classification: result }), /blocking merge/);
  for (const [key, drop] of [["selected", "docs"], ["results", "core_evals"]]) {
    const missing = { ...report[key] };
    delete missing[drop];
    assert.throws(() => assertSelectedChecks({ ...report, [key]: missing }), /Missing or unexpected/);
    assert.throws(() => assertSelectedChecks({ ...report, [key]: { ...report[key], unknown: "skipped" } }), /Missing or unexpected/);
  }
  for (const value of ["", "TRUE", undefined, null, 0]) assert.throws(() => assertSelectedChecks({ ...report, selected: { ...report.selected, core: value } }), /Invalid selection/);
});

// The PR gate (`openwork-tests-required` in quick-check.yml).
const quickReport = (denQuick, denResult = denQuick ? "success" : "skipped") => ({
  classification: "success",
  always: { static: "success", typecheck: "success" },
  selected: { den_quick: String(denQuick) },
  results: { den_quick: denResult },
});

test("the PR gate passes only when always-run checks pass and the Den tests match their selection", () => {
  assert.deepEqual(QUICK_CHECKS, ["den_quick"]);
  assert.doesNotThrow(() => assertQuickChecks(quickReport(true)));
  assert.doesNotThrow(() => assertQuickChecks(quickReport(false)));
  for (const result of ["skipped", "cancelled", "failure", "", null]) assert.throws(() => assertQuickChecks(quickReport(true, result)), /den_quick/);
  for (const result of ["success", "cancelled", "failure", "", null]) assert.throws(() => assertQuickChecks(quickReport(false, result)), /den_quick/);
  for (const check of ["static", "typecheck"]) {
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

test("PRs run only the quick check; Build and core checks runs after merge", () => {
  assert.doesNotMatch(triggers(ciTests), /^  pull_request(_target)?:/m);
  assert.match(triggers(ciTests), /^  push:\n    branches:\n      - dev/m);
  assert.match(triggers(ciTests), /^  schedule:/m);
  assert.match(triggers(quickCheck), /^  pull_request:\n    branches:\n      - dev/m);
  // Only one workflow reports the required context on PRs.
  assert.equal(quickCheck.split("\n  openwork-tests-required:\n").length, 2);
  assert.doesNotMatch(ciTests, /\n  openwork-tests-required:\n/);
});

test("cheap source guards need no install, build or classification", () => {
  const staticJob = job("quick-static", quickCheck);
  assert.doesNotMatch(staticJob, /\bneeds:|setup-tests|\bbuild:|continue-on-error: false/);
  assert.doesNotMatch(staticJob, /^    if:/m);
  for (const file of [
    ".github/scripts/contributor-pr.test.mjs", ".github/scripts/warden-check.test.mjs", ".github/scripts/pr-proof-selection.test.mjs",
    ".github/scripts/build-inputs.test.mjs", ".github/scripts/classify-ci-changes.test.mjs", ".github/scripts/typecheck-shipped.test.mjs",
    ".github/scripts/build-boundaries-codeql.test.mjs", "scripts/ci/codeql-config.test.mjs", "scripts/ci/check-codeql-results.test.mjs",
  ]) assert.ok(staticJob.includes(`          ${file}\n`), file);
  for (const command of ["node scripts/check-outbound-access.mjs", "pnpm --filter @openwork/features test", "pnpm features:check"]) {
    assert.ok(staticJob.includes(`run: ${command}`), command);
  }
  // Every .github/scripts test runs in the quick check.
  const tests = readdirSync(new URL(".", import.meta.url)).filter((name) => name.endsWith(".test.mjs"));
  for (const name of tests) assert.ok(staticJob.includes(`.github/scripts/${name}`), name);
});

test("the PR gate requires the always-run checks and the Den job only when selected", () => {
  const required = job("openwork-tests-required", quickCheck);
  assert.match(required, /needs: \[quick-select, quick-static, quick-typecheck, den-quick\]/);
  assert.match(required, /if: always\(\)/);
  assert.match(required, /assertQuickChecks\(checks\)/);
  assert.ok(required.includes("needs.quick-static.result"));
  assert.ok(required.includes("needs.quick-typecheck.result"));
  assert.ok(required.includes("needs.quick-select.outputs.den_quick"));
  assert.ok(required.includes("needs.den-quick.result"));
  assert.ok(job("den-quick", quickCheck).includes("if: needs.quick-select.outputs.den_quick == 'true'"));
  assert.ok(job("quick-select", quickCheck).includes("den_quick: ${{ steps.classify.outputs.den_quick }}"));
  for (const name of ["quick-static", "quick-typecheck"]) assert.doesNotMatch(job(name, quickCheck), /^    (if|needs):/m, name);
  assert.match(job("quick-typecheck", quickCheck), /node \.github\/scripts\/typecheck-shipped\.mjs --base HEAD\^1 --head HEAD/);
  assert.match(job("den-quick", quickCheck), /pnpm --filter @openwork-ee\/den-api test:api:security/);
  assert.match(job("den-quick", quickCheck), /pnpm --filter @openwork-ee\/den-api audit:coverage/);
});

test("the PR Den API subset names real API test files that the full suite also runs", () => {
  const scripts = JSON.parse(readFileSync(new URL("../../ee/apps/den-api/package.json", import.meta.url), "utf8")).scripts;
  const files = scripts["test:api:security"].split(" ").filter((part) => part.startsWith("test/api/"));
  assert.ok(files.length >= 10);
  for (const file of files) {
    assert.match(file, /^test\/api\/[a-z0-9-]+\.api\.test\.ts$/);
    assert.ok(readdirSync(new URL("../../ee/apps/den-api/test/api/", import.meta.url)).includes(file.slice("test/api/".length)), file);
  }
  assert.ok(scripts["test:api:security"].startsWith("node --conditions=development --import tsx --test "));
});

test("dev-push jobs and the summary context consume each real boolean, not a shared full lane", () => {
  const jobs = {
    core_app: "openwork-tests-app", core_headless: "openwork-tests-headless", core_workbot: "openwork-tests-workbot",
    core_den: "openwork-tests-den", core_evals: "openwork-tests-evals", core_evals_lint: "openwork-tests-evals-lint",
    desktop_build: "openwork-tests-desktop-build", den_api: "den-api-security",
    snapshot: "validate-models-snapshot", docs: "validate-docs",
  };
  assert.deepEqual(Object.keys(jobs).sort(), Object.keys(REQUIRED_JOBS).sort());
  const summary = job("openwork-tests-full");
  for (const [key, name] of Object.entries(jobs)) {
    const output = REQUIRED_JOBS[key];
    assert.ok(job(name).includes(`if: needs.classify-changes.outputs.${output} == 'true'`), name);
    assert.ok(job("classify-changes").includes(`${output}: \${{ steps.classify.outputs.${output} }}`), output);
    assert.ok(summary.includes(`needs.classify-changes.outputs.${output}`), output);
    assert.ok(summary.includes(`needs.${name}.result`), name);
    assert.match(summary, new RegExp(`\\b${key}: env\\.`), key);
    assert.ok(summary.match(/needs: \[([^\]]+)\]/)[1].split(", ").includes(name), name);
  }
  assert.match(summary, /if: always\(\)/);
  assert.match(summary, /assertSelectedChecks\(checks\)/);
  assert.match(job("classify-changes"), /base: context\.payload\.before/);
  assert.match(job("classify-changes"), /head: context\.sha/);
  assert.doesNotMatch(job("classify-changes"), /head_commit|payload\.commits/);
});

test("the Den API security shards run every API test file exactly once", () => {
  const scripts = JSON.parse(readFileSync(new URL("../../ee/apps/den-api/package.json", import.meta.url), "utf8")).scripts;
  // The shard script is test:api with only the shard option added.
  assert.equal(scripts["test:api:shard"], scripts["test:api"].replace("--test ", "--test --test-shard=${DEN_API_TEST_SHARD:-1/1} "));
  const security = job("den-api-security");
  const shards = security.match(/shard: \[([^\]]+)\]/)[1].split(", ").map(Number);
  assert.deepEqual(shards, Array.from({ length: shards.length }, (_, index) => index + 1));
  assert.ok(security.includes(`DEN_API_TEST_SHARD="$SHARD/${shards.length}" pnpm --filter @openwork-ee/den-api test:api:shard`));
  assert.match(security, /fail-fast: false/);
  assert.match(security, /pnpm ci:den:mysql/);
});

test("daily and manual cross-platform regression and packaged macOS coverage remain", () => {
  for (const name of ["openwork-tests-extended", "packaged-desktop-macos"]) {
    assert.ok(job(name).includes("if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"));
  }
  assert.match(job("openwork-tests-extended"), /blacksmith-16vcpu-ubuntu-2204, blacksmith-12vcpu-macos-15/);
  assert.match(job("openwork-tests-extended"), /pnpm test:e2e/);
  assert.match(job("packaged-desktop-macos"), /packaged-smoke-macos\.mjs --server-built/);
});
