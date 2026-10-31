import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { changedFiles, isBuildAffected } from "./build-inputs.mjs";
import { REQUIRED_JOBS, assertSelectedChecks, classifyCiChanges, pullRequestChanges, pushChanges } from "./classify-ci-changes.mjs";

const snapshot = "ee/apps/gateway/src/models/base.json";
const electron = "apps/desktop/electron/main.ts";
const landing = "ee/apps/landing/app/page.tsx";
const backend = "ee/apps/den-api/src/routes/example.ts";
const base = "a".repeat(40);
const head = "b".repeat(40);
const none = { core: false, desktop_smoke: false, den_api: false, snapshot: false, docs: false, den_contract: false };
const all = Object.fromEntries(Object.keys(none).map((key) => [key, true]));
const modified = (filename) => ({ filename, status: "modified" });
const push = (files) => classifyCiChanges({ eventName: "push", files }, isBuildAffected);
const pr = (files, expectedCount = files?.length) => classifyCiChanges({ eventName: "pull_request", files, expectedCount }, isBuildAffected);
const flags = ({ lane, ...selected }) => selected;
const expectFlags = (actual, expected) => assert.deepEqual(flags(actual), { ...none, ...expected });

for (const [name, files, expected] of [
  ["landing-only", [landing], {}],
  ["Electron-only", [electron], { core: true, desktop_smoke: true, den_api: true }],
  ["shared UI", ["packages/ui/src/components/button.tsx"], { core: true, desktop_smoke: true, den_api: true }],
  ["shared types", ["packages/types/src/index.ts"], { core: true, desktop_smoke: true, den_api: true }],
  ["backend-only", [backend], { core: true, den_api: true }],
  ["Den web-only", ["ee/apps/den-web/app/page.tsx"], { core: true, den_api: true }],
  ["a mixed app/backend push", [electron, backend, landing], { core: true, desktop_smoke: true, den_api: true }],
  ["a model snapshot mixed with landing", [snapshot, landing], { core: true, den_api: true, snapshot: true }],
  ["a model snapshot mixed with Electron", [snapshot, electron], { core: true, desktop_smoke: true, den_api: true, snapshot: true }],
  ["a docs page mixed with backend", ["packages/docs/guide.mdx", backend], { core: true, desktop_smoke: true, den_api: true, docs: true }],
  ["a deleted desktop file", [{ filename: electron, status: "removed" }], { core: true, desktop_smoke: true, den_api: true }],
  ["a no-renames push moving desktop source to landing", [electron, landing], { core: true, desktop_smoke: true, den_api: true }],
  ["outbound-only docs now guarded independently", ["docs/enterprise/outbound-access.md"], {}],
]) {
  test(`${name} dev push selects independent unit and packaged checks`, () => expectFlags(push(files), expected));
}

for (const path of ["packages/docs/guide.md", "packages/docs/guides/setup.mdx", "packages/docs/docs.json"]) {
  test(`${path} remains an embedded desktop input on push and PR`, () => {
    expectFlags(push([path]), { desktop_smoke: true, docs: true });
    expectFlags(pr([modified(path)]), { desktop_smoke: true, docs: true });
  });
}

for (const path of ["packages/docs/images/screenshot.png", "packages/docs/images/logo.svg"]) {
  test(`${path} validates the site without packaging the desktop`, () => {
    expectFlags(push([path]), { docs: true });
    expectFlags(pr([modified(path)]), { docs: true });
  });
}

test("the generated snapshot fast lane survives on push and PR, not mixed changes", () => {
  expectFlags(push([snapshot]), { snapshot: true });
  expectFlags(pr([modified(snapshot)]), { snapshot: true });
  assert.equal(push([snapshot]).lane, "snapshot");
  assert.equal(push([snapshot, landing]).lane, "affected");
  // A PR deleting/renaming the model source must not claim a modified snapshot.
  expectFlags(pr([{ filename: snapshot, status: "removed" }]), { core: true });
  expectFlags(pr([{ filename: snapshot, status: "renamed", previous_filename: backend }]), { core: true, den_api: true, den_contract: true });
});

test("every non-docs PR runs the unit tests; slow suites follow their inputs", () => {
  expectFlags(pr([modified(landing)]), { core: true });
  expectFlags(pr([modified(backend)]), { core: true, den_api: true, den_contract: true });
  expectFlags(pr([modified("ee/apps/den-web/app/page.tsx")]), { core: true });
  expectFlags(pr([modified("ee/packages/den-db/src/schema.ts")]), { core: true, den_api: true, den_contract: true });
  expectFlags(pr([modified(electron)]), { core: true, desktop_smoke: true });
  expectFlags(pr([modified("apps/server/src/server.ts")]), { core: true, desktop_smoke: true });
  expectFlags(pr([modified("apps/app/src/index.ts")]), { core: true });
  expectFlags(pr([modified("packages/ui/src/components/button.tsx")]), { core: true });
  expectFlags(pr([modified("packages/types/src/index.ts")]), { core: true, den_api: true, den_contract: true });
  expectFlags(pr([modified("pnpm-lock.yaml")]), { core: true, desktop_smoke: true, den_api: true, docs: true, den_contract: true });
  expectFlags(pr([modified(".github/workflows/ci-tests.yml")]), { core: true, desktop_smoke: true, den_api: true, docs: true, den_contract: true });
});

// Regression boundaries for the path-scoped PR suites (see reports in the PR):
// each input a suite reads must select it.
test("PRs package the desktop when the shell, embedded server, pins, dependencies or harness change", () => {
  for (const path of [electron, "apps/desktop/scripts/prepare-sidecar.mjs", "apps/server/src/server.ts", "constants.json", "packages/opencode-plugin/index.ts", "pnpm-lock.yaml", "package.json", "patches/example.patch", "packages/docs/docs.json", "evals/core/app-smoke.e2e.test.ts", "evals/worlds/first-run.ts", "evals/packages/testkit/src/index.ts", ".github/actions/setup-tests/action.yml"]) {
    assert.equal(pr([modified(path)]).desktop_smoke, true, path);
  }
  for (const path of [backend, "apps/app/src/index.ts", "packages/types/src/index.ts", "ee/apps/den-web/app/page.tsx", "evals/specs/drive-files.e2e.test.ts", "evals/worlds/drive-files.ts", "infra/managed-deployments/README.md"]) {
    assert.equal(pr([modified(path)]).desktop_smoke, false, path);
  }
  // Dev pushes still package for every desktop input, including app UI and shared packages.
  for (const path of ["apps/app/src/index.ts", "packages/types/src/index.ts", "packages/ui/src/components/button.tsx"]) {
    assert.equal(push([path]).desktop_smoke, true, path);
  }
});

test("the Den API security tests follow every file they read", () => {
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
  for (const path of [...outside, "ee/apps/den-api/test/api/harness.ts", "ee/packages/den-db/src/schema.ts", "packaging/docker/docker-compose.ci-mysql.yml"]) {
    assert.equal(pr([modified(path)]).den_api, true, path);
  }
  for (const path of ["apps/app/src/index.ts", "ee/apps/den-web/app/page.tsx", landing]) assert.equal(pr([modified(path)]).den_api, false, path);
});

test("renames retain both ends for contract selection and the docs exception", () => {
  expectFlags(pr([{ filename: landing, previous_filename: backend, status: "renamed" }]), { core: true, den_api: true, den_contract: true });
  expectFlags(pr([{ filename: "packages/docs/old-code.mdx", previous_filename: electron, status: "renamed" }]), { core: true, desktop_smoke: true, docs: true });
  expectFlags(pr([{ filename: "apps/app/src/moved.ts", previous_filename: "apps/server/src/old.ts", status: "renamed" }]), { core: true, desktop_smoke: true });
  expectFlags(pr([{ filename: "packages/docs/images/guide.png", previous_filename: "packages/docs/guide.mdx", status: "renamed" }]), { desktop_smoke: true, docs: true });
  expectFlags(push(["packages/docs/guide.mdx", "packages/docs/images/guide.png"]), { desktop_smoke: true, docs: true });
  expectFlags(push(["packages/docs/deleted.md"]), { desktop_smoke: true, docs: true });
});

for (const eventName of ["schedule", "workflow_dispatch", "unknown-event"]) {
  test(`${eventName} retains full regression without a changed-file shortcut`, () => {
    expectFlags(classifyCiChanges({ eventName, files: [landing] }, () => false), all);
  });
}

for (const files of [null, undefined, {}, [null], [""], ["../outside"], ["/absolute"], ["a\\b"], [landing, landing], [{ filename: landing, status: "invalid" }], [{ filename: landing, status: "renamed" }]]) {
  test(`unknown or malformed diff ${JSON.stringify(files)} selects full work`, () => expectFlags(push(files), all));
}

for (const expectedCount of [undefined, null, -1, 0, 2, 3001, "1"]) {
  test(`incomplete PR count ${JSON.stringify(expectedCount)} selects full work`, () => {
    expectFlags(classifyCiChanges({ eventName: "pull_request", files: [modified(landing)], expectedCount }, isBuildAffected), all);
  });
}

test("missing PR status or rename metadata cannot select a narrow fast lane", () => {
  expectFlags(pr([snapshot]), all);
  expectFlags(pr([{ filename: "packages/docs/guide.mdx", status: "renamed" }]), all);
});

test("a broken dependency calculation fails open instead of green-skipping work", () => {
  for (const isAffected of [() => { throw new Error("missing workspace manifest"); }, () => undefined, () => "false"]) {
    expectFlags(classifyCiChanges({ eventName: "push", files: [landing] }, isAffected), all);
  }
});

test("a known empty push may skip work; an empty PR still has its full coverage", () => {
  expectFlags(push([]), {});
  expectFlags(pr([], 0), { core: true });
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
  expectFlags(classifyCiChanges({ eventName: "pull_request", ...result }, isBuildAffected), { core: true, den_api: true, den_contract: true });
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
    expectFlags(classifyCiChanges({ eventName: "pull_request", ...result }, isBuildAffected), all);
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
  expectFlags(push(files), { core: true, desktop_smoke: true, den_api: true });
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
  expectFlags(push(files), { core: true, desktop_smoke: true, den_api: true });
  expectFlags(push(changedFiles({ base: `${sha}^`, head: sha, root })), {});
  // The shared diff reader keeps deletions and both rename paths as input names.
  const moved = "ee/apps/landing/moved.ts";
  write(moved, readFileSync(join(root, electron), "utf8"));
  rmSync(join(root, electron));
  const renamed = commit();
  assert.deepEqual(changedFiles({ base: sha, head: renamed, root }), [electron, moved]);
  expectFlags(push(changedFiles({ base: sha, head: renamed, root })), { core: true, desktop_smoke: true, den_api: true });
});

function passingReport(selection) {
  const selected = flags(selection);
  return {
    classification: "success", staticChecks: "success",
    selected: Object.fromEntries(Object.entries(selected).map(([check, value]) => [check, String(value)])),
    results: Object.fromEntries(Object.entries(REQUIRED_JOBS).map(([job, check]) => [job, selected[check] ? "success" : "skipped"])),
  };
}

test("the stable required context accepts exactly the actual selected checks", () => {
  for (const selection of [push([landing]), push([backend]), push(["packages/docs/guide.mdx"]), push([snapshot]), push(null), pr([modified(landing)]), pr([modified(backend)])]) {
    assert.doesNotThrow(() => assertSelectedChecks(passingReport(selection)));
  }
});

test("every selection output gates at least one required job", () => {
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

test("a PR that skips the slow suites still requires every unit-test job", () => {
  const report = passingReport(pr([modified(landing)]));
  assert.equal(report.results.den_api, "skipped");
  assert.equal(report.results.desktop_smoke, "skipped");
  for (const job of ["core_app", "core_headless", "core_workbot", "core_den", "core_evals", "core_evals_lint", "desktop_build"]) {
    assert.equal(report.results[job], "success");
    assert.throws(() => assertSelectedChecks({ ...report, results: { ...report.results, [job]: "skipped" } }), new RegExp(job));
  }
});

test("classification and independent static failures cannot green-skip the merge gate", () => {
  const report = passingReport(push([landing]));
  for (const key of ["classification", "staticChecks"]) {
    for (const result of ["skipped", "cancelled", "failure", "", undefined]) assert.throws(() => assertSelectedChecks({ ...report, [key]: result }), /blocking merge/);
  }
  for (const [key, drop] of [["selected", "docs"], ["results", "core_evals"]]) {
    const missing = { ...report[key] };
    delete missing[drop];
    assert.throws(() => assertSelectedChecks({ ...report, [key]: missing }), /Missing or unexpected/);
    assert.throws(() => assertSelectedChecks({ ...report, [key]: { ...report[key], unknown: "skipped" } }), /Missing or unexpected/);
  }
  for (const value of ["", "TRUE", undefined, null, 0]) assert.throws(() => assertSelectedChecks({ ...report, selected: { ...report.selected, core: value } }), /Invalid selection/);
});

const workflow = readFileSync(new URL("../workflows/ci-tests.yml", import.meta.url), "utf8");
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name}`);
  const body = workflow.slice(start + 1);
  const end = body.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return end === -1 ? body : body.slice(0, end + 1);
}

test("cheap source guards have no unrelated install/build/classification dependency", () => {
  const staticJob = job("static-checks");
  assert.doesNotMatch(staticJob, /\bneeds:|setup-tests|pnpm install|\bbuild:|continue-on-error/);
  assert.doesNotMatch(staticJob, /^    if:/m);
  for (const command of [
    "node --test .github/scripts/contributor-pr.test.mjs .github/scripts/contributor-screen.test.mjs .github/scripts/warden-check.test.mjs .github/scripts/warden-report.test.mjs .github/scripts/warden-fast.test.mjs .github/scripts/setup-browser.test.mjs",
    "node --test .github/scripts/pr-proof-review-build.test.mjs .github/scripts/pr-proof-selection.test.mjs .github/scripts/ci-time-to-green.test.mjs evals/scripts/engine-parity-binaries.test.mjs evals/scripts/run-parity-proof.test.mjs",
    "node --test scripts/ci/codeql-config.test.mjs scripts/ci/check-codeql-results.test.mjs",
    "node scripts/check-outbound-access.mjs",
  ]) {
    assert.ok(staticJob.includes(command), command);
    assert.equal(workflow.split(command).length - 1, 1, `each relocated assertion runs exactly once: ${command}`);
  }
  assert.ok(job("openwork-tests-required").includes("static-checks"));
});

test("jobs and the required context consume each real boolean, not a shared full lane", () => {
  const jobs = {
    core_app: "openwork-tests-app", core_headless: "openwork-tests-headless", core_workbot: "openwork-tests-workbot",
    core_den: "openwork-tests-den", core_evals: "openwork-tests-evals", core_evals_lint: "openwork-tests-evals-lint",
    desktop_build: "openwork-tests-desktop-build", desktop_smoke: "openwork-tests-build", den_api: "den-api-security",
    snapshot: "validate-models-snapshot", docs: "validate-docs", den_contract: "den-contract",
  };
  assert.deepEqual(Object.keys(jobs).sort(), Object.keys(REQUIRED_JOBS).sort());
  const required = job("openwork-tests-required");
  for (const [key, name] of Object.entries(jobs)) {
    const output = REQUIRED_JOBS[key];
    assert.ok(job(name).includes(`if: needs.classify-changes.outputs.${output} == 'true'`), name);
    assert.ok(job("classify-changes").includes(`${output}: \${{ steps.classify.outputs.${output} }}`), output);
    assert.ok(required.includes(`needs.classify-changes.outputs.${output}`), output);
    assert.ok(required.includes(`needs.${name}.result`), name);
    assert.match(required, new RegExp(`\\b${key}: env\\.`), key);
    assert.ok(required.match(/needs: \[([^\]]+)\]/)[1].split(", ").includes(name), name);
  }
  assert.match(required, /if: always\(\)/);
  assert.match(required, /assertSelectedChecks\(checks\)/);
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
