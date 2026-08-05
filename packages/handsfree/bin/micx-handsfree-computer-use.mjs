#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const swiftPackagePath = path.join(packageRoot, "native", "HandsFree");

const explicitBinary = process.env.HANDSFREE_COMPUTER_USE_BINARY?.trim();
const candidates = [
  explicitBinary,
  path.join(swiftPackagePath, ".build", "release", "HandsFreeComputerUse"),
  path.join(swiftPackagePath, ".build", "arm64-apple-macosx", "release", "HandsFreeComputerUse"),
  path.join(swiftPackagePath, ".build", "debug", "HandsFreeComputerUse"),
  path.join(swiftPackagePath, ".build", "arm64-apple-macosx", "debug", "HandsFreeComputerUse"),
].filter(Boolean);

const args = process.argv.slice(2);
const binary = candidates.find((candidate) => existsSync(candidate));
const command = binary ?? "swift";
const commandArgs = binary
  ? args
  : ["run", "--package-path", swiftPackagePath, "HandsFreeComputerUse", ...args];

const child = spawn(command, commandArgs, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(`Failed to start HandsFreeComputerUse: ${error.message}`);
  process.exit(1);
});
