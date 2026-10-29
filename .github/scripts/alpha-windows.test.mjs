import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shouldPublishWindowsAlpha } from "../../scripts/release/check-windows-alpha-version.mjs";
import { selectAlphaAssetsToPrune } from "../../scripts/release/prune-alpha-assets.mjs";

const workflow = readFileSync(new URL("../workflows/alpha-macos-aarch64.yml", import.meta.url), "utf8");
const windows = workflow.split("\n  publish-alpha-windows-x64:\n")[1];

function stepScript(name) {
  const step = windows.split(`      - name: ${name}\n`)[1]?.split("\n      - name:")[0];
  const script = step?.split("        run: |\n")[1];
  assert.ok(script, `Missing shell script for ${name}`);
  return script.split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}

function fixture(body) {
  const directory = mkdtempSync(join(tmpdir(), "alpha-windows-"));
  const receipt = join(directory, "receipt.jsonl");
  const dist = join(directory, "apps/desktop/dist-electron");
  const version = "0.20.1-alpha.123.1+abcdef0";
  // Electron Builder strips semver +build metadata from ${version} filenames.
  const artifactVersion = version.split("+")[0];
  const installer = `openwork-win-x64-${artifactVersion}.exe`;
  mkdirSync(dist, { recursive: true });
  mkdirSync(join(directory, "scripts/release"), { recursive: true });
  writeFileSync(join(directory, "scripts/release/check-windows-alpha-version.mjs"), readFileSync(new URL("../../scripts/release/check-windows-alpha-version.mjs", import.meta.url)));
  for (const name of [installer, `${installer}.blockmap`, "latest.yml"]) {
    writeFileSync(join(dist, name), "fixture");
  }
  writeFileSync(join(directory, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RECEIPT, JSON.stringify(args) + '\\n');
if (args[1] === 'view') { console.log(process.env.ASSET_NAMES || ''); process.exit(Number(process.env.VIEW_EXIT || 0)); }
if (args[1] === 'upload' && !args.some(arg => arg.endsWith('/latest.yml'))) process.exit(Number(process.env.UPLOAD_EXIT || 0));
`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    RECEIPT: receipt,
    CHANNEL_TAG: "alpha-windows-latest",
    GITHUB_REPOSITORY: "example/repo",
    GITHUB_SHA: "abcdef0",
    GITHUB_OUTPUT: join(directory, "github-output"),
    ALPHA_COMMIT: "abcdef0",
    ALPHA_BUILD_STARTED_AT: "2026-10-20T12:00:00Z",
    ALPHA_VERSION: artifactVersion,
    ALPHA_RELEASE_NAME: "OpenWork Alpha (Windows x64)",
  };
  const run = (script, overrides = {}) => spawnSync("bash", ["-c", script], {
    cwd: directory, encoding: "utf8", env: { ...env, ...overrides },
  });
  const calls = () => {
    try {
      return readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  try {
    body({ directory, dist, installer, run, calls });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const publish = stepScript("Publish Windows alpha build to rolling release");
const guard = stepScript("Validate Windows alpha channel tag");

test("channel guard accepts Windows alpha only, without executing input", () => {
  fixture(({ run, calls }) => {
    for (const tag of ["alpha-windows-latest", "alpha-windows-staging"]) {
      assert.equal(run(guard, { CHANNEL_TAG: tag }).status, 0);
    }
    for (const tag of ["v0.20.0", "alpha-macos-latest", "", "$(exit 0)"]) {
      assert.notEqual(run(guard, { CHANNEL_TAG: tag }).status, 0);
    }
    assert.deepEqual(calls(), []);
  });
});

test("publishes labeled installer and blockmap before the rolling manifest", () => {
  fixture(({ run, calls, installer }) => {
    const result = run(publish, { VIEW_EXIT: "1" });
    assert.equal(result.status, 0, result.stderr);
    const commands = calls();
    assert.deepEqual(commands.map(args => args.slice(0, 2)), [
      ["release", "view"], ["release", "create"], ["release", "upload"], ["release", "upload"],
    ]);
    assert.ok(commands[1].includes("--prerelease"));
    assert.ok(commands[1].includes("--latest=false"));
    assert.ok(commands[2].some(arg => arg.includes(`${installer}#`) && arg.includes("commit abcdef0; build started")));
    assert.ok(commands[2].some(arg => arg.includes(`${installer}.blockmap#`)));
    assert.ok(!commands[2].includes("--clobber"));
    assert.ok(commands[3].includes("--clobber"));
    assert.ok(commands[3].includes("apps/desktop/dist-electron/latest.yml"));
    assert.ok(commands.every(args => args.includes("alpha-windows-latest")));
  });
});

test("an existing rolling release is reused", () => {
  fixture(({ run, calls }) => {
    assert.equal(run(publish).status, 0);
    assert.equal(calls().filter(args => args[1] === "create").length, 0);
  });
});

test("older or identical publications do not upload or authorize pruning", () => {
  fixture(({ run, calls, directory, installer }) => {
    const result = run(publish, { ASSET_NAMES: `${installer}\nopenwork-win-x64-0.20.1-alpha.124.1+abcdef0.exe` });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls().map(args => args.slice(0, 2)), [["release", "view"]]);
    assert.throws(() => readFileSync(join(directory, "github-output")), { code: "ENOENT" });
  });
});

test("failed asset upload never advances the manifest", () => {
  fixture(({ run, calls }) => {
    assert.equal(run(publish, { UPLOAD_EXIT: "7" }).status, 7);
    assert.equal(calls().filter(args => args[1] === "upload").length, 1);
    assert.ok(calls().every(args => !args.includes("apps/desktop/dist-electron/latest.yml")));
  });
});

test("missing installer, blockmap or manifest fails before GitHub writes", () => {
  for (const missing of ["installer", "blockmap", "manifest"]) {
    fixture(({ dist, installer, run, calls }) => {
      const name = missing === "manifest" ? "latest.yml" : `${installer}${missing === "blockmap" ? ".blockmap" : ""}`;
      rmSync(join(dist, name));
      const result = run(publish);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Missing Windows alpha asset/);
      assert.deepEqual(calls(), []);
    });
  }
});

test("Windows uses x64 sidecars and signed bytes, retaining build-only dispatch artifacts", () => {
  assert.match(windows, /environment: windows-signing/);
  assert.match(windows, /id-token: write/);
  assert.match(windows, /TARGET: x86_64-pc-windows-msvc/);
  assert.match(windows, /--win --x64/);
  assert.match(windows, /--config.detectUpdateChannel=false/);
  assert.match(windows, /bun-version: "1\.3\.10"/);
  assert.match(windows, /Get-AuthenticodeSignature/);
  assert.match(windows, /\$signature.Status -ne "Valid"/);
  assert.ok(windows.indexOf("name: Verify Windows signature") < windows.indexOf("name: Refresh signed installer"));
  assert.ok(windows.indexOf("name: Refresh signed installer") < windows.indexOf("name: Publish Windows alpha"));
  assert.match(windows, /if: github.event_name == 'workflow_dispatch' && inputs.publish != true/);
  assert.match(windows, /if: github.event_name == 'push' \|\| inputs.publish == true/);
  assert.match(windows, /--keep 100/);
  assert.match(windows, /inputs.platform != 'macos-arm64'/);
  assert.match(workflow, /inputs.platform != 'windows-x64'/);
  assert.match(windows, /GITHUB_RUN_NUMBER\}\.\$\{GITHUB_RUN_ATTEMPT/);
  assert.match(windows, /echo "artifact_version=\$\{version\}"/);
  assert.equal(windows.match(/ALPHA_VERSION: \$\{\{ steps.alpha-version.outputs.artifact_version \}\}/g)?.length, 2);
  assert.equal(windows.match(/ALPHA_VERSION: \$\{\{ steps.alpha-version.outputs.alpha_version \}\}/g)?.length, 1);
  assert.match(windows, /steps.publish-windows.outputs.published == 'true'/);
  assert.match(windows, /--protect-run "\$GITHUB_RUN_NUMBER"/);
  assert.match(workflow, /group: alpha-macos-\$\{\{ inputs.channel_tag/);
});

test("numeric alpha precedence handles attempts, metadata, and stable patch changes", () => {
  const asset = version => `openwork-win-x64-${version}.exe`;
  assert.equal(shouldPublishWindowsAlpha("0.20.1-alpha.10.2+abcd", [asset("0.20.1-alpha.10.1+ffff")]), true);
  assert.equal(shouldPublishWindowsAlpha("0.20.1-alpha.10.1+abcd", [asset("0.20.1-alpha.10.1+ffff")]), false);
  assert.equal(shouldPublishWindowsAlpha("0.20.1-alpha.10.1", [asset("0.20.1-alpha.9")]), true);
  assert.equal(shouldPublishWindowsAlpha("0.20.1-alpha.9.10", [asset("0.20.1-alpha.10.1")]), false);
  assert.equal(shouldPublishWindowsAlpha("0.20.2-alpha.1.1", [asset("0.20.1-alpha.1000.1")]), true);
  assert.throws(() => shouldPublishWindowsAlpha("0.0.0-dev", []), /Unsupported/);
  assert.throws(() => shouldPublishWindowsAlpha("0.20.1-alpha.10.1", [asset("unexpected")]), /Unsupported/);
});

test("pruning retains the just-published run even outside the retention window", () => {
  const assets = [1, 2, 3, 4].flatMap(run => ["exe", "exe.blockmap"].map(ext => ({ name: `openwork-win-x64-0.20.1-alpha.${run}.1+abcd.${ext}` })));
  assets.push({ name: "latest.yml" });
  assert.deepEqual(selectAlphaAssetsToPrune(assets, 2, 1), assets.slice(2, 4));
  assert.deepEqual(selectAlphaAssetsToPrune(assets, 2), assets.slice(0, 4));
});
