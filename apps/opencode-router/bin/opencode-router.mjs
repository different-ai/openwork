#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);

const compiledBinaryName = process.platform === "win32" ? "opencode-router.exe" : "opencode-router";
const compiledBinary = fileURLToPath(new URL(`./dist/bin/${compiledBinaryName}`, `${new URL("../", import.meta.url)}`));
const builtCli = fileURLToPath(new URL("./dist/cli.js", `${new URL("../", import.meta.url)}`));
const sourceCli = fileURLToPath(new URL("./src/cli.ts", `${new URL("../", import.meta.url)}`));

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      console.error(`Missing runtime dependency: ${command}`);
      process.exit(1);
    }
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

if (existsSync(compiledBinary)) {
  run(compiledBinary, args);
}

if (existsSync(builtCli)) {
  run("bun", [builtCli, ...args]);
}

if (existsSync(sourceCli)) {
  run("bun", [sourceCli, ...args]);
}

console.error(
  `Unable to find an opencode-router entrypoint in ${basename(packageRoot)}. Build the package or run it from a source checkout with Bun available.`,
);
process.exit(1);
