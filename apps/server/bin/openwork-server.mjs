#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MIN_NODE_VERSION, nodeVersionSupported, serverBinaryName } from "./platform.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const fromPackage = (relative) => fileURLToPath(new URL(relative, `${new URL("../", import.meta.url)}`));
const args = process.argv.slice(2);

// Lets `openwork-server web` find the bundled web UI and plugins in this package.
process.env.OPENWORK_PACKAGE_ROOT = process.env.OPENWORK_PACKAGE_ROOT?.trim() || packageRoot;

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", env: process.env });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      console.error(`Missing runtime dependency: ${command}`);
      process.exit(1);
    }
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

// The published package: one Node bundle for every OS and CPU.
const nodeBundle = fromPackage("./dist/openwork-server.mjs");
if (existsSync(nodeBundle)) {
  if (!nodeVersionSupported(process.versions.node)) {
    console.error(
      `openwork-server needs Node.js ${MIN_NODE_VERSION} or newer (found ${process.versions.node}). Install a current Node.js LTS and try again.`,
    );
    process.exit(1);
  }
  await import(pathToFileURL(nodeBundle).href);
} else {
  // Source checkout: a compiled binary from `build:bin`, then Bun.
  const binaryName = serverBinaryName(process.platform, process.arch);
  const compiledBinary = binaryName ? fromPackage(`./dist/bin/${binaryName}`) : null;
  if (compiledBinary && existsSync(compiledBinary)) run(compiledBinary, args);

  const builtCli = fromPackage("./dist/cli.js");
  if (existsSync(builtCli)) run("bun", [builtCli, ...args]);

  const sourceCli = fromPackage("./src/cli.ts");
  if (existsSync(sourceCli)) run("bun", [sourceCli, ...args]);

  console.error("OpenWork server is not built in this checkout. Run: pnpm --filter openwork-server build");
  process.exit(1);
}
