import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cliPath = path.resolve("dist", "cli.js");

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      if (options.expectTimeout) {
        resolve({ code: null, stdout, stderr, timedOut: true });
        return;
      }
      reject(new Error(`Timeout running ${cmd} ${args.join(" ")}`));
    }, options.timeoutMs ?? 5000);

    child.on("close", (code) => {
      if (timedOut) return;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, timedOut: false });
    });

    if (options.input) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

async function runHelp() {
  const result = await run("bun", [cliPath, "--help"], { timeoutMs: 3000 });
  if (result.code !== 0) {
    throw new Error(`Help failed: ${result.stderr}`);
  }
  if (!result.stdout.includes("Slack + Telegram")) {
    throw new Error("Help output missing expected header");
  }
}

async function runConfigCommands() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodeRouter-"));
  const env = {
    ...process.env,
    OPENCODE_ROUTER_DATA_DIR: tempDir,
    OPENCODE_ROUTER_DB_PATH: path.join(tempDir, "opencode-router.db"),
    OPENCODE_ROUTER_CONFIG_PATH: path.join(tempDir, "opencode-router.json"),
    OPENCODE_DIRECTORY: tempDir,
  };

  const setResult = await run("bun", [cliPath, "config", "set", "channels.telegram.enabled", "false"], {
    env,
    timeoutMs: 5000,
  });
  if (setResult.code !== 0) {
    throw new Error(`Config set failed: ${setResult.stderr}`);
  }

  const getResult = await run("bun", [cliPath, "config", "get", "channels.telegram.enabled"], {
    env,
    timeoutMs: 5000,
  });
  if (getResult.code !== 0) {
    throw new Error(`Config get failed: ${getResult.stderr}`);
  }
  if (!(`${getResult.stdout}${getResult.stderr}`.includes("false"))) {
    throw new Error("Config get output missing expected value");
  }

  const statusResult = await run("bun", [cliPath, "status", "--json"], { env, timeoutMs: 5000 });
  if (statusResult.code !== 0) {
    throw new Error(`Status failed: ${statusResult.stderr}`);
  }

  // Ensure identities subcommands are present.
  const tgList = await run("bun", [cliPath, "telegram", "list", "--json"], { env, timeoutMs: 5000 });
  if (tgList.code !== 0) {
    throw new Error(`Telegram list failed: ${tgList.stderr}`);
  }
}

await runHelp();
await runConfigCommands();
console.log("CLI smoke tests passed");
