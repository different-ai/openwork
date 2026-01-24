import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timeout running ${cmd} ${args.join(" ")}`));
    }, options.timeoutMs ?? 60000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

const tempCache = await fs.mkdtemp(path.join(os.tmpdir(), "owpenbot-npx-"));
const env = {
  ...process.env,
  npm_config_yes: "true",
  NPM_CONFIG_CACHE: tempCache,
};

const result = await run("npx", ["--yes", "owpenwork", "--help"], {
  env,
  timeoutMs: 60000,
});

if (result.code !== 0) {
  throw new Error(result.stderr || "npx owpenwork failed");
}

if (!result.stdout.includes("OpenCode WhatsApp")) {
  throw new Error("npx output missing expected header");
}

console.log("npx owpenwork ok");
