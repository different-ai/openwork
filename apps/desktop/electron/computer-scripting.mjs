// Scriptable Mac apps for computer use: AppleScript or JXA through osascript, and
// Python inside Blender through a bridge Blender loads when OpenWork opens it. One
// script call replaces many clicks. The engine asks the person before each new app.
import { execFile, spawn as spawnProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const OUTPUT_LIMIT = 64 * 1024;
const BLENDER_ID = "org.blenderfoundation.blender";
const AUTOMATION_DENIED = "macOS has not allowed OpenWork to control this app. Allow OpenWork for it under System Settings › Privacy & Security › Automation, then try again.";

/**
 * The slice of a child process scripting uses.
 * @typedef {{ stdout: import("node:stream").Readable, stderr: import("node:stream").Readable, stdin: import("node:stream").Writable,
 *   kill(signal?: NodeJS.Signals): unknown, on(event: string, listener: (value: unknown) => void): unknown, unref?(): unknown }} ScriptProcess
 * @typedef {(command: string, args: string[], options: import("node:child_process").SpawnOptions) => ScriptProcess} SpawnScript
 */
const tail = (value) => value.length > OUTPUT_LIMIT ? value.slice(-OUTPUT_LIMIT) : value;

async function defaultLocateBlender() {
  if (existsSync("/Applications/Blender.app")) return "/Applications/Blender.app";
  try {
    const { stdout } = await run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == "${BLENDER_ID}"`], { timeout: 5_000 });
    return stdout.split("\n").find((line) => line.endsWith(".app")) ?? null;
  } catch { return null; }
}

async function defaultBlenderRunning() {
  try { await run("/usr/bin/pgrep", ["-x", "Blender"], { timeout: 2_000 }); return true; } catch { return false; }
}

/**
 * Main-process only. Dependencies are for tests.
 * @param {{
 *   stateDir: string,
 *   bridgeScript: string,
 *   platform?: string,
 *   spawn?: SpawnScript,
 *   connectSocket?: typeof connect,
 *   locateBlender?: () => Promise<string | null>,
 *   blenderRunning?: () => Promise<boolean>,
 *   launchWaitMs?: number,
 * }} options
 */
export function createComputerScripting({ stateDir, bridgeScript, platform = process.platform, spawn = spawnProcess, connectSocket = connect,
  locateBlender = defaultLocateBlender, blenderRunning = defaultBlenderRunning, launchWaitMs = 45_000 }) {
  const socketPath = path.join(stateDir, "blender.sock");
  let token = null;

  /** AppleScript or JXA, run as this user. Output is capped; a timeout or Stop ends the process. */
  function osascript(language, code, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/osascript", ["-l", language, "-"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? "" } });
      let stdout = "", stderr = "", settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener("abort", stop);
        if (error) reject(error); else resolve(value);
      };
      const stop = () => { child.kill("SIGKILL"); finish(null, new Error("The script was stopped. Its effects so far may have landed.")); };
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null, new Error("The script did not finish in time. Its effects so far may have landed.")); }, timeoutMs);
      if (signal.aborted) { stop(); return; }
      signal.addEventListener("abort", stop, { once: true });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout = tail(stdout + chunk); });
      child.stderr.on("data", (chunk) => { stderr = tail(stderr + chunk); });
      child.on("error", (error) => finish(null, error instanceof Error ? error : new Error(String(error))));
      child.on("close", (status) => {
        const message = stderr.trim();
        if (status === 0) finish({ ok: true, stdout: stdout.trimEnd(), ...(message ? { stderr: message } : {}) });
        else finish({ ok: false, stdout: stdout.trimEnd(), error: { code: message.includes("-1743") ? "automation_denied" : "script_error", message: message.includes("-1743") ? AUTOMATION_DENIED : message || `osascript exited with status ${status}.` }, mayHaveActed: true });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(code);
    });
  }

  /** One request to the Blender bridge; rejects with `code: "unreachable"` when no bridge answers. */
  function bridge(code, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const socket = connectSocket(socketPath);
      let reply = "", connected = false, settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener("abort", stop); socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const stop = () => {
        // Ask the bridge to stop the script at its next Python line, then stop waiting.
        const cancel = connectSocket(socketPath);
        cancel.on("error", () => {});
        cancel.on("connect", () => cancel.end(`${JSON.stringify({ token, cancel: true })}\n`));
        finish(null, new Error("The script was stopped. Blender stops it at its next Python line; effects so far may have landed."));
      };
      const timer = setTimeout(() => finish(null, new Error("Blender did not answer in time. It may still be running the script.")), timeoutMs + 5_000);
      if (signal.aborted) { stop(); return; }
      signal.addEventListener("abort", stop, { once: true });
      socket.setEncoding("utf8");
      socket.on("connect", () => { connected = true; socket.write(`${JSON.stringify({ token, code, timeoutMs })}\n`); });
      socket.on("data", (chunk) => {
        reply += chunk;
        if (reply.length > 4 * OUTPUT_LIMIT) { finish(null, new Error("Blender's reply was too large.")); return; }
        const end = reply.indexOf("\n");
        if (end === -1) return;
        try { finish(JSON.parse(reply.slice(0, end))); } catch { finish(null, new Error("Blender's reply was unreadable.")); }
      });
      socket.on("error", (error) => finish(null, connected ? error : Object.assign(new Error("No Blender bridge is listening."), { code: "unreachable" })));
      socket.on("close", () => finish(null, connected ? new Error("Blender closed the connection without a reply.") : Object.assign(new Error("No Blender bridge is listening."), { code: "unreachable" })));
    });
  }

  /** Opens Blender with OpenWork's bridge, unless a Blender without it is already open. */
  async function launchBlender(signal) {
    if (await blenderRunning()) {
      throw new Error("Blender is already open without OpenWork's script bridge. Ask the person to save their work and quit Blender; the next script then opens it with the bridge. Otherwise use computer_open and computer_act.");
    }
    const app = await locateBlender();
    if (!app) throw new Error("Blender is not installed on this Mac.");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    token = randomBytes(32).toString("hex");
    await writeFile(path.join(stateDir, "blender.token"), token, { mode: 0o600 });
    // Launch Services, not a child process: Blender keeps running if OpenWork quits.
    const opener = spawn("/usr/bin/open", ["-n", "-a", app, "--args", "--python", bridgeScript, "--", stateDir], { stdio: "ignore", detached: true });
    opener.on("error", () => {});
    opener.unref();
    const deadline = Date.now() + launchWaitMs;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (existsSync(socketPath)) return;
    }
    throw new Error("Blender opened but OpenWork's script bridge did not start. Check Blender's Python console.");
  }

  async function blender(code, timeoutMs, signal) {
    if (socketPath.length > 100) throw new Error("OpenWork's data folder path is too long for Blender's script bridge.");
    // A Blender opened before OpenWork restarted still holds the token on disk.
    token ??= await readFile(path.join(stateDir, "blender.token"), "utf8").then((value) => value.trim() || null, () => null);
    if (token) {
      try { return await bridge(code, timeoutMs, signal); }
      catch (error) { if (error?.code !== "unreachable") throw error; }
    }
    await launchBlender(signal);
    for (let attempt = 0; ; attempt++) {
      try { return await bridge(code, timeoutMs, signal); }
      catch (error) {
        if (error?.code !== "unreachable" || attempt >= 10) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  /**
   * @param {{ app: string, code: string, timeoutMs: number }} request
   * @param {AbortSignal} signal
   * @returns {Promise<import("@openwork/computer-use/computer-control").ScriptResult>}
   */
  return async function runScript({ app, code, timeoutMs }, signal) {
    if (platform !== "darwin") return { ok: false, error: { code: "script_unavailable", message: "App scripting is available on macOS only." } };
    if (app === "applescript") return osascript("AppleScript", code, timeoutMs, signal);
    if (app === "jxa") return osascript("JavaScript", code, timeoutMs, signal);
    if (app === "blender") return blender(code, timeoutMs, signal);
    return { ok: false, error: { code: "invalid_arguments", message: "Choose applescript, jxa or blender." } };
  };
}
