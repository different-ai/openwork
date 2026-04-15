import { spawn } from "node:child_process";
import process from "node:process";

const includeApp = process.argv.includes("--app");

const commands = [
  {
    name: "server",
    args: ["--filter", "openwork-server-v2", "dev"],
  },
  {
    name: "openapi",
    args: ["--filter", "openwork-server-v2", "openapi:watch"],
  },
  {
    name: "sdk",
    args: ["--filter", "@openwork/server-sdk", "watch"],
  },
];

if (includeApp) {
  commands.push({
    name: "app",
    args: ["dev:ui"],
  });
}

const children = [];
let shuttingDown = false;

function stopAll(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 100);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopAll(0));
}

for (const command of commands) {
  const child = spawn("pnpm", command.args, {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd(),
  });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    const exitCode = code ?? (signal ? 1 : 0);
    stopAll(exitCode);
  });
}
