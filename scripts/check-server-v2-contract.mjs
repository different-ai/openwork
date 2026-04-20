import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "..");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoDir,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? 1}`}`));
    });
  });
}

async function main() {
  await run("pnpm", ["run", "sdk:generate"]);
  await run("git", [
    "diff",
    "--exit-code",
    "--",
    "apps/server-v2/openapi/openapi.json",
    "packages/openwork-server-sdk/generated",
  ]);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
