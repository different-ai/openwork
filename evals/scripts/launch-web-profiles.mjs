#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CHROME_BIN = process.env.CHROME_BIN?.trim() || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILES = [
  ["ADMIN", 9333],
  ["INVITEE", 9334],
  ["MOBILE", 9335],
];

async function isListening(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) });
    return response.ok;
  } catch {
    return false;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killPidfile(userDataDir) {
  const pidPath = join(userDataDir, "openwork-eval-chrome.pid");
  let pid = 0;
  try {
    pid = Number((await readFile(pidPath, "utf8")).trim());
  } catch {
    return;
  }
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isListening(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome did not open CDP port ${port}.`);
}

async function ensureProfile(port) {
  const userDataDir = `/tmp/openwork-evals-web-${port}`;
  await mkdir(userDataDir, { recursive: true });
  if (await isListening(port)) return;
  await killPidfile(userDataDir);

  const child = spawn(CHROME_BIN, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "about:blank",
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await writeFile(join(userDataDir, "openwork-eval-chrome.pid"), `${child.pid}\n`);
  await waitForPort(port);
}

for (const [, port] of PROFILES) {
  await ensureProfile(port);
}

for (const [name, port] of PROFILES) {
  console.log(`export OPENWORK_EVAL_WEB_CDP_${name}=http://127.0.0.1:${port}`);
}
