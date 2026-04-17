import { spawn } from "node:child_process";
import process from "node:process";

const includeApp = !process.argv.includes("--no-app");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
      cwd: process.cwd(),
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

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

async function main() {
  await run("pnpm", ["run", "sdk:generate"]);

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
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
