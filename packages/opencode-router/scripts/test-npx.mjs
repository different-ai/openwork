import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempCache = await fs.mkdtemp(path.join(os.tmpdir(), "opencodeRouter-npx-"));
const env = {
  ...process.env,
  npm_config_yes: "true",
  NPM_CONFIG_CACHE: tempCache,
};

const packed = await run("npm", ["pack", "--silent"], {
  cwd: packageDir,
  env,
  timeoutMs: 60000,
});

if (packed.code !== 0) {
  throw new Error(packed.stderr || "npm pack failed");
}

const tarball = packed.stdout
  .split(/\r?\n/g)
  .map((line) => line.trim())
  .filter(Boolean)
  .at(-1);

if (!tarball) {
  throw new Error("npm pack did not return a tarball name");
}

const tarballPath = path.join(packageDir, tarball);

try {
  const result = await run(
    "npx",
    ["--yes", "--package", tarballPath, "opencode-router", "--help"],
    {
      env,
      timeoutMs: 60000,
    },
  );

  if (result.code !== 0) {
    throw new Error(result.stderr || "npx opencode-router failed");
  }

  if (!result.stdout.includes("opencode-router") && !result.stdout.includes("owpenbot")) {
    throw new Error("npx output missing expected command name");
  }

  console.log("npx opencode-router ok");
} finally {
  await fs.rm(tarballPath, { force: true });
  await fs.rm(tempCache, { recursive: true, force: true });
}
