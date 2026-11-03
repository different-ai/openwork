import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MIN_NODE_VERSION, nodeVersionSupported } from "../bin/platform.mjs";

const accepted = ["24.22.1", "v24.22.1", "24.22.2", "24.23.0", "24.100.0"];
const rejected = ["20.20.0", "22.13.0", "22.99.0", "23.4.0", "24.0.0", "24.18.0", "24.21.99", "24.22.0", "25.0.0", "26.0.0", "99.0.0", "24.22", "24.022.1", "24.22.1-rc.1", "24.22.1+build", "24.22.1.0", "garbage", ""];

test("the package engine and runtime minimum use the same security baseline", () => {
  assert.equal(MIN_NODE_VERSION, "24.22.1");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines.node, ">=24.22.1 <25");
});
for (const version of accepted) test(`accepts stable patched Node ${version}`, () => assert.equal(nodeVersionSupported(version), true));
for (const version of rejected) test(`rejects Node ${JSON.stringify(version)}`, () => assert.equal(nodeVersionSupported(version), false));

test("published launcher rejects unsupported runtimes before importing its bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "server-node-gate-"));
  try {
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "dist"));
    for (const file of ["platform.mjs", "openwork-server.mjs"]) copyFileSync(new URL(`../bin/${file}`, import.meta.url), join(dir, "bin", file));
    writeFileSync(join(dir, "dist/openwork-server.mjs"), 'console.log("BUNDLE_IMPORTED")');
    const fixture = join(dir, "version.mjs");
    writeFileSync(fixture, 'Object.defineProperty(process.versions, "node", { value: process.env.TEST_NODE_VERSION })');
    for (const version of ["22.13.0", "24.18.0", "24.22.0", "24.22.1", "24.23.0", "25.0.0", "26.0.0"]) {
      const result = spawnSync(process.execPath, ["--import", fixture, join(dir, "bin/openwork-server.mjs")], { encoding: "utf8", env: { ...process.env, TEST_NODE_VERSION: version } });
      assert.ifError(result.error);
      assert.equal(result.status, nodeVersionSupported(version) ? 0 : 1, result.stderr);
      assert.equal(result.stdout.includes("BUNDLE_IMPORTED"), nodeVersionSupported(version));
      if (!nodeVersionSupported(version)) assert.match(result.stderr, /Node.js 24.x, version 24.22.1/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
