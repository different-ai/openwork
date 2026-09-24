import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { MIN_NODE_VERSION, SERVER_BINARY_TARGETS, nodeVersionSupported, serverBinaryName } from "./platform.mjs";
import { BUNDLE_EXTERNAL_DEPENDENCIES, stageNpmPackage } from "../scripts/publish-npm.mjs";

const binDir = fileURLToPath(new URL(".", import.meta.url));
const serverPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("selects a distinct compiled binary for every supported host in a checkout", () => {
  const names = SERVER_BINARY_TARGETS.map(({ platform, arch }) => serverBinaryName(platform, arch));
  assert.equal(new Set(names).size, 6);
  assert.equal(serverBinaryName("darwin", "arm64"), "openwork-server-bun-darwin-arm64");
  assert.equal(serverBinaryName("win32", "arm64"), "openwork-server-bun-windows-arm64.exe");
  assert.equal(serverBinaryName("freebsd", "x64"), null);
});

test("requires a Node.js with node:sqlite available without a flag", () => {
  assert.equal(MIN_NODE_VERSION, "22.13.0");
  for (const ok of ["22.13.0", "v22.14.0", "23.4.0", "24.0.0", "26.1.2"]) assert.ok(nodeVersionSupported(ok), ok);
  for (const old of ["20.18.0", "22.12.0", "23.3.0", "18.0.0"]) assert.ok(!nodeVersionSupported(old), old);
});

test("the bundle leaves external exactly the dependencies the package declares", () => {
  const script = serverPackage.scripts["build:npm-bundle"];
  const externals = [...script.matchAll(/--external (\S+)/g)].map((match) => match[1]);
  // Bun-only modules stay external so Node never loads them; the Bun branch never runs there.
  const nodeExternals = externals.filter((name) => name !== "bun:sqlite" && name !== "drizzle-orm/bun-sqlite");
  assert.deepEqual(nodeExternals, BUNDLE_EXTERNAL_DEPENDENCIES);
  for (const name of nodeExternals) assert.ok(serverPackage.dependencies[name], name);
});

async function fixture(context, bundleSource) {
  const root = await mkdtemp(join(tmpdir(), "openwork-npm-stage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "server");
  for (const dir of ["bin", "dist/npm-bundle", "dist/bin", "dist/opencode-plugins", "../app/dist"]) {
    await mkdir(join(packageRoot, dir), { recursive: true });
  }
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "openwork-server",
      version: "1.2.3",
      type: "module",
      license: "MIT",
      bin: { "openwork-server": "bin/openwork-server.mjs" },
      dependencies: { "jsonc-parser": "^3.2.1", zod: "^4.0.0" },
    }),
  );
  await writeFile(join(packageRoot, "README.md"), "server");
  await cp(join(binDir, "openwork-server.mjs"), join(packageRoot, "bin/openwork-server.mjs"));
  await cp(join(binDir, "platform.mjs"), join(packageRoot, "bin/platform.mjs"));
  await writeFile(join(packageRoot, "dist/npm-bundle/openwork-server.mjs"), `${bundleSource}\n//${" ".repeat(100_000)}\n`);
  await writeFile(join(packageRoot, "dist/opencode-plugins/openwork-extensions-preview.js"), "plugin");
  await writeFile(join(packageRoot, "dist/opencode-plugins/openwork-extensions-preview.test.js"), "test");
  await writeFile(join(packageRoot, "dist/opencode-plugins/pdfium.wasm"), "wasm");
  await writeFile(join(packageRoot, "dist/bin/openwork-server-bun-linux-x64"), "binary");
  await writeFile(join(packageRoot, "../app/dist/index.html"), "web");
  return { root, packageRoot };
}

test("stages one platform-independent package without compiled binaries", async (context) => {
  const { packageRoot } = await fixture(context, "export {};");
  const output = await stageNpmPackage(packageRoot);

  const manifest = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(manifest.engines, { node: ">=22.13.0" });
  assert.deepEqual(manifest.dependencies, { "jsonc-parser": "^3.2.1" });
  assert.equal(manifest.optionalDependencies, undefined);
  assert.equal(manifest.os, undefined);
  assert.equal(manifest.cpu, undefined);

  assert.deepEqual((await readdir(join(output, "dist"))).sort(), ["opencode-plugins", "openwork-server.mjs", "pdfium.wasm"]);
  assert.deepEqual((await readdir(join(output, "dist/opencode-plugins"))).sort(), ["openwork-extensions-preview.js", "pdfium.wasm"]);
  assert.equal(await readFile(join(output, "web/index.html"), "utf8"), "web");
});

test("refuses to stage without the Node bundle", async (context) => {
  const { packageRoot } = await fixture(context, "export {};");
  await rm(join(packageRoot, "dist/npm-bundle"), { recursive: true });
  await assert.rejects(stageNpmPackage(packageRoot), /build:npm-bundle/);
});

test("the installed launcher runs the Node bundle in-process with the package root set", async (context) => {
  const { root, packageRoot } = await fixture(
    context,
    'console.log(JSON.stringify({ args: process.argv.slice(2), root: process.env.OPENWORK_PACKAGE_ROOT }));',
  );
  const output = await stageNpmPackage(packageRoot);
  const installed = join(root, "install/node_modules/openwork-server");
  await cp(output, installed, { recursive: true });

  const result = spawnSync(process.execPath, [join(installed, "bin/openwork-server.mjs"), "web", "--port", "1"], {
    encoding: "utf8",
    env: { ...process.env, OPENWORK_PACKAGE_ROOT: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout.trim());
  assert.deepEqual(seen.args, ["web", "--port", "1"]);
  assert.equal(await realpath(seen.root), await realpath(installed));
});
