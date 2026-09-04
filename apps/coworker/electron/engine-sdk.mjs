/**
 * The AI service keeps a small SDK directory beside its configuration
 * (`@opencode-ai/plugin`, pinned to the engine's own version) and installs it
 * in the background the first time a project is opened. In a fresh profile
 * that first install leaves the engine's first provider read attached to the
 * installer even after the files are on disk: the read stalls for as long as
 * its caller waits, and only a restart of the engine gets past it. Seeding the
 * same directories with the same pinned package before the engine ever starts
 * makes that first install a no-op, so a first coworker is ready in well under
 * a second instead of after a timeout and a restart.
 *
 * Best effort and bounded: without `bun` or `npm` on this Mac, or without a
 * network, the engine's own path still works as before. No Electron imports:
 * `node --test electron/engine-sdk.test.mjs` exercises this module.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PLUGIN_PACKAGE = "@opencode-ai/plugin";
export const INSTALL_TIMEOUT_MS = 90_000;

/** The directories the engine loads its SDK from: its config dir, plus OPENCODE_CONFIG_DIR when set. */
export function engineSdkDirectories(env = process.env, homeDir = os.homedir()) {
  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : path.join(homeDir, ".config");
  const directories = [path.join(configHome, "opencode")];
  const extra = typeof env.OPENCODE_CONFIG_DIR === "string" ? env.OPENCODE_CONFIG_DIR.trim() : "";
  if (extra && !directories.includes(extra)) directories.push(extra);
  return directories;
}

/** The engine version the bundled sidecar records, so the SDK matches it exactly. */
export async function readSidecarVersion(versionsPath) {
  try {
    const parsed = JSON.parse(await readFile(versionsPath, "utf8"));
    const version = parsed?.opencode?.version;
    return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version) ? version : "";
  } catch {
    return "";
  }
}

/** Whether a directory already holds the pinned plugin at the wanted version. */
export async function sdkPresent(directory, version) {
  try {
    const parsed = JSON.parse(await readFile(path.join(directory, "node_modules", PLUGIN_PACKAGE, "package.json"), "utf8"));
    return parsed?.version === version;
  } catch {
    return false;
  }
}

function candidatePaths(name, env, platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const fromPath = (env.PATH ?? env.Path ?? "").split(paths.delimiter).filter(Boolean).map((dir) => paths.join(dir, name));
  // A Finder-launched app sees a short PATH; the usual install locations are checked as well.
  const home = env.HOME ?? "";
  const usual = platform === "win32"
    ? []
    : [
        `/opt/homebrew/bin/${name}`,
        `/usr/local/bin/${name}`,
        `/usr/bin/${name}`,
        home ? paths.join(home, ".bun", "bin", name) : "",
        home ? paths.join(home, ".volta", "bin", name) : "",
        home ? paths.join(home, ".nvm", "current", "bin", name) : "",
      ].filter(Boolean);
  return [...fromPath, ...usual];
}

/** `bun` first (what the engine itself uses), then `npm`; null when neither is on this Mac. */
export function findInstaller({ env = process.env, platform = process.platform, fileExists = existsSync } = {}) {
  for (const name of ["bun", "npm"]) {
    const binary = platform === "win32" ? `${name}.cmd` : name;
    const found = candidatePaths(binary, env, platform).find((candidate) => fileExists(candidate));
    if (found) return { name, path: found };
  }
  return null;
}

function installArguments(installer) {
  return installer.name === "bun"
    ? ["install", "--no-progress", "--silent"]
    : ["install", "--silent", "--no-audit", "--no-fund"];
}

function runInstaller(installer, directory, env, timeoutMs) {
  // `npm` is a script that needs `node` next to it; put the installer's own directory first on PATH.
  const binDir = path.dirname(installer.path);
  const childEnv = { ...env, PATH: [binDir, env.PATH ?? ""].filter(Boolean).join(path.delimiter) };
  return new Promise((resolve, reject) => {
    const child = execFile(installer.path, installArguments(installer), { cwd: directory, env: childEnv, timeout: timeoutMs, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${installer.name} install failed: ${String(stderr ?? "").trim().split("\n").slice(-1)[0] || error.message}`));
      else resolve();
    });
  });
}

/**
 * Seed every SDK directory that does not yet hold the pinned plugin. Returns
 * what happened per directory: `present` (nothing to do), `seeded`, or
 * `skipped` with a plain reason. Never throws.
 */
export async function prepareEngineSdk({
  version,
  env = process.env,
  homeDir = os.homedir(),
  installer = findInstaller({ env }),
  install = runInstaller,
  timeoutMs = INSTALL_TIMEOUT_MS,
  log = () => undefined,
} = {}) {
  if (!version) return { version: "", results: [], installer: installer?.name ?? "" };
  const results = [];
  for (const directory of engineSdkDirectories(env, homeDir)) {
    if (await sdkPresent(directory, version)) {
      results.push({ directory, outcome: "present" });
      continue;
    }
    if (!installer) {
      results.push({ directory, outcome: "skipped", reason: "no installer" });
      continue;
    }
    try {
      await mkdir(directory, { recursive: true });
      const manifestPath = path.join(directory, "package.json");
      let manifest = {};
      try {
        const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed;
      } catch {
        // A missing or unreadable manifest is written fresh; the engine writes the same shape.
      }
      const dependencies = manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies : {};
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, dependencies: { ...dependencies, [PLUGIN_PACKAGE]: version } }, null, 2)}\n`, "utf8");
      await install(installer, directory, env, timeoutMs);
      results.push({ directory, outcome: (await sdkPresent(directory, version)) ? "seeded" : "skipped", reason: "" });
    } catch (error) {
      results.push({ directory, outcome: "skipped", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  log(`engine sdk ${version}: ${results.map((entry) => `${entry.outcome}${entry.reason ? ` (${entry.reason})` : ""}`).join(", ")} via ${installer?.name ?? "nothing"}`);
  return { version, results, installer: installer?.name ?? "" };
}
