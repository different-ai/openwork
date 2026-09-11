#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("Computer Use requires macOS 14 or later. Use the built-in browser for website tasks on this platform.");
  process.exit(1);
}
const binary = fileURLToPath(new URL("../native/.build/release/ComputerUse", import.meta.url));
if (!existsSync(binary)) {
  console.error("Build the Computer Use helper with pnpm --filter @openwork/computer-use build:native.");
  process.exit(1);
}
const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { console.error("Could not start Computer Use."); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
