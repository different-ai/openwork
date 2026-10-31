import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { APP_SMOKE, buildFingerprint, buildInputPatterns, changedFiles, isBuildAffected } from "./build-inputs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const images = ["den-api", "den-web", "inference", "client-web", "headless-runner", "workbot"];
const targets = [...images, "native-den-api", "native-inference", "native-workbot", "desktop", "desktop-smoke", "core", "runtime", "sdk", "den-contract", "den-api-tests", "desktop-package", "api-docs", "i18n", "review", "helm", "swift"];

for (const target of targets) {
  test(`landing content is not a ${target} input`, () => {
    assert.equal(isBuildAffected(target, ["ee/apps/landing/components/roadmap-page.tsx"]), false);
  });
  test(`${target} builds when comparison is unknown`, () => {
    assert.equal(isBuildAffected(target, null), true);
    assert.equal(isBuildAffected(target, [{ filename: "ee/apps/landing/page.tsx" }]), true);
    assert.equal(isBuildAffected(target, ["../unknown"]), true);
  });
}

test("native Electron changes do not rebuild cloud products or their runtime snapshot", () => {
  const files = ["apps/desktop/electron/keep-awake.mjs"];
  for (const target of [...images, "native-den-api", "native-inference", "native-workbot", "runtime"]) {
    assert.equal(isBuildAffected(target, files), false, target);
  }
  assert.equal(isBuildAffected("desktop", files), true);
  assert.equal(isBuildAffected("desktop-smoke", files), true);
});

test("App UI is shared by desktop, hosted web client and worker snapshot, not every backend", () => {
  const files = ["apps/app/src/react-app/domains/session/session.tsx"];
  for (const target of ["desktop", "desktop-smoke", "client-web", "runtime", "core", "i18n"]) {
    assert.equal(isBuildAffected(target, files), true, target);
  }
  for (const target of ["den-api", "den-web", "inference", "headless-runner", "workbot", "native-den-api"]) {
    assert.equal(isBuildAffected(target, files), false, target);
  }
});

test("backend-specific changes stay in the backend and its contract checks", () => {
  const files = ["ee/apps/den-api/src/routes/org/automations.ts"];
  for (const target of ["den-api", "native-den-api", "core", "den-contract", "sdk", "api-docs"]) {
    assert.equal(isBuildAffected(target, files), true, target);
  }
  for (const target of ["desktop", "desktop-smoke", "client-web", "runtime", "den-web", "inference", "workbot"]) {
    assert.equal(isBuildAffected(target, files), false, target);
  }
});

test("shared types and dependency configuration fan out to every consumer", () => {
  for (const target of [...images, "desktop", "runtime", "sdk", "review"]) {
    // Review does not use types, but toolchain changes still invalidate it.
    if (target !== "review") assert.equal(isBuildAffected(target, ["packages/types/src/den/workers.ts"]), true, target);
    assert.equal(isBuildAffected(target, ["pnpm-lock.yaml"]), true, target);
    assert.equal(isBuildAffected(target, ["patches/example.patch"]), true, target);
  }
});

test("native Render scopes do not accidentally include unrelated Docker recipes", () => {
  for (const target of ["native-den-api", "native-inference", "native-workbot"]) {
    assert.equal(isBuildAffected(target, ["packaging/docker/Dockerfile.den"]), false, target);
    assert.equal(isBuildAffected(target, [".github/scripts/render-build-filters.mjs"]), true, target);
  }
  assert.equal(isBuildAffected("native-den-api", ["apps/desktop/package.json"]), true);
  assert.equal(isBuildAffected("native-den-api", ["apps/desktop/electron/main.mjs"]), false);
  assert.equal(isBuildAffected("client-web", ["packaging/docker/Dockerfile.den-gateway"]), true);
});

test("the direct server sandbox import and desktop bundled plugin are explicit edges", () => {
  assert.equal(isBuildAffected("client-web", ["apps/server/src/mcp-app-sandbox.ts"]), true);
  assert.equal(isBuildAffected("client-web", ["apps/server/src/server.ts"]), false);
  assert.equal(isBuildAffected("desktop", ["packages/opencode-plugin/server.ts"]), true);
  assert.equal(isBuildAffected("runtime", ["packages/opencode-plugin/server.ts"]), true);
});

test("embedded docs text ships in desktop, docs screenshots do not", () => {
  for (const file of ["packages/docs/README.md", "packages/docs/slack/connect-slack.mdx", "packages/docs/docs.json"]) {
    assert.equal(isBuildAffected("desktop", [file]), true, file);
    assert.equal(isBuildAffected("desktop-smoke", [file]), true, file);
    assert.equal(isBuildAffected("docs", [file]), true, file);
    for (const target of [...images, "runtime", "sdk"]) assert.equal(isBuildAffected(target, [file]), false, `${target}: ${file}`);
  }
  const screenshot = ["packages/docs/images/slack/step.png"];
  assert.equal(isBuildAffected("docs", screenshot), true);
  for (const target of [...images, "desktop", "desktop-smoke", "runtime", "sdk"]) assert.equal(isBuildAffected(target, screenshot), false, target);
});

test("review CSS and runner cross-workspace assets remain watched", () => {
  assert.equal(isBuildAffected("review", ["apps/app/src/styles/colors.css"]), true);
  for (const file of ["packages/workbook/src/index.ts", "packages/sandbox-freestyle/src/index.ts", "packages/sandbox-differently/src/index.ts", "ee/apps/den-worker-runtime/scripts/cloud-desktop.sh"]) {
    assert.equal(isBuildAffected("headless-runner", [file]), true, file);
  }
});

test("Swift changes and scanning configuration still select real Swift work", () => {
  for (const file of ["packages/computer-use/native/Package.swift", ".github/codeql/codeql-config.yml", ".github/workflows/codeql.yml"]) {
    assert.equal(isBuildAffected("swift", [file]), true, file);
  }
  assert.equal(isBuildAffected("swift", ["packages/computer-use/index.ts"]), false);
});

test("each job watches its own script, workflow and shared declaration inputs", () => {
  for (const target of images) {
    assert.equal(isBuildAffected(target, [".github/workflows/publish-ee-images.yml"]), true, target);
    assert.equal(isBuildAffected(target, [".github/scripts/ee-image-inputs.mjs"]), true, target);
  }
  for (const target of targets) assert.equal(isBuildAffected(target, [".github/scripts/build-inputs.mjs"]), true, target);
  assert.equal(isBuildAffected("den-contract", [".github/workflows/ci-tests.yml"]), true);
  assert.equal(isBuildAffected("desktop-smoke", ["docs/enterprise/outbound-access.json"]), false);
});

test("an unrelated dev run cannot replace pending core verification", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci-tests.yml"), "utf8");
  assert.match(workflow, /group: openwork-tests-.*github\.event\.pull_request\.number \|\| github\.run_id/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
});

test("workspace discovery stays aligned with the pnpm workspace declarations", () => {
  const content = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const section = content.match(/^packages:\s*\n((?:[ \t]+.*\n|\n)*)/m)?.[1];
  assert.ok(section, "workspace package patterns must be explicit");
  const patterns = [...section.matchAll(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(patterns.sort(), ["apps/*", "ee/apps/*", "ee/packages/*", "packages/*"], "update workspace discovery before adding another workspace root");
});

test("target declarations are positive provider-compatible globs, not broad repository roots", () => {
  for (const target of targets) {
    const patterns = buildInputPatterns(target);
    assert.equal(new Set(patterns).size, patterns.length, target);
    assert.ok(patterns.length > 0, target);
    assert.ok(patterns.every((pattern) => !pattern.startsWith("!") && !pattern.startsWith("/")), target);
    assert.ok(!patterns.includes("**") && !patterns.includes("packages/**") && !patterns.includes("ee/**"), target);
  }
  assert.throws(() => buildInputPatterns("not-a-target"), /Unknown build target/);
});

const scratch = mkdtempSync(join(tmpdir(), "openwork-build-inputs-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
function put(path, body) {
  mkdirSync(dirname(join(scratch, path)), { recursive: true });
  writeFileSync(join(scratch, path), body);
}
function git(...args) {
  return execFileSync("git", args, { cwd: scratch, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function commit(message) {
  git("add", ".");
  git("-c", "user.name=CI Fixture", "-c", "user.email=ci@example.invalid", "commit", "--quiet", "-m", message);
  return git("rev-parse", "HEAD");
}

test("fingerprints compare source inputs, not commit identity; diffs include the whole range", () => {
  git("init", "--quiet");
  put("package.json", JSON.stringify({ private: true, packageManager: "pnpm@11.4.0" }));
  put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  put("ee/apps/workbot/package.json", JSON.stringify({ name: "@openwork-ee/workbot", dependencies: { "@openwork/types": "workspace:*" } }));
  put("packages/types/package.json", JSON.stringify({ name: "@openwork/types" }));
  put("packages/types/src/index.ts", "export const value = 1\n");
  put("ee/apps/workbot/src/server.ts", "export const start = 1\n");
  const base = commit("base");
  const original = buildFingerprint("native-workbot", { root: scratch, ref: base });
  put("ee/apps/landing/page.tsx", "landing only\n");
  const landing = commit("landing");
  assert.notEqual(base, landing);
  assert.equal(buildFingerprint("native-workbot", { root: scratch, ref: landing }), original);
  put("packages/types/src/index.ts", "export const value = 2\n");
  const changed = commit("shared source");
  assert.notEqual(buildFingerprint("native-workbot", { root: scratch, ref: changed }), original);
  git("mv", "ee/apps/workbot/src/server.ts", "ee/apps/workbot/src/renamed.ts");
  rmSync(join(scratch, "packages/types/src/index.ts"));
  const renamed = commit("rename and delete");
  assert.deepEqual(changedFiles({ root: scratch, base, head: renamed }).sort(), [
    "ee/apps/landing/page.tsx", "ee/apps/workbot/src/renamed.ts", "ee/apps/workbot/src/server.ts", "packages/types/src/index.ts",
  ]);
  assert.equal(changedFiles({ root: scratch, base: "0".repeat(40) }), null);
  assert.equal(changedFiles({ root: scratch, base: "missing-revision" }), null);
});

test("workspace dependency edges are discovered, including optional, peer, dev and cycles", () => {
  put("packages/new-shared/package.json", JSON.stringify({ name: "@openwork/new-shared", peerDependencies: { "@openwork/types": "workspace:*" } }));
  put("packages/new-shared/src/index.ts", "export const shared = true\n");
  put("packages/types/package.json", JSON.stringify({ name: "@openwork/types", devDependencies: { "@openwork/new-shared": "workspace:*" } }));
  assert.equal(isBuildAffected("native-workbot", ["packages/new-shared/src/index.ts"], { root: scratch }), true);
  put("packages/types/package.json", JSON.stringify({ name: "@openwork/types", optionalDependencies: { "@openwork/new-shared": "workspace:*" } }));
  const ref = commit("optional shared dependency");
  assert.equal(isBuildAffected("native-workbot", ["packages/new-shared/src/index.ts"], { root: scratch, ref }), true);
  put("packages/types/package.json", JSON.stringify({ name: "@openwork/types", dependencies: { "@openwork/missing": "workspace:*" } }));
  assert.throws(() => buildInputPatterns("native-workbot", { root: scratch }), /Missing workspace dependency/);
});

test("CLI defaults to building on missing history and reports a usable content fingerprint", () => {
  const output = join(scratch, "github-output");
  const stdout = execFileSync(process.execPath, [join(root, ".github/scripts/build-inputs.mjs"), "--target", "native-workbot", "--root", scratch, "--base", "missing-revision", "--head", "HEAD"], {
    encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_EVENT_PATH: "", GITHUB_OUTPUT: output },
  });
  assert.match(stdout, /affected=true/);
  assert.match(readFileSync(output, "utf8"), /fingerprint=[a-f0-9]{64}/);
});

test("the packaged smoke selects every evals file app-smoke imports", () => {
  const seen = new Set();
  const pending = ["evals/core/app-smoke.e2e.test.ts"];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(join(root, file), "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = join(dirname(file), specifier);
      const found = [base, `${base}.ts`, `${base}.mjs`, `${base}/index.ts`].find((candidate) => existsSync(join(root, candidate)) && !candidate.endsWith("/"));
      // Unresolved specifiers are code in strings that runs elsewhere (e.g. a server script).
      if (found && !found.startsWith("evals/packages/")) pending.push(found);
    }
  }
  assert.deepEqual([...seen].sort(), [...APP_SMOKE].sort(), "update APP_SMOKE in build-inputs.mjs");
  for (const file of seen) {
    assert.equal(isBuildAffected("desktop-smoke", [file]), true, file);
    assert.equal(isBuildAffected("desktop-package", [file]), true, file);
  }
});
