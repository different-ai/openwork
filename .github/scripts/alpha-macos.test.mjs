import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shouldPublishAlpha } from "../../scripts/release/check-alpha-version.mjs";

const workflow = readFileSync(new URL("../workflows/alpha-macos-aarch64.yml", import.meta.url), "utf8");
const macPublish = workflow.split("\n  publish-alpha-macos-aarch64:\n")[1]?.split("\n  publish-alpha-windows-x64:\n")[0];
const macBuild = workflow.split("\n  build-alpha-macos-aarch64:\n")[1]?.split("\n  publish-alpha-macos-aarch64:\n")[0];

function stepScript(name) {
  const step = macPublish.split(`      - name: ${name}\n`)[1]?.split("\n      - name:")[0];
  const script = step?.split("        run: |\n")[1];
  assert.ok(script, `Missing shell script for ${name}`);
  return script.split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}

const publish = stepScript("Publish alpha build to rolling release");
const version = "0.20.1-alpha.123";
const assets = [`openwork-mac-arm64-${version}.dmg`, `openwork-mac-arm64-${version}.zip`, `openwork-mac-arm64-${version}.dmg.blockmap`, `openwork-mac-arm64-${version}.zip.blockmap`];

function fixture(body) {
  const directory = mkdtempSync(join(tmpdir(), "alpha-macos-"));
  const receipt = join(directory, "receipt.jsonl");
  const dist = join(directory, "apps/desktop/dist-electron");
  mkdirSync(dist, { recursive: true });
  mkdirSync(join(directory, "scripts/release"), { recursive: true });
  writeFileSync(join(directory, "scripts/release/check-alpha-version.mjs"), readFileSync(new URL("../../scripts/release/check-alpha-version.mjs", import.meta.url)));
  for (const name of [...assets, "latest-mac.yml"]) writeFileSync(join(dist, name), "fixture");
  writeFileSync(join(directory, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RECEIPT, JSON.stringify(args) + '\\n');
if (args[1] === 'view') { console.log(process.env.ASSET_NAMES || ''); process.exit(Number(process.env.VIEW_EXIT || 0)); }
if (args[1] === 'upload' && !args.some(arg => arg.endsWith('/latest-mac.yml'))) process.exit(Number(process.env.UPLOAD_EXIT || 0));
`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    RECEIPT: receipt,
    CHANNEL_TAG: "alpha-macos-latest",
    GITHUB_REPOSITORY: "example/repo",
    GITHUB_SHA: "abcdef0",
    GITHUB_OUTPUT: join(directory, "github-output"),
    ALPHA_COMMIT: "abcdef0",
    ALPHA_BUILD_STARTED_AT: "2026-11-03T12:00:00Z",
    ALPHA_VERSION: version,
    ALPHA_RELEASE_NAME: "OpenWork Alpha (macOS arm64)",
  };
  const run = (overrides = {}) => spawnSync("bash", ["-c", publish], { cwd: directory, encoding: "utf8", env: { ...env, ...overrides } });
  const calls = () => {
    try {
      return readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  try {
    body({ directory, dist, run, calls });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("publishes labeled assets before the rolling manifest and authorizes pruning", () => {
  fixture(({ run, calls, directory }) => {
    const result = run({ ASSET_NAMES: "openwork-mac-arm64-0.20.1-alpha.122.zip" });
    assert.equal(result.status, 0, result.stderr);
    const commands = calls();
    assert.deepEqual(commands.map(args => args.slice(0, 2)), [["release", "view"], ["release", "upload"], ["release", "upload"]]);
    for (const name of assets) {
      assert.ok(commands[1].some(arg => arg.includes(`${name}#${name} (commit abcdef0; build started`)), name);
    }
    assert.ok(commands[2].includes("apps/desktop/dist-electron/latest-mac.yml"));
    assert.ok(commands.slice(1).every(args => args.includes("--clobber")));
    assert.match(readFileSync(join(directory, "github-output"), "utf8"), /published=true/);
  });
});

test("creates the rolling prerelease when it does not exist", () => {
  fixture(({ run, calls }) => {
    assert.equal(run({ VIEW_EXIT: "1" }).status, 0);
    const create = calls().find(args => args[1] === "create");
    assert.ok(create?.includes("--prerelease"));
  });
});

test("a build that finishes after a newer one never moves the feed back", () => {
  fixture(({ run, calls, directory }) => {
    const result = run({ ASSET_NAMES: "openwork-mac-arm64-0.20.1-alpha.124.zip" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls().map(args => args.slice(0, 2)), [["release", "view"]]);
    assert.throws(() => readFileSync(join(directory, "github-output")), { code: "ENOENT" });
  });
});

test("failed asset upload never advances the manifest", () => {
  fixture(({ run, calls }) => {
    assert.equal(run({ UPLOAD_EXIT: "7" }).status, 7);
    assert.ok(calls().every(args => !args.includes("apps/desktop/dist-electron/latest-mac.yml")));
  });
});

test("only alpha macOS tags are accepted, and a missing manifest fails before GitHub writes", () => {
  fixture(({ run, calls, dist }) => {
    for (const tag of ["v0.20.0", "alpha-windows-latest", ""]) assert.notEqual(run({ CHANNEL_TAG: tag }).status, 0);
    rmSync(join(dist, "latest-mac.yml"));
    assert.notEqual(run().status, 0);
    assert.deepEqual(calls(), []);
  });
});

test("the signed build hands its assets and version to the publish job", () => {
  assert.match(macBuild, /artifact_version: \$\{\{ steps\.alpha-version\.outputs\.artifact_version \}\}/);
  assert.match(macBuild, /echo "artifact_version=\$\{base\}-alpha\.\$\{run\}"$/m);
  assert.match(macBuild, /name: openwork-alpha-macos-arm64/);
  assert.match(macBuild, /latest-mac\.yml/);
  assert.match(macBuild, /if-no-files-found: error/);
  assert.match(macPublish, /name: openwork-alpha-macos-arm64\n          path: apps\/desktop\/dist-electron/);
  assert.match(macPublish, /ALPHA_VERSION: \$\{\{ needs\.build-alpha-macos-aarch64\.outputs\.artifact_version \}\}/);
  assert.match(macPublish, /if: steps\.publish-macos\.outputs\.published == 'true'/);
  assert.match(macPublish, /--keep 100 --protect-run "\$GITHUB_RUN_NUMBER"/);
});

test("macOS republishes its own run but never an older one", () => {
  const zip = value => `openwork-mac-arm64-${value}.zip`;
  assert.equal(shouldPublishAlpha("mac", "0.20.1-alpha.10", [zip("0.20.1-alpha.10")]), true);
  assert.equal(shouldPublishAlpha("mac", "0.20.1-alpha.10", [zip("0.20.1-alpha.9"), "latest-mac.yml"]), true);
  assert.equal(shouldPublishAlpha("mac", "0.20.1-alpha.9", [zip("0.20.1-alpha.10")]), false);
  assert.equal(shouldPublishAlpha("mac", "0.20.2-alpha.1", [zip("0.20.1-alpha.1000")]), true);
  assert.equal(shouldPublishAlpha("mac", "0.20.1-alpha.10", ["openwork-win-x64-0.20.1-alpha.11.1.exe"]), true);
  assert.throws(() => shouldPublishAlpha("linux", "0.20.1-alpha.10", []), /Unknown alpha platform/);
});
