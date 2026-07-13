#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";

import {
  SERVER_NPM_META_PACKAGE,
  SERVER_NPM_TARGETS,
  currentServerTarget,
  serverOptionalDependencies,
  serverPlatformBinaryName,
  serverPlatformPackageName,
} from "./npm-package-contract.mjs";

const serverRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourcePackage = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
const version = String(sourcePackage.version ?? "").trim();
const outdirIndex = process.argv.indexOf("--outdir");
const outroot = resolve(
  outdirIndex >= 0 && process.argv[outdirIndex + 1]
    ? process.argv[outdirIndex + 1]
    : join(serverRoot, "dist", "npm"),
);
const tarballDir = join(outroot, "tarballs");
const releaseWorkflowPath = resolve(
  serverRoot,
  "..",
  "..",
  ".github",
  "workflows",
  "release-macos-aarch64.yml",
);
const expectedPackageNames = [
  ...SERVER_NPM_TARGETS.map(serverPlatformPackageName),
  SERVER_NPM_META_PACKAGE,
];
const forbiddenPrivatePackages = [
  "@openwork/contribution-registry",
  "@openwork/session-contracts",
];

function parseTarString(buffer, start, length) {
  const raw = buffer.subarray(start, start + length);
  const nullIndex = raw.indexOf(0);
  return raw.subarray(0, nullIndex >= 0 ? nullIndex : raw.length).toString("utf8").trim();
}

function parseTarOctal(buffer, start, length) {
  const value = parseTarString(buffer, start, length).replace(/\0/g, "").trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function readTarball(filepath) {
  const archive = gunzipSync(readFileSync(filepath));
  const entries = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = parseTarString(header, 0, 100);
    const prefix = parseTarString(header, 345, 155);
    const filepathInArchive = prefix ? `${prefix}/${name}` : name;
    const mode = parseTarOctal(header, 100, 8);
    const size = parseTarOctal(header, 124, 12);
    const type = parseTarString(header, 156, 1) || "0";
    const dataStart = offset + 512;
    entries.push({
      name: filepathInArchive,
      mode,
      size,
      type,
      data: archive.subarray(dataStart, dataStart + size),
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function assertCliOnlyManifest(manifest) {
  const serialized = JSON.stringify(manifest);
  assert.equal(manifest.private, undefined, `${manifest.name} must be public`);
  assert.equal(manifest.dependencies, undefined, `${manifest.name} must not publish runtime dependencies`);
  assert.equal(manifest.devDependencies, undefined, `${manifest.name} must not publish development dependencies`);
  assert.equal(serialized.includes("workspace:"), false, `${manifest.name} leaked a workspace protocol`);
  for (const packageName of forbiddenPrivatePackages) {
    assert.equal(serialized.includes(packageName), false, `${manifest.name} leaked ${packageName}`);
  }
  assert.deepEqual(manifest.exports, { "./package.json": "./package.json" });
  assert.equal(Object.hasOwn(manifest.exports, "."), false, `${manifest.name} must not expose a library root`);
}

function assertExecutable(filepath, label) {
  assert.notEqual(statSync(filepath).mode & 0o111, 0, `${label} is not executable on disk`);
}

function assertArchiveContents(entries, expected, label) {
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    [...expected].sort(),
    `${label} contains unexpected files`,
  );
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (options.expectFailure) return result;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  return result;
}

function assertBashSyntax(script, label) {
  const result = spawnSync("bash", ["-n"], {
    encoding: "utf8",
    input: script,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `${label} has invalid shell syntax\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
}

function verifyReleaseWorkflow() {
  const workflow = parseYaml(readFileSync(releaseWorkflowPath, "utf8"));
  const publishJob = workflow?.jobs?.["publish-npm"];
  assert(publishJob, "Release workflow has no publish-npm job");
  assert(Array.isArray(publishJob.steps), "Release publish-npm job has no steps");

  const versionsStep = publishJob.steps.find((step) => step?.id === "npm-versions");
  assert.equal(typeof versionsStep?.run, "string", "Release workflow has no npm-versions script");
  assertBashSyntax(versionsStep.run, "Release npm-versions script");
  const inventoryMatch = versionsStep.run.match(/server_packages=\(\s*([\s\S]*?)\s*\)/);
  assert(inventoryMatch, "Release npm-versions script has no server package inventory");
  const workflowPackageNames = inventoryMatch[1].split(/\s+/).filter(Boolean);
  assert.deepEqual(
    workflowPackageNames.sort(),
    [...expectedPackageNames].sort(),
    "Release workflow server package inventory drifted from the packaging contract",
  );

  const publishStep = publishJob.steps.find(
    (step) => step?.name === "Publish openwork-server packages",
  );
  assert.equal(typeof publishStep?.run, "string", "Release workflow has no server publish script");
  assertBashSyntax(publishStep.run, "Release server publish script");
  assert.match(publishStep.run, /pnpm --filter openwork-server build:bin:all/);
  assert.match(publishStep.run, /node apps\/server\/scripts\/publish-npm\.mjs/);
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForJson(url, init, timeoutMs, child, logs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`openwork-server exited before ${url} became ready\n${logs()}`);
    }
    try {
      const response = await fetch(url, init);
      if (response.ok) return { response, json: await response.json() };
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "unknown error"}\n${logs()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveClose) => child.once("close", resolveClose)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function verifyStandaloneServer(binaryPath, tempRoot) {
  const versionResult = runSync(binaryPath, ["--version"], { cwd: tempRoot });
  assert.equal(versionResult.stdout.trim(), version);

  const workspacePath = join(tempRoot, "workspace");
  const configPath = join(tempRoot, "config", "server.json");
  const runtimeDbPath = join(tempRoot, "runtime.sqlite");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });
  const port = await availablePort();
  const child = spawn(
    binaryPath,
    [
      "--config",
      configPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--token",
      "npm-audit-client",
      "--host-token",
      "npm-audit-host",
      "--approval",
      "auto",
      "--workspace",
      workspacePath,
    ],
    {
      cwd: tempRoot,
      env: {
        ...process.env,
        HOME: join(tempRoot, "home"),
        OPENWORK_RUNTIME_DB: runtimeDbPath,
        XDG_CONFIG_HOME: join(tempRoot, "xdg"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const logs = () => `${stdout}${stderr}`;

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForJson(`${baseUrl}/health`, undefined, 15_000, child, logs);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.version, version);

    const authorization = { Authorization: "Bearer npm-audit-client" };
    const workspaces = await waitForJson(
      `${baseUrl}/workspaces`,
      { headers: authorization },
      5_000,
      child,
      logs,
    );
    const workspaceList = Array.isArray(workspaces.json)
      ? workspaces.json
      : workspaces.json.workspaces;
    assert(Array.isArray(workspaceList) && workspaceList.length === 1);
    const workspaceId = workspaceList[0]?.id;
    assert.equal(typeof workspaceId, "string");

    const runtimeConfig = await waitForJson(
      `${baseUrl}/workspace/${encodeURIComponent(workspaceId)}/runtime-config`,
      { headers: authorization },
      5_000,
      child,
      logs,
    );
    assert.equal(runtimeConfig.response.status, 200);
    assert.equal(existsSync(runtimeDbPath), true, "SQLite-backed runtime route did not create runtime.sqlite");
  } finally {
    await stopChild(child);
  }
}

assert.equal(version.length > 0, true, "server version is required");
assert.equal(existsSync(tarballDir), true, `Missing tarball directory: ${tarballDir}`);
verifyReleaseWorkflow();

const tarballPaths = readdirSync(tarballDir)
  .filter((name) => name.endsWith(".tgz"))
  .sort()
  .map((name) => join(tarballDir, name));
assert.equal(tarballPaths.length, expectedPackageNames.length, "Expected exactly seven npm tarballs");

const packedByName = new Map();
for (const tarballPath of tarballPaths) {
  const entries = readTarball(tarballPath);
  const manifestEntry = entries.find((entry) => entry.name === "package/package.json");
  assert(manifestEntry, `${tarballPath} has no package.json`);
  const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  assert.equal(packedByName.has(manifest.name), false, `Duplicate tarball for ${manifest.name}`);
  assertCliOnlyManifest(manifest);
  assert.equal(
    entries.some((entry) => /package\/(?:src|dist|node_modules)(?:\/|$)/.test(entry.name)),
    false,
    `${manifest.name} contains source, dist, or node_modules`,
  );
  packedByName.set(manifest.name, { entries, manifest, tarballPath });
}
assert.deepEqual([...packedByName.keys()].sort(), [...expectedPackageNames].sort());

for (const target of SERVER_NPM_TARGETS) {
  const name = serverPlatformPackageName(target);
  const packageDir = join(outroot, name);
  const generatedManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const packed = packedByName.get(name);
  assert(packed);
  assert.deepEqual(packed.manifest, generatedManifest);
  assert.equal(packed.manifest.version, version);
  assert.deepEqual(packed.manifest.os, [target.os]);
  assert.deepEqual(packed.manifest.cpu, [target.cpu]);
  const binaryName = serverPlatformBinaryName(target);
  assert.deepEqual(packed.manifest.bin, { "openwork-server": `./bin/${binaryName}` });
  assertArchiveContents(
    packed.entries,
    ["package/LICENSE", `package/bin/${binaryName}`, "package/package.json"],
    `${name} tarball`,
  );
  const binaryEntry = packed.entries.find((entry) => entry.name === `package/bin/${binaryName}`);
  assert(binaryEntry, `${name} tarball has no declared binary`);
  if (target.os !== "win32") {
    assert.notEqual(binaryEntry.mode & 0o111, 0, `${name} tarball binary is not executable`);
    assertExecutable(join(packageDir, "bin", binaryName), `${name} binary`);
  }
}

const metaPackageDir = join(outroot, SERVER_NPM_META_PACKAGE);
const generatedMetaManifest = JSON.parse(readFileSync(join(metaPackageDir, "package.json"), "utf8"));
const packedMeta = packedByName.get(SERVER_NPM_META_PACKAGE);
assert(packedMeta);
assert.deepEqual(packedMeta.manifest, generatedMetaManifest);
assert.equal(packedMeta.manifest.version, version);
assert.deepEqual(packedMeta.manifest.optionalDependencies, serverOptionalDependencies(version));
assert.deepEqual(packedMeta.manifest.bin, {
  "openwork-server": "./bin/openwork-server.mjs",
});
assertArchiveContents(
  packedMeta.entries,
  ["package/LICENSE", "package/bin/openwork-server.mjs", "package/package.json"],
  "meta package tarball",
);
const wrapperEntry = packedMeta.entries.find(
  (entry) => entry.name === "package/bin/openwork-server.mjs",
);
assert(wrapperEntry, "meta package tarball has no wrapper");
assert.notEqual(wrapperEntry.mode & 0o111, 0, "meta package wrapper is not executable");
assertExecutable(join(metaPackageDir, "bin", "openwork-server.mjs"), "meta package wrapper");

const currentTarget = currentServerTarget();
assert(currentTarget, `No supported npm target for ${process.platform}/${process.arch}`);
const currentPlatformPackage = serverPlatformPackageName(currentTarget);
const currentBinary = join(
  outroot,
  currentPlatformPackage,
  "bin",
  serverPlatformBinaryName(currentTarget),
);
const tempRoot = mkdtempSync(join(os.tmpdir(), "openwork-server-npm-verify-"));
try {
  const nodeModules = join(tempRoot, "node_modules");
  const installedMeta = join(nodeModules, SERVER_NPM_META_PACKAGE);
  const installedPlatform = join(nodeModules, currentPlatformPackage);
  mkdirSync(nodeModules, { recursive: true });
  cpSync(metaPackageDir, installedMeta, { recursive: true });
  cpSync(join(outroot, currentPlatformPackage), installedPlatform, { recursive: true });
  const installedWrapper = join(installedMeta, "bin", "openwork-server.mjs");

  const wrapperVersion = runSync(process.execPath, [installedWrapper, "--version"], {
    cwd: tempRoot,
    env: process.env,
  });
  assert.equal(wrapperVersion.stdout.trim(), version);

  const overrideVersion = runSync(process.execPath, [installedWrapper, "--version"], {
    cwd: tempRoot,
    env: { ...process.env, OPENWORK_SERVER_BIN_PATH: currentBinary },
  });
  assert.equal(overrideVersion.stdout.trim(), version);

  rmSync(installedPlatform, { recursive: true, force: true });
  const missingPlatform = runSync(process.execPath, [installedWrapper, "--version"], {
    cwd: tempRoot,
    env: { ...process.env, OPENWORK_SERVER_BIN_PATH: "" },
    expectFailure: true,
  });
  assert.notEqual(missingPlatform.status, 0);
  assert.match(
    missingPlatform.stderr,
    new RegExp(`no prebuilt binary package found for ${currentTarget.id.replace("-", "\\/")}`),
  );
  assert.match(missingPlatform.stderr, /OPENWORK_SERVER_BIN_PATH/);

  await verifyStandaloneServer(currentBinary, tempRoot);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      packages: expectedPackageNames,
      runtimeTarget: currentTarget.id,
      version,
      workflowVerified: true,
    },
    null,
    2,
  ),
);
