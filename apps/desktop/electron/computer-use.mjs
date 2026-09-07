// Computer-use helper integration: locating the bundled ComputerUse.app,
// permission checks (spawn --check for a fresh TCC read), running-app
// listing for @App mentions, and opening the permission-setup GUI.
// Extracted from main.mjs; consumed only by the desktop IPC registry.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COMPUTER_USE_HELPER_APP_NAME = "OpenWork Computer Use.app";
const COMPUTER_USE_HELPER_EXECUTABLE = "ComputerUse";

function computerUseHelperExecutablePath() {
  const appPath = computerUseHelperAppPath();
  const explicitBinary = process.env.OPENWORK_COMPUTER_USE_BINARY?.trim();
  const candidates = [
    explicitBinary,
    appPath ? path.join(appPath, "Contents", "MacOS", COMPUTER_USE_HELPER_EXECUTABLE) : null,
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function computerUseHelperAppPath() {
  const explicitApp = process.env.OPENWORK_COMPUTER_USE_APP?.trim();
  const candidates = [
    explicitApp,
    process.resourcesPath ? path.join(process.resourcesPath, "helpers", COMPUTER_USE_HELPER_APP_NAME) : null,
    path.resolve(__dirname, "..", "resources", "helpers", COMPUTER_USE_HELPER_APP_NAME),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getComputerUseMcpCommand() {
  if (process.platform !== "darwin") {
    throw new Error("Desktop Computer Use requires macOS 14 or later. Use the built-in browser for website tasks.");
  }
  const helperExecutable = computerUseHelperExecutablePath();
  if (helperExecutable) return [helperExecutable, "mcp"];

  if (app.isPackaged) {
    throw new Error("OpenWork Computer Use is missing from this OpenWork build.");
  }

  if (process.env.OPENWORK_DEV_MODE === "1") {
    return ["node", path.resolve(__dirname, "../../..", "packages/computer-use/bin/openwork-computer-use.mjs"), "mcp"];
  }
  throw new Error("The Computer Use helper is unavailable. Rebuild or reinstall OpenWork.");
}

// ---------------------------------------------------------------------------
// Permission checks — spawn the binary with --check, read stdout, done.
// Check in the same launch context as setup. TCC can attribute a child process
// differently from a helper opened separately through LaunchServices.
// ---------------------------------------------------------------------------

function resolveComputerUseExecutable() {
  // 1. Explicit env override.
  const explicit = process.env.OPENWORK_COMPUTER_USE_BINARY?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  // 2. .app bundle (packaged builds + pnpm dev).
  const appPath = computerUseHelperAppPath();
  if (appPath) {
    const bin = path.join(appPath, "Contents", "MacOS", COMPUTER_USE_HELPER_EXECUTABLE);
    if (existsSync(bin)) return bin;
  }

  // 3. Dev fallback — raw Swift build output.
  if (!app.isPackaged) {
    const swiftPkg = path.resolve(__dirname, "../../..", "packages/computer-use/native");
    const devCandidates = [
      path.join(swiftPkg, ".build", "release", "ComputerUse"),
      path.join(swiftPkg, ".build", "arm64-apple-macosx", "release", "ComputerUse"),
      path.join(swiftPkg, ".build", "debug", "ComputerUse"),
      path.join(swiftPkg, ".build", "arm64-apple-macosx", "debug", "ComputerUse"),
    ];
    for (const c of devCandidates) {
      if (existsSync(c)) return c;
    }
  }

  return null;
}

async function checkComputerUsePermissions() {
  if (process.platform !== "darwin") {
    return { ok: false, accessibility: false, screenRecording: false, supported: false, error: "Desktop Computer Use is available on macOS 14 or later. Use the built-in browser for website tasks." };
  }
  // Spawn binary --check → read JSON from stdout → exit. Always fresh.
  const bin = resolveComputerUseExecutable();
  if (!bin) {
    return { ok: false, accessibility: false, screenRecording: false, error: "Helper binary not found. Run pnpm dev to build it." };
  }
  return spawnCheckPermissions(bin);
}

function spawnCheckPermissions(bin) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(bin, ["--check"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve({ ok: false, accessibility: false, screenRecording: false, error: "Failed to run permission check." }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({
          ok: parsed?.ok === true && parsed?.protocolVersion === "openwork.computer-use/1",
          accessibility: parsed?.accessibility === true && parsed?.protocolVersion === "openwork.computer-use/1",
          screenRecording: parsed?.screenRecording === true && parsed?.protocolVersion === "openwork.computer-use/1",
          supported: parsed?.supported === true,
          protocolVersion: parsed?.protocolVersion,
          ...(parsed?.protocolVersion !== "openwork.computer-use/1" ? { error: "This helper uses the previous Computer Use implementation. Rebuild or reinstall OpenWork, then reconnect Computer Use." } : {}),
        });
      } catch {
        resolve({ ok: false, accessibility: false, screenRecording: false, error: "Permission check returned invalid output." });
      }
    });
  });
}

async function listRunningApps() {
  // Spawn binary --list-apps → read JSON from stdout → exit. Needs no TCC
  // permissions, so this works before Computer Use setup is complete.
  if (process.platform !== "darwin") return { ok: false, apps: [] };
  const bin = resolveComputerUseExecutable();
  if (!bin) return { ok: false, apps: [] };
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(bin, ["--list-apps"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", () => resolve({ ok: false, apps: [] }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(stdout.trim());
        const apps = Array.isArray(parsed?.apps) ? parsed.apps.filter((name) => typeof name === "string" && name.trim()) : [];
        resolve({ ok: parsed?.ok === true, apps });
      } catch {
        resolve({ ok: false, apps: [] });
      }
    });
  });
}

let setupProcess = null;

async function openComputerUseSetupApp() {
  if (process.platform !== "darwin") throw new Error("Desktop Computer Use requires macOS 14 or later.");
  const bin = resolveComputerUseExecutable();
  if (!bin) throw new Error("The Computer Use helper is unavailable. Rebuild or reinstall OpenWork.");
  // Keep the responsible application consistent with --check and the MCP
  // child. LaunchServices gives the GUI its own TCC identity instead.
  if (setupProcess && setupProcess.exitCode === null && !setupProcess.killed) {
    setupProcess.kill("SIGUSR1");
    return;
  }
  const child = spawn(bin, ["setup"], { stdio: "ignore" });
  setupProcess = child;
  child.once("exit", () => { if (setupProcess === child) setupProcess = null; });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => {
      if (setupProcess === child) setupProcess = null;
      reject(error);
    });
  });
  child.unref();
}

export {
  checkComputerUsePermissions,
  getComputerUseMcpCommand,
  listRunningApps,
  openComputerUseSetupApp,
};
