#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serverBinaryName, serverPlatformPackageName } from "./platform.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);

const binaryName = serverBinaryName(process.platform, process.arch);
const platformPackage = serverPlatformPackageName(process.platform, process.arch);
const builtCli = fileURLToPath(new URL("./dist/cli.js", `${new URL("../", import.meta.url)}`));
const sourceCli = fileURLToPath(new URL("./src/cli.ts", `${new URL("../", import.meta.url)}`));

// npm installs the matching host binary as an optional dependency.
function platformPackageBinary() {
  if (!binaryName || !platformPackage) return null;
  try {
    const manifest = createRequire(import.meta.url).resolve(`${platformPackage}/package.json`);
    return join(dirname(manifest), "bin", binaryName);
  } catch {
    return null;
  }
}

// A source checkout that ran `build:bin:all` keeps binaries in dist/bin.
function localBinary() {
  if (!binaryName) return null;
  return fileURLToPath(new URL(`./dist/bin/${binaryName}`, `${new URL("../", import.meta.url)}`));
}

function run(command, commandArgs) {
  // Lets `openwork-server web` find the bundled web UI and plugins next to this launcher.
  const env = { ...process.env, OPENWORK_PACKAGE_ROOT: process.env.OPENWORK_PACKAGE_ROOT ?? packageRoot };
  const result = spawnSync(command, commandArgs, { stdio: "inherit", env });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      console.error(`Missing runtime dependency: ${command}`);
      process.exit(1);
    }
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

for (const binary of [platformPackageBinary(), localBinary()]) {
  if (binary && existsSync(binary)) run(binary, args);
}

if (existsSync(builtCli)) {
  run("bun", [builtCli, ...args]);
}

if (existsSync(sourceCli)) {
  run("bun", [sourceCli, ...args]);
}

console.error(
  platformPackage
    ? `Missing OpenWork server binary for ${process.platform}/${process.arch}: the optional package ${platformPackage} is not installed next to ${basename(packageRoot)}. Reinstall without --omit=optional (or --no-optional), or run it from a source checkout with Bun available.`
    : `OpenWork server does not support ${process.platform}/${process.arch}. Supported platforms: macOS, Linux, and Windows on arm64 or x64.`,
);
process.exit(1);
