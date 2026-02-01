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
  const result = await run("node", [cliPath, "--help"], { timeoutMs: 3000 });
  if (result.code !== 0) {
    throw new Error(`Help failed: ${result.stderr}`);
  }
  if (!result.stdout.includes("OpenCode WhatsApp")) {
    throw new Error("Help output missing expected header");
  }
}

async function runSetupNonInteractive() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "owpenbot-"));
  const env = {
    ...process.env,
    OWPENBOT_DATA_DIR: tempDir,
    OWPENBOT_DB_PATH: path.join(tempDir, "owpenbot.db"),
    OWPENBOT_CONFIG_PATH: path.join(tempDir, "owpenbot.json"),
    OPENCODE_DIRECTORY: tempDir,
  };
  const result = await run("node", [cliPath, "--non-interactive"], {
    env,
    timeoutMs: 5000,
  });
  if (result.code !== 0) {
    throw new Error(`Setup failed: ${result.stderr}`);
  }
  const cfg = await fs.readFile(path.join(tempDir, "owpenbot.json"), "utf-8");
  if (!cfg.includes("whatsapp")) {
    throw new Error("Config missing whatsapp section");
  }
}

async function runSetupInteractive() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "owpenbot-"));
  const env = {
    ...process.env,
    OWPENBOT_DATA_DIR: tempDir,
    OWPENBOT_DB_PATH: path.join(tempDir, "owpenbot.db"),
    OWPENBOT_CONFIG_PATH: path.join(tempDir, "owpenbot.json"),
    OPENCODE_DIRECTORY: tempDir,
    OWPENWORK_TEST_SELECTIONS: "config",
    OWPENWORK_TEST_SETUP: "personal",
    OWPENWORK_FORCE_TUI: "1",
  };
  const result = await run("node", ["--no-warnings", cliPath], {
    env,
    timeoutMs: 5000,
  });
  const output = `${result.stdout}${result.stderr}`;
  if (!output.includes("Owpenwork Setup")) {
    throw new Error("Interactive setup prompt not detected");
  }
  const cfg = await fs.readFile(path.join(tempDir, "owpenbot.json"), "utf-8");
  if (!cfg.includes("+15551234567")) {
    throw new Error("Interactive config missing allowlist number");
  }
}

await runHelp();
await runSetupNonInteractive();
await runSetupInteractive();
console.log("CLI smoke tests passed");
