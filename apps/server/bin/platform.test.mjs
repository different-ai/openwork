import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SERVER_BINARY_TARGETS, serverBinaryName } from "./platform.mjs";
import { stageNpmPackage } from "../scripts/publish-npm.mjs";

test("selects a distinct compiled binary for every supported host", () => {
  const names = SERVER_BINARY_TARGETS.map(({ platform, arch }) => serverBinaryName(platform, arch));
  assert.equal(new Set(names).size, 6);
  assert.equal(serverBinaryName("darwin", "arm64"), "openwork-server-bun-darwin-arm64");
  assert.equal(serverBinaryName("linux", "x64"), "openwork-server-bun-linux-x64");
  assert.equal(serverBinaryName("win32", "arm64"), "openwork-server-bun-windows-arm64.exe");
  assert.equal(serverBinaryName("freebsd", "x64"), null);
  assert.equal(serverBinaryName("darwin", "ia32"), null);
});

test("stages every platform binary and the web and plugin assets", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-npm-stage-"));
  context.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const packageRoot = join(root, "server");
  for (const dir of ["bin", "dist/bin", "dist/opencode-plugins", "../app/dist"]) {
    await mkdir(join(packageRoot, dir), { recursive: true });
  }
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "openwork-server", version: "1.2.3", type: "module", bin: { "openwork-server": "bin/openwork-server.mjs" } }));
  await writeFile(join(packageRoot, "README.md"), "server");
  await writeFile(join(packageRoot, "bin/openwork-server.mjs"), "launcher");
  await writeFile(join(packageRoot, "bin/platform.mjs"), "platform");
  await writeFile(join(packageRoot, "dist/opencode-plugins/openwork-extensions-preview.js"), "plugin");
  await writeFile(join(packageRoot, "../app/dist/index.html"), "web");
  for (const { platform, arch } of SERVER_BINARY_TARGETS) {
    await writeFile(join(packageRoot, "dist/bin", serverBinaryName(platform, arch)), Buffer.alloc(1_000_001));
  }
  const output = await stageNpmPackage(packageRoot);
  for (const { platform, arch } of SERVER_BINARY_TARGETS) {
    assert.equal((await stat(join(output, "dist/bin", serverBinaryName(platform, arch)))).size, 1_000_001);
  }
  assert.equal(await readFile(join(output, "web/index.html"), "utf8"), "web");
  assert.equal(await readFile(join(output, "dist/opencode-plugins/openwork-extensions-preview.js"), "utf8"), "plugin");
});
