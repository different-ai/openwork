import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createComputerControl } from "./computer-control.mjs";
import { createRemoteComputerAdapter } from "./computer-remote.mjs";
import { createX11Driver } from "./computer-x11-driver.mjs";
import { createCloudBrowser } from "./chromium.mjs";

const execute = promisify(execFile);
const failure = (code, error) => Object.assign(new Error(error), { code });

/** One member-owned VM, one input lease, and the existing browser and computer contracts. */
export async function createCloudComputer({ directory, display = ":99", enabled, machine, browserEndpoint, applications, onActivity = () => {} }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let owner = null;
  let paused = false;
  let generation = 0;
  let current = null;
  let busy = false;
  let closed = false;
  let verified = false;
  let framePending = null;
  const localMachine = machine ?? {
    async run(command, timeout) {
      try {
        // Input cancellation travels over an independent worker connection.
        // Aborting every provider command with the task would also kill that
        // cancellation connection and leave detached typing running.
        const result = await execute("/bin/sh", ["-c", command], { timeout, maxBuffer: 1024 * 1024 });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        if (error.killed || current?.signal.aborted) throw error;
        return { exitCode: typeof error.code === "number" ? error.code : 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message) };
      }
    },
    read: path => readFile(path),
  };
  const driver = createX11Driver({ machine: localMachine, display });
  const control = createComputerControl({
    adapters: [createRemoteComputerAdapter({ id: "cloud-computer", label: "Cloud computer", driver })],
    readRemoteFeatureEnabled: async () => verified,
  });
  function assertActive() {
    if (closed || paused || !current || current.generation !== generation) throw failure("paused", "Computer control was interrupted. Observe again after Continue.");
    current.signal.throwIfAborted();
  }
  const browser = createCloudBrowser({ statePath: join(directory, "browser-tabs.json"), endpoint: browserEndpoint,
    enabled: () => !closed && !paused, assertActive,
    // Browser input invalidates every native observation. Ending the native
    // lease leaves the browser alive; the next computer call opens a fresh one.
    beforeInput: async () => { assertActive(); if (owner) await control.endTurn({ sessionId: owner }); assertActive(); },
  });
  async function authorize() {
    const allowed = !closed && await enabled().catch(() => false);
    verified = allowed;
    await control.setFeatureEnabled(allowed);
    await control.setRemoteEnabled(allowed);
    if (!allowed) {
      generation++; current?.controller.abort(); browser.pause();
      throw failure("feature_disabled", "Cloud computer is unavailable for this organization.");
    }
  }
  async function halt() {
    generation++; current?.controller.abort(); browser.pause(); browser.invalidate();
    if (owner) await control.halt({ sessionId: owner });
  }
  const authorityTimer = setInterval(() => { void authorize().catch(() => {}); }, 30_000);
  authorityTimer.unref?.();
  return {
    async task(path, body, signal = new AbortController().signal) {
      await authorize();
      if (typeof body?.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256) throw failure("invalid_session", "A conversation is required.");
      if (paused) throw failure("paused", "The person has control. Wait for Continue, then observe again.");
      if (busy) throw failure("busy", "The computer is already running an operation. Wait for its receipt.");
      // Reserve the shared input rail before an awaited ownership change.
      busy = true;
      try {
        if (owner && owner !== body.sessionId) { await halt(); browser.resume(); }
        owner = body.sessionId;
        const controller = new AbortController();
        current = { controller, generation, signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(120_000)]) };
        onActivity();
        assertActive();
        if (path === "/computer/program") {
          if (!["computer", "browser"].includes(body.surface) || typeof body.code !== "string" || body.code.length > 32_000
            || body.timeoutMs !== undefined && (!Number.isInteger(body.timeoutMs) || body.timeoutMs < 1000 || body.timeoutMs > 60_000)) throw failure("invalid_arguments", "Provide a surface, bounded code and a timeout from 1000 to 60000 milliseconds.");
          const { runComputerProgram } = await import("@openwork/computer-use/runtime");
          const signal = current.signal;
          return await runComputerProgram(body, {
            computer: async (name, args, signal) => {
              assertActive(); browser.invalidate();
              const result = await control.execute({ sessionId: body.sessionId, name, args }, { signal, includePostImage: false });
              assertActive(); return result;
            },
            browser: async (operation, args, signal) => {
              assertActive();
              const result = await browser.request({ sessionId: body.sessionId, operation, args }, { signal });
              assertActive(); return result;
            },
          }, signal);
        }
        if (path === "/browser/task") {
          const result = await browser.request(body, { signal: current.signal });
          assertActive();
          return result;
        }
        if (path !== "/computer/task") throw failure("not_found", "Unknown computer operation.");
        if (applications && ["computer_apps", "computer_launch"].includes(body.name)) {
          // Application launches use the same input rail as browser/native input.
          // Releasing the native lease invalidates coordinates from before launch.
          if (body.name === "computer_launch" && owner) await control.endTurn({ sessionId: owner });
          browser.invalidate();
          assertActive();
          const result = body.name === "computer_apps" ? await applications.list() : await applications.launch(body.args, current.signal);
          assertActive();
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        browser.invalidate();
        const result = await control.execute(body, { signal: current.signal });
        assertActive();
        return result;
      } finally { busy = false; current = null; onActivity(); }
    },
    async snapshot() {
      await authorize();
      return { ready: (await driver.describe()).readiness === "ready", paused, busy, sessionId: owner };
    },
    async frame() {
      if (framePending) return framePending;
      framePending = (async () => {
      await authorize();
      const revision = generation;
      const screen = await driver.screen();
      const frame = await driver.screenshot(screen, { maxWidth: 1280 });
      if (revision !== generation || closed) throw failure("frame_changed", "The computer view changed. Refresh it.");
      onActivity();
      return { dataUrl: `data:image/png;base64,${Buffer.from(frame.png).toString("base64")}`, width: frame.width, height: frame.height, screenWidth: screen.width, screenHeight: screen.height, generation };
      })();
      try { return await framePending; } finally { framePending = null; }
    },
    async interact(input) {
      await authorize();
      if (input.action === "takeover" || input.action === "stop") {
        paused = true;
        await halt();
        onActivity();
        return { ok: true, paused };
      }
      if (input.action === "resume") {
        if (busy) throw failure("busy", "Wait for the interrupted operation to finish before Continue.");
        if (owner) await control.endTurn({ sessionId: owner });
        generation++; paused = false; browser.resume(); browser.invalidate();
        onActivity();
        return { ok: true, paused };
      }
      if (!paused || busy || input.generation !== generation) throw failure("view_changed", "Take over and refresh the computer before interacting.");
      const screen = await driver.screen();
      if (input.type === "click" || input.type === "scroll") {
        if (![input.x, input.y].every(Number.isFinite) || input.x < 0 || input.y < 0 || input.x >= screen.width || input.y >= screen.height) throw failure("invalid_point", "Choose a point inside the desktop.");
      }
      const revision = generation;
      if (input.type === "type" && (typeof input.text !== "string" || input.text.length > 500)) throw failure("invalid_input", "Enter at most 500 characters.");
      if (input.type === "key" && !["enter", "tab", "escape", "backspace", "delete", "home", "end", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(input.key)) throw failure("invalid_key", "Use a supported desktop key.");
      if (!["click", "type", "key", "scroll"].includes(input.type)) throw failure("invalid_input", "Use a supported desktop action.");
      if (input.type === "scroll" && (!Number.isFinite(input.delta_y) || Math.abs(input.delta_y) > 1200)) throw failure("invalid_input", "Scroll within the desktop.");
      if (revision !== generation || !paused || busy) throw failure("view_changed", "The desktop changed before input.");
      // Copy only validated fields. Never accept a shell command or an input batch.
      const action = input.type === "click" ? { type: "click", x: input.x, y: input.y }
        : input.type === "scroll" ? { type: "scroll", x: input.x, y: input.y, delta_y: input.delta_y, delta_x: 0 }
        : input.type === "key" ? { type: "key", key: input.key } : { type: "type", text: input.text };
      busy = true;
      try { onActivity(); const result = await driver.input([action]); if (result.error) throw failure("input_uncertain", `${result.error} Inspect the desktop before retrying.`); return result; }
      finally { busy = false; onActivity(); }
    },
    async close() { closed = true; clearInterval(authorityTimer); await halt(); browser.close(); await control.reset(true); },
  };
}
