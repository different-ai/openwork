import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bundledEngineEnv, commandMatchesPackagedSidecar } from "../electron/runtime.mjs";

const require = createRequire(import.meta.url);
const { canonicalizeSidecars } = require("../scripts/electron-after-pack.cjs");
const { Arch } = require("electron-builder");
const targets = [
  ["win32", "x64", "x86_64-pc-windows-msvc"],
  ["win32", "arm64", "aarch64-pc-windows-msvc"],
  ["darwin", "arm64", "aarch64-apple-darwin"],
  ["darwin", "x64", "x86_64-apple-darwin"],
  ["linux", "x64", "x86_64-unknown-linux-gnu"],
  ["linux", "arm64", "aarch64-unknown-linux-gnu"],
];

function fixture(t, platform) {
  const root = mkdtempSync(path.join(tmpdir(), "openwork-sidecar-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = platform === "darwin"
    ? path.join(root, "OpenWork.app", "Contents", "Resources", "sidecars")
    : path.join(root, "resources", "sidecars");
  mkdirSync(directory, { recursive: true });
  return { root, directory };
}

for (const [platform, arch, triple] of targets) {
  const ext = platform === "win32" ? ".exe" : "";
  test(`${platform}/${arch}: packaging ships one canonical copy and target metadata`, (t) => {
    const { root, directory } = fixture(t, platform);
    const payloads = [Buffer.alloc(123, 1), Buffer.alloc(456, 2)];
    for (const [index, base] of ["opencode", "opencode2"].entries()) {
      writeFileSync(path.join(directory, `${base}-${triple}${ext}`), payloads[index]);
      writeFileSync(path.join(directory, `${base}${ext}`), "stale alias");
      writeFileSync(path.join(directory, `${base}-foreign${ext}`), "foreign");
    }
    writeFileSync(path.join(directory, `versions.json-${triple}`), '{"target":"correct"}');
    writeFileSync(path.join(directory, "versions.json"), '{"target":"stale"}');
    canonicalizeSidecars({ appOutDir: root, electronPlatformName: platform, arch: Arch[arch] });
    assert.deepEqual(readdirSync(directory).sort(), [`opencode${ext}`, `opencode2${ext}`, "versions.json"].sort());
    for (const [index, base] of ["opencode", "opencode2"].entries()) {
      assert.deepEqual(readFileSync(path.join(directory, `${base}${ext}`)), payloads[index]);
      assert.equal(statSync(path.join(directory, `${base}${ext}`)).size, payloads[index].length);
    }
    assert.equal(readFileSync(path.join(directory, "versions.json"), "utf8"), '{"target":"correct"}');
    assert.deepEqual(bundledEngineEnv([directory], { required: true, platform, arch }), {
      OPENWORK_OPENCODE_BIN: path.join(directory, `opencode${ext}`),
      OPENWORK_OPENCODE2_BIN: path.join(directory, `opencode2${ext}`),
    });
  });

  test(`${platform}/${arch}: resolution supports canonical, legacy-only, and both layouts`, (t) => {
    const { directory } = fixture(t, platform);
    const options = { required: true, platform, arch };
    assert.throws(() => bundledEngineEnv([directory], options), /Missing packaged engine opencode\. Checked:/);
    assert.deepEqual(bundledEngineEnv([directory], { platform, arch }), {});
    for (const base of ["opencode", "opencode2"]) {
      writeFileSync(path.join(directory, `${base}-${triple}${ext}`), "legacy");
    }
    assert.equal(bundledEngineEnv([directory], options).OPENWORK_OPENCODE2_BIN, path.join(directory, `opencode2-${triple}${ext}`));
    for (const base of ["opencode", "opencode2"]) writeFileSync(path.join(directory, `${base}${ext}`), "canonical");
    assert.equal(bundledEngineEnv([directory], options).OPENWORK_OPENCODE2_BIN, path.join(directory, `opencode2${ext}`));
    rmSync(path.join(directory, `opencode2${ext}`));
    rmSync(path.join(directory, `opencode2-${triple}${ext}`));
    mkdirSync(path.join(directory, `opencode2${ext}`));
    assert.throws(() => bundledEngineEnv([directory], options), /Missing packaged engine opencode2/);
  });

  test(`${platform}/${arch}: packaging fails rather than shipping missing engines or metadata`, (t) => {
    const { root, directory } = fixture(t, platform);
    const context = { appOutDir: root, electronPlatformName: platform, arch };
    assert.throws(() => canonicalizeSidecars(context), /Missing packaged sidecar for target: opencode-/);
    writeFileSync(path.join(directory, `opencode-${triple}${ext}`), "v1");
    assert.throws(() => canonicalizeSidecars(context), /Missing packaged sidecar for target: opencode2-/);
    writeFileSync(path.join(directory, `opencode-${triple}${ext}`), "v1");
    writeFileSync(path.join(directory, `opencode2-${triple}${ext}`), "v2");
    assert.throws(() => canonicalizeSidecars(context), /Missing packaged sidecar metadata/);
    rmSync(directory, { recursive: true });
    assert.throws(() => canonicalizeSidecars(context), /Missing packaged sidecars directory/);
  });
}

test("orphan detection recognizes canonical and legacy names without matching another install", () => {
  for (const binary of ["opencode", "opencode2", "opencode-aarch64-apple-darwin", "opencode2-x86_64-pc-windows-msvc.exe"]) {
    assert.equal(commandMatchesPackagedSidecar(`/install/sidecars/${binary} serve --port 1234`, ["/install/sidecars"]), true);
    assert.equal(commandMatchesPackagedSidecar(`/other/sidecars/${binary} serve`, ["/install/sidecars"]), false);
  }
});
