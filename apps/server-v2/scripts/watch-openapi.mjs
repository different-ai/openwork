import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const watchedDir = path.join(packageDir, "src");

let activeChild = null;
let queued = false;
let timer = null;

function runGenerate() {
  if (activeChild) {
    queued = true;
    return;
  }

  activeChild = spawn("bun", ["./scripts/generate-openapi.ts"], {
    cwd: packageDir,
    env: process.env,
    stdio: "inherit",
  });

  activeChild.once("exit", (code) => {
    activeChild = null;

    if (code && code !== 0) {
      process.stderr.write(`[openwork-server-v2] OpenAPI generation failed with exit code ${code}.\n`);
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

runGenerate();

const watcher = watch(watchedDir, { recursive: true }, (_eventType, filename) => {
  if (!filename || String(filename).includes(".DS_Store")) {
    return;
  }

  scheduleGenerate();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    watcher.close();

    if (activeChild && activeChild.exitCode === null) {
      activeChild.kill("SIGTERM");
    }

    process.exit(0);
  });
}
