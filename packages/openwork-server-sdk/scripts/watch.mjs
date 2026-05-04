import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const specPath = path.resolve(packageDir, "../../apps/server-v2/openapi/openapi.json");
const specDir = path.dirname(specPath);
const specFilename = path.basename(specPath);

let activeChild = null;
let queued = false;
let timer = null;

function runGenerate() {
  if (activeChild) {
    queued = true;
    return;
  }

  activeChild = spawn("pnpm", ["run", "generate"], {
    cwd: packageDir,
    stdio: "inherit",
    env: process.env,
  });

  activeChild.once("exit", (code) => {
    activeChild = null;
    if (code && code !== 0) {
      process.stderr.write(`[openwork-server-sdk] generation failed with exit code ${code}.\n`);
    }
    if (queued) {
      queued = false;
      scheduleGenerate();
    }
  });
}

function scheduleGenerate() {
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = null;
    runGenerate();
  }, 120);
}

try {
  watch(specDir, (_eventType, filename) => {
    if (!filename || path.basename(String(filename)) !== specFilename) {
      return;
    }
    scheduleGenerate();
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

runGenerate();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (activeChild && activeChild.exitCode === null) {
      activeChild.kill("SIGTERM");
    }
    process.exit(0);
  });
}
