import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const specPath = path.resolve(packageDir, "../../apps/server/openapi/v2.json");
const outputDir = path.resolve(packageDir, "generated");

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "openwork-server-sdk-"));

  try {
    await run("pnpm", ["exec", "openapi-ts", "-i", specPath, "-o", tempDir], packageDir);
    await rm(outputDir, { recursive: true, force: true });
    await cp(tempDir, outputDir, { recursive: true });
    process.stdout.write(`[openwork-server-sdk] wrote ${outputDir}\n`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
