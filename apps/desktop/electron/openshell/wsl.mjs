// Thin wrapper around wsl.exe. Every other OpenShell module talks to WSL
// through this file so the orphan-process workaround (microsoft/WSL#12159)
// and the UTF-16/UTF-8 encoding flip are handled in exactly one place.
//
// On Linux/macOS dev boxes wsl.exe doesn't exist; tests set
// OPENWORK_WSL_EXE to a recording shell script.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const DISTRO_NAME = "openwork-openshell";

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveWslExe() {
  return process.env.OPENWORK_WSL_EXE || "wsl.exe";
}

// Older wsl.exe emits UTF-16 LE for `--list` etc.; newer versions emit
// UTF-8. Detect the encoding from the buffer rather than trusting the
// version, since users will run a mix in the field.
function decodeWslOutput(buf) {
  if (!buf || buf.length === 0) return "";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0) {
    return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}

function injectUser(args, user) {
  if (!user) return args;
  // Splice --user immediately after -d <distro> if present, else prepend.
  const dIdx = args.indexOf("-d");
  if (dIdx >= 0 && dIdx + 1 < args.length) {
    const out = args.slice();
    out.splice(dIdx + 2, 0, "--user", user);
    return out;
  }
  return ["--user", user, ...args];
}

export async function wslRun(args, options = {}) {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    user,
    cwd,
    env,
    stdin,
    signal,
  } = options;
  const exe = resolveWslExe();
  const finalArgs = injectUser(args, user);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, finalArgs, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));

    let timedOut = false;
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeout)
        : null;

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `wsl.exe timed out after ${timeout}ms running: ${finalArgs.join(" ")}`,
          ),
        );
        return;
      }
      resolve({
        exitCode: code,
        stdout: decodeWslOutput(Buffer.concat(stdoutChunks)),
        stderr: decodeWslOutput(Buffer.concat(stderrChunks)),
      });
    });

    if (stdin !== undefined && stdin !== null) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

export function wslSpawn(args, options = {}) {
  const { user, cwd, env } = options;
  const exe = resolveWslExe();
  const finalArgs = injectUser(args, user);

  const child = spawn(exe, finalArgs, {
    cwd,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // wsl.exe processes can outlive the spawning Node child because the
  // Linux-side process keeps the WSL utility VM alive. Killing the
  // Node-side child does not propagate (microsoft/WSL#12159). On kill,
  // also terminate the distro session so orphans don't accumulate over
  // a long banker session.
  const baseKill = child.kill.bind(child);
  child.kill = (signal) => {
    try {
      const reaper = spawn(exe, ["-t", DISTRO_NAME], {
        windowsHide: true,
        stdio: "ignore",
      });
      reaper.on("error", () => {});
    } catch {
      // Best-effort. Caller's signal below is the real exit path.
    }
    return baseKill(signal);
  };

  return child;
}

export async function distroExists() {
  const r = await wslRun(["--list", "--quiet"], { timeout: 10_000 });
  if (r.exitCode !== 0) return false;
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .includes(DISTRO_NAME);
}

// Parses `wsl.exe --list --verbose`. Returns one of:
// "Running" | "Stopped" | "Installing" | "NotFound".
export async function distroState() {
  const r = await wslRun(["--list", "--verbose"], { timeout: 10_000 });
  if (r.exitCode !== 0) return "NotFound";
  for (const raw of r.stdout.split(/\r?\n/)) {
    const line = raw.replace(/^\*/, "").trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    if (cols[0] === DISTRO_NAME) {
      const state = cols[1];
      if (state === "Running" || state === "Stopped" || state === "Installing") {
        return state;
      }
      return "Stopped";
    }
  }
  return "NotFound";
}

export async function ensureDistroRunning() {
  let state = await distroState();
  if (state === "NotFound") {
    throw new Error(
      `WSL distro "${DISTRO_NAME}" is not registered. Run the OpenShell installer.`,
    );
  }
  if (state === "Running") return;
  await wslRun(["-d", DISTRO_NAME, "--exec", "true"], { timeout: 30_000 });
  for (let i = 0; i < 30; i++) {
    state = await distroState();
    if (state === "Running") return;
    await delay(500);
  }
  throw new Error(`WSL distro "${DISTRO_NAME}" did not reach Running state.`);
}

// C:\Users\j\workspace → /mnt/c/Users/j/workspace
export function toWslPath(winPath) {
  if (typeof winPath !== "string" || winPath.length === 0) return winPath;
  const p = winPath.replace(/^"+|"+$/g, "");
  const drive = p.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive) {
    return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`;
  }
  if (p.startsWith("/")) return p;
  return p.replace(/\\/g, "/");
}

// /mnt/c/Users/j/workspace → C:\Users\j\workspace
export function toWindowsPath(wslPath) {
  if (typeof wslPath !== "string" || wslPath.length === 0) return wslPath;
  const m = wslPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (m) {
    return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
  }
  return wslPath;
}
