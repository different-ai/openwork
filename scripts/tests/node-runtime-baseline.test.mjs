import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const baseline = "24.22.1";
const engine = ">=24.22.1 <25";

// These are deployment roots, not dependencies' compatibility declarations.
const deploymentRoots = [
  "", "apps/app/", "apps/review/", "apps/server/",
  "ee/apps/den-api/", "ee/apps/den-gateway/", "ee/apps/den-web/",
  "ee/apps/diagnostics/", "ee/apps/gateway/", "ee/apps/headless-runner/",
  "ee/apps/landing/", "ee/apps/workbot/", "evals/packages/open-workplace/",
  "packages/openwork-bootstrap/",
];

test("local development and deployment package engines share the patched Node 24 baseline", () => {
  assert.equal(read(".nvmrc").trim(), baseline);
  for (const directory of deploymentRoots) {
    const path = `${directory}package.json`;
    assert.equal(JSON.parse(read(path)).engines?.node, engine, path);
  }
});

test("all first-party Docker Node bases pin the security release", () => {
  let count = 0;
  for (const path of tracked.filter((path) => /(^|\/)Dockerfile(?:[./]|$)/.test(path))) {
    for (const match of read(path).matchAll(/^FROM\s+(?:--platform=\S+\s+)?(node:\S+)/gm)) {
      assert.match(match[1], /^node:24\.22\.1-bookworm(?:-slim)?(?:@sha256:[a-f0-9]{64})?$/, path);
      count++;
    }
  }
  assert.ok(count >= 10, "check actual runtime Dockerfiles, not an empty file set");
});

test("GitHub standalone Node jobs and runtime matrices pin the security release", () => {
  let count = 0;
  for (const path of tracked.filter((path) => path.startsWith(".github/") && /\.ya?ml$/.test(path))) {
    for (const match of read(path).matchAll(/^\s*node-version:\s*([^\n#]+)/gm)) {
      const value = match[1].trim();
      if (value.startsWith("${{")) continue;
      assert.equal(value.replace(/^["']|["']$/g, ""), baseline, path);
      count++;
    }
  }
  assert.ok(count >= 50, "cover all workflow/action runtime pins");
  const release = read(".github/workflows/release-macos-aarch64.yml");
  for (const match of release.matchAll(/^\s+node:\s*"([^"]+)"/gm)) assert.equal(match[1], baseline);
});

test("image publication uses an immutable setup-node action", () => {
  const workflow = read(".github/workflows/publish-ee-images.yml");
  const refs = [...workflow.matchAll(/uses:\s*actions\/setup-node@([^\s#]+)/g)];
  assert.ok(refs.length > 0, "check the Node setup step before publication checks");
  for (const [, ref] of refs) assert.match(ref, /^[a-f0-9]{40}$/, "package-write workflows must not use mutable action refs");
});

test("standalone Undici imports and overrides use the security releases", () => {
  for (const [directory, version] of [
    ["apps/desktop", "6.29.1"], ["apps/server", "6.29.1"],
    ["ee/apps/den-api", "7.30.1"], ["ee/apps/den-gateway", "7.30.1"],
  ]) assert.equal(JSON.parse(read(`${directory}/package.json`)).dependencies.undici, version, directory);
  const workspace = read("pnpm-workspace.yaml");
  assert.ok(workspace.includes('"undici@>=6.0.0 <6.29.1": 6.29.1'));
  assert.ok(workspace.includes('"undici@>=7.0.0 <7.30.1": 7.30.1'));
  const lock = read("pnpm-lock.yaml");
  assert.doesNotMatch(lock, /undici@(?:6\.28\.1|7\.29\.1)/);
});
