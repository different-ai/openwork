#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const require = createRequire(import.meta.url);

const platformNames = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};
const architectureNames = {
  arm64: "arm64",
  x64: "x64",
};

const nodePlatform = os.platform();
const nodeArchitecture = os.arch();
const packagePlatform = platformNames[nodePlatform] ?? nodePlatform;
const packageArchitecture = architectureNames[nodeArchitecture] ?? nodeArchitecture;
const platformPackage = `openwork-server-${packagePlatform}-${packageArchitecture}`;
const binaryName = nodePlatform === "win32" ? "openwork-server.exe" : "openwork-server";
const buildBinaryName = `openwork-server-bun-${packagePlatform}-${packageArchitecture}${nodePlatform === "win32" ? ".exe" : ""}`;
const compiledBinary = path.join(packageRoot, "dist", "bin", binaryName);
const targetCompiledBinary = path.join(packageRoot, "dist", "bin", buildBinaryName);
const builtCli = fileURLToPath(new URL("./dist/cli.js", `${new URL("../", import.meta.url)}`));
const sourceCli = fileURLToPath(new URL("./src/cli.ts", `${new URL("../", import.meta.url)}`));

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) {
    console.error(`openwork-server: failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

const overrideBinary = process.env.OPENWORK_SERVER_BIN_PATH?.trim();
if (overrideBinary) {
  run(overrideBinary, args);
}

try {
  const packageJsonPath = require.resolve(`${platformPackage}/package.json`);
  const resolvedBinary = path.join(path.dirname(packageJsonPath), "bin", binaryName);
  run(resolvedBinary, args);
} catch {
  // Source checkouts use the local build fallbacks below. The public meta
  // package contains none of them and reaches the actionable diagnostic.
}

if (existsSync(compiledBinary)) {
  run(compiledBinary, args);
}

if (existsSync(targetCompiledBinary)) {
  run(targetCompiledBinary, args);
}

if (existsSync(builtCli)) {
  run("bun", [builtCli, ...args]);
}

if (existsSync(sourceCli)) {
  run("bun", [sourceCli, ...args]);
}

console.error(
  `openwork-server: no prebuilt binary package found for ${packagePlatform}/${packageArchitecture}.\n` +
    `Try reinstalling openwork-server or installing the platform package manually: ${platformPackage}\n` +
    "Set OPENWORK_SERVER_BIN_PATH to an explicit compatible executable.",
);
process.exit(1);
