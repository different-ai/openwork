import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SERVER_BINARY_TARGETS, serverBinaryName, serverPlatformPackageName } from "./platform.mjs";
import { stageNpmPackages } from "../scripts/publish-npm.mjs";

const binDir = fileURLToPath(new URL(".", import.meta.url));

test("selects a distinct compiled binary for every supported host", () => {
  const names = SERVER_BINARY_TARGETS.map(({ platform, arch }) => serverBinaryName(platform, arch));
  assert.equal(new Set(names).size, 6);
  assert.equal(serverBinaryName("darwin", "arm64"), "openwork-server-bun-darwin-arm64");
  assert.equal(serverBinaryName("linux", "x64"), "openwork-server-bun-linux-x64");
  assert.equal(serverBinaryName("win32", "arm64"), "openwork-server-bun-windows-arm64.exe");
  assert.equal(serverBinaryName("freebsd", "x64"), null);
  assert.equal(serverBinaryName("darwin", "ia32"), null);
});

test("names one npm package per supported host", () => {
  const names = SERVER_BINARY_TARGETS.map(({ platform, arch }) => serverPlatformPackageName(platform, arch));
  assert.equal(new Set(names).size, 6);
  assert.equal(serverPlatformPackageName("darwin", "arm64"), "openwork-server-darwin-arm64");
  assert.equal(serverPlatformPackageName("win32", "x64"), "openwork-server-windows-x64");
  assert.equal(serverPlatformPackageName("freebsd", "x64"), null);
});

async function fixture(context, binaryBody = Buffer.alloc(1_000_001)) {
  const root = await mkdtemp(join(tmpdir(), "openwork-npm-stage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "server");
  for (const dir of ["bin", "dist/bin", "dist/opencode-plugins", "../app/dist"]) {
    await mkdir(join(packageRoot, dir), { recursive: true });
  }
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "openwork-server", version: "1.2.3", type: "module", license: "MIT", bin: { "openwork-server": "bin/openwork-server.mjs" } }),
  );
  await writeFile(join(packageRoot, "README.md"), "server");
  await cp(join(binDir, "openwork-server.mjs"), join(packageRoot, "bin/openwork-server.mjs"));
  await cp(join(binDir, "platform.mjs"), join(packageRoot, "bin/platform.mjs"));
  await writeFile(join(packageRoot, "dist/opencode-plugins/openwork-extensions-preview.js"), "plugin");
  await writeFile(join(packageRoot, "../app/dist/index.html"), "web");
  for (const { platform, arch } of SERVER_BINARY_TARGETS) {
    await writeFile(join(packageRoot, "dist/bin", serverBinaryName(platform, arch)), binaryBody);
  }
  return { root, packageRoot };
}

test("stages one package per host binary and a main package without binaries", async (context) => {
  const { packageRoot } = await fixture(context);
  const staged = await stageNpmPackages(packageRoot);

  assert.equal(staged.platforms.length, 6);
  for (const { name, platform, arch, binaryName, dir } of staged.platforms) {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, "1.2.3");
    assert.deepEqual(manifest.os, [platform]);
    assert.deepEqual(manifest.cpu, [arch]);
    assert.equal(manifest.bin, undefined);
    const info = await stat(join(dir, "bin", binaryName));
    assert.equal(info.size, 1_000_001);
    if (process.platform !== "win32") assert.equal(info.mode & 0o111, 0o111);
  }

  const main = JSON.parse(await readFile(join(staged.main, "package.json"), "utf8"));
  assert.deepEqual(
    main.optionalDependencies,
    Object.fromEntries(staged.platforms.map(({ name }) => [name, "1.2.3"])),
  );
  assert.deepEqual((await readdir(join(staged.main, "dist"))).sort(), ["opencode-plugins"]);
  assert.equal(await readFile(join(staged.main, "web/index.html"), "utf8"), "web");
  assert.equal(await readFile(join(staged.main, "dist/opencode-plugins/openwork-extensions-preview.js"), "utf8"), "plugin");
});

test("refuses to stage when a host binary is missing", async (context) => {
  const { packageRoot } = await fixture(context);
  await rm(join(packageRoot, "dist/bin", serverBinaryName("linux", "arm64")));
  await assert.rejects(stageNpmPackages(packageRoot), /openwork-server-bun-linux-arm64/);
});

test(
  "the installed launcher runs the binary from the matching platform package",
  { skip: process.platform === "win32" || !serverBinaryName(process.platform, process.arch) },
  async (context) => {
    const script = Buffer.concat([Buffer.from('#!/bin/sh\necho "platform-binary $*"\n'), Buffer.alloc(1_000_001, 0x20)]);
    const { root, packageRoot } = await fixture(context, script);
    const staged = await stageNpmPackages(packageRoot);

    // The layout npm creates for `npm install openwork-server`.
    const installed = join(root, "install/node_modules");
    await cp(staged.main, join(installed, "openwork-server"), { recursive: true });
    const host = staged.platforms.find((entry) => entry.platform === process.platform && entry.arch === process.arch);
    await cp(host.dir, join(installed, host.name), { recursive: true });

    const ok = spawnSync(process.execPath, [join(installed, "openwork-server/bin/openwork-server.mjs"), "--version"], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), "platform-binary --version");

    await rm(join(installed, host.name), { recursive: true });
    const missing = spawnSync(process.execPath, [join(installed, "openwork-server/bin/openwork-server.mjs"), "--version"], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, new RegExp(`optional package ${host.name} is not installed`));
  },
);
