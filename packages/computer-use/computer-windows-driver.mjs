// A computer use driver for this Windows PC. The desktop's main process starts
// the Windows helper (windows/ComputerUse.cs, shipped as
// helpers/openwork-computer-use.exe) and talks to it over stdin/stdout, one JSON
// object per line. The helper resolves each window by handle, process id and
// start time, captures only the selected window, and stops input as soon as the
// window loses focus, moves or closes, Windows locks, the host cancels, or the
// person clicks or types. It takes the front only for the agent's moment and
// then gives the front and the pointer back.
// Sessions, receipts, Take over, Continue, Stop and watch frames come from the
// shared runtime in computer-remote.mjs.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export const WINDOWS_HELPER_PROTOCOL = "openwork.computer-use.windows/1";
const MODIFIERS = { control: "control", command: "control", shift: "shift", option: "alt" };
const KEYS = new Set(["enter", "tab", "escape", "backspace", "delete", "insert", "space", "left", "up", "right", "down", "home", "end", "page_up", "page_down",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`), ..."abcdefghijklmnopqrstuvwxyz0123456789"]);
const ALIASES = { return: "enter", esc: "escape", arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", pageup: "page_up", pagedown: "page_down", del: "delete", spacebar: "space", " ": "space" };
// Clipboard, close/quit and app-switch chords, as the Mac helper refuses them.
// A chord containing one of these (control+shift+v) is refused too.
const BLOCKED = ["control+c", "control+x", "control+v", "control+insert", "shift+insert", "shift+delete", "control+w", "control+f4", "control+q",
  "alt+f4", "alt+tab", "alt+escape", "alt+space", "control+escape", "control+shift+escape", "control+alt+delete"].map((chord) => chord.split("+"));
const MISSING = "The Windows computer use helper is missing from this OpenWork build. Rebuild or reinstall OpenWork.";
// What --check reports when this PC can't be used right now.
const REASONS = {
  windows_version: ["unsupported", "Computer use needs Windows 10 version 1703 or later."],
  noninteractive: ["unsupported", "OpenWork isn't running in a signed-in Windows desktop session, so computer use can't see or use apps."],
  dpi_unaware: ["unavailable", "Windows did not let the computer use helper read display scaling. Restart OpenWork and try again."],
  disconnected: ["unavailable", "This Windows session is disconnected. Reconnect to it, then try again."],
  desktop_unavailable: ["unavailable", "Windows is locked or showing a secure prompt. Unlock it or answer the prompt, then try again."],
};
// The helper needs no credentials, Node options or user configuration.
const ENVIRONMENT = ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP"];

const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const validRegion = (region) => region && typeof region === "object" && ["x", "y"].every((key) => integer(region[key], -1_000_000, 1_000_000))
  && ["width", "height"].every((key) => integer(region[key], 1, 1_000_000));

/** Windows key names for one action; Mac-style names and modifiers are translated. */
export function windowsStep(step) {
  const translated = { ...step };
  if (step.modifiers !== undefined) translated.modifiers = [...new Set(step.modifiers.map((modifier) => {
    if (!Object.hasOwn(MODIFIERS, modifier)) throw new Error(`Unknown modifier ${String(modifier)}.`);
    return MODIFIERS[modifier];
  }))];
  if (step.type === "key") {
    const raw = String(step.key);
    const key = ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
    if (!KEYS.has(key)) throw new Error(`Windows has no key named ${raw.slice(0, 24)}. Use one listed by computer_discover, or type for text.`);
    const held = new Set([...(translated.modifiers ?? []), key]);
    if (BLOCKED.some((chord) => chord.includes(key) && chord.every((part) => held.has(part)))) {
      throw new Error("Clipboard, close and app-switch shortcuts are unavailable. Use type or the app's own controls. Nothing was sent.");
    }
    translated.key = key;
  }
  return translated;
}

/**
 * @param {{
 *   binary: () => string | null,
 *   spawnChild?: typeof spawn,
 *   hostPid?: number,
 *   env?: NodeJS.ProcessEnv,
 *   timeouts?: Partial<Record<"check" | "start" | "call" | "input" | "close" | "idle", number>>,
 * }} options
 * @returns {import("./computer-remote.mjs").ComputerDriver & { close: () => Promise<void> }}
 */
export function createWindowsDriver({ binary, spawnChild = spawn, hostPid = process.pid, env = process.env, timeouts = {} }) {
  const limits = { check: 5_000, start: 10_000, call: 20_000, input: 60_000, close: 3_000, idle: 60_000, ...timeouts };
  const childEnv = Object.fromEntries(ENVIRONMENT.filter((key) => typeof env[key] === "string").map((key) => [key, env[key]]));
  /** @type {null | { child: import("node:child_process").ChildProcess, pending: Map<string, { resolve: (value: any) => void, reject: (error: Error) => void }>, ready: Promise<void>, exited: Promise<void>, idle?: NodeJS.Timeout }} */
  let helper = null;
  // A window id is stable only for one window of one process run: a reused
  // handle or a restarted app gets a new id, so old observations never match it.
  const ids = new Map();
  const identities = new Map();
  const regions = new Map();
  let nextId = 1;

  function readLines(stream, limit, onLine) {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) onLine(line);
      }
      if (buffer.length > limit) { buffer = ""; onLine(null); }
    });
  }

  function start() {
    const executable = binary();
    if (!executable) throw new Error(MISSING);
    const child = spawnChild(executable, ["serve", "--host-pid", String(hostPid)], { env: childEnv, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const pending = new Map();
    let acceptReady, rejectReady;
    const ready = new Promise((resolve, reject) => { acceptReady = resolve; rejectReady = reject; });
    // A helper that never started reports only "error".
    const exited = new Promise((resolve) => { child.once("close", () => resolve(undefined)); child.once("error", () => resolve(undefined)); });
    const record = { child, pending, ready, exited };
    let started = false;
    const fail = (error) => {
      rejectReady(error);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      if (helper === record) helper = null;
      clearTimeout(record.idle);
    };
    void exited.then(() => fail(new Error("The Windows helper stopped. Observe before continuing; nothing is replayed.")));
    child.on("error", () => { fail(new Error(MISSING)); try { child.kill(); } catch {} });
    child.stdin.on("error", () => {});
    // Base64 screenshots of a large window stay well under this.
    readLines(child.stdout, 48 * 1024 * 1024, (line) => {
      let message = null;
      try { message = line === null ? null : JSON.parse(line); } catch {}
      if (!message || typeof message !== "object" || Array.isArray(message)) { fail(new Error("The Windows helper sent an invalid reply.")); child.kill(); return; }
      if (!started) {
        if (message.type === "ready" && message.protocol === WINDOWS_HELPER_PROTOCOL) { started = true; acceptReady(); return; }
        const reason = REASONS[message.code]?.[1];
        fail(new Error(reason ?? "The Windows helper is incompatible with this OpenWork build. Rebuild or reinstall OpenWork."));
        child.kill();
        return;
      }
      const entry = typeof message.id === "string" ? pending.get(message.id) : undefined;
      if (!entry) return;
      pending.delete(message.id);
      entry.resolve(message);
    });
    const timer = setTimeout(() => { fail(new Error("The Windows helper did not start in time.")); child.kill(); }, limits.start);
    void ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    return record;
  }

  async function ensure() {
    if (!helper) helper = start();
    const record = helper;
    clearTimeout(record.idle);
    await record.ready;
    return record;
  }

  // An idle helper exits so no input-capable process outlives the work.
  function scheduleIdle(record) {
    clearTimeout(record.idle);
    if (record.pending.size || helper !== record) return;
    record.idle = setTimeout(() => { if (helper === record && !record.pending.size) void stop(record); }, limits.idle);
    record.idle.unref?.();
  }

  async function stop(record) {
    if (helper === record) helper = null;
    clearTimeout(record.idle);
    // Closing stdin cancels any input and releases held keys and buttons.
    try { record.child.stdin.end(); } catch {}
    let timer;
    const done = await Promise.race([record.exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), limits.close); })]);
    clearTimeout(timer);
    if (!done) {
      try { record.child.kill(); } catch {}
      await record.exited;
    }
  }

  async function call(op, fields = {}, { id = randomUUID(), timeoutMs = limits.call } = {}) {
    const record = await ensure();
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          record.pending.delete(id);
          reject(new Error("The Windows helper did not answer in time. Observe before continuing; nothing is replayed."));
        }, timeoutMs);
        record.pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        record.child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`, (error) => {
          if (!error || !record.pending.has(id)) return;
          record.pending.delete(id);
          clearTimeout(timer);
          reject(new Error("The Windows helper stopped. Observe before continuing; nothing is replayed."));
        });
      });
    } finally { scheduleIdle(record); }
  }

  const answer = (result) => {
    if (result?.ok !== true) throw new Error(typeof result?.message === "string" ? result.message : "The Windows helper refused this request.");
    return result;
  };
  const identity = (id) => {
    const value = identities.get(id);
    if (!value) throw new Error("Unknown window. Call computer_discover again.");
    return value;
  };

  return {
    platform: "windows",
    wholeScreen: false,
    notes: {
      keyboard: `Windows: use control for shortcuts; command is sent as control and option as alt. Keys: ${[...KEYS].filter((key) => key.length > 1).join(", ")}, letters and digits. Use type for other text.`,
      observe: "Observations are screenshots of the selected window; act with coordinates from the observation image. Accessible controls (assist mode) are not available on Windows yet.",
    },
    async describe() {
      const executable = binary();
      if (!executable) return { readiness: "unavailable", detail: MISSING };
      try {
        const child = spawnChild(executable, ["--check"], { env: childEnv, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        const output = await new Promise((resolve, reject) => {
          let text = "";
          const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, limits.check);
          child.on("error", (error) => { clearTimeout(timer); reject(error); });
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk) => { text += chunk; if (text.length > 16_384) child.kill(); });
          child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error(`status ${code}`)); });
        });
        const state = JSON.parse(String(output));
        if (state?.protocol !== WINDOWS_HELPER_PROTOCOL || typeof state.ok !== "boolean") {
          return { readiness: "unavailable", detail: "The Windows helper is incompatible with this OpenWork build. Rebuild or reinstall OpenWork." };
        }
        if (state.ok) return { readiness: "ready", detail: "Computer use is ready. This chat can use app windows on this PC for its task." };
        const [readiness, detail] = REASONS[state.reason] ?? ["unavailable", "Computer use isn't available on this PC right now."];
        return { readiness, detail };
      } catch {
        return { readiness: "unavailable", detail: "The Windows computer use helper could not report its status. Rebuild or reinstall OpenWork." };
      }
    },
    async screen() {
      throw new Error("Whole-screen control is not available on this PC. Open an app window instead.");
    },
    async windows() {
      const result = answer(await call("windows"));
      if (!Array.isArray(result.windows)) throw new Error("The Windows helper returned an invalid window list.");
      const listed = [];
      const seen = new Set();
      for (const window of result.windows.slice(0, 128)) {
        if (!window || typeof window.hwnd !== "string" || !/^[1-9]\d{0,19}$/.test(window.hwnd) || !integer(window.pid, 1, 0xffffffff)
          || typeof window.started !== "string" || !/^\d{1,20}$/.test(window.started) || typeof window.app !== "string" || !window.app
          || typeof window.title !== "string" || !validRegion(window.region)) continue;
        const key = `${window.hwnd}:${window.pid}:${window.started}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let id = ids.get(key);
        if (id === undefined) { id = nextId++; ids.set(key, id); }
        const region = { x: window.region.x, y: window.region.y, width: window.region.width, height: window.region.height };
        identities.set(id, { hwnd: window.hwnd, pid: window.pid, started: window.started });
        regions.set(id, region);
        // A window the agent can't use keeps its caption (a document, account or command) private.
        const restricted = typeof window.restricted === "string";
        listed.push({ id, app: window.app.slice(0, 120), name: typeof window.name === "string" && window.name ? window.name.slice(0, 120) : window.app.slice(0, 120),
          title: restricted ? "Unavailable window" : window.title.slice(0, 500) || "Untitled window", region, focused: window.focused === true,
          ...(restricted ? { restricted: typeof window.message === "string" ? window.message.slice(0, 300) : "This window can't be used." } : {}) });
      }
      // Forget windows that are gone; their ids are never reused.
      for (const [key, id] of ids) if (!seen.has(key)) { ids.delete(key); identities.delete(id); regions.delete(id); }
      return listed;
    },
    async focus(id) {
      answer(await call("focus", { window: identity(id) }));
    },
    async screenshot(region, { maxWidth, windowId } = {}) {
      if (windowId === undefined) throw new Error("Whole-screen capture is not available on this PC.");
      const result = answer(await call("capture", { window: identity(windowId), region, ...(maxWidth ? { maxWidth: Math.round(maxWidth) } : {}) }));
      if (!integer(result.width, 1, 16_384) || !integer(result.height, 1, 16_384) || typeof result.png !== "string") throw new Error("The Windows helper returned an invalid screenshot.");
      const png = Buffer.from(result.png, "base64");
      if (!png.byteLength) throw new Error("The screenshot is empty.");
      return { png: new Uint8Array(png), width: result.width, height: result.height };
    },
    interruptibleInput: true,
    async input(steps, { windowId, signal } = {}) {
      signal?.throwIfAborted();
      if (windowId === undefined) return { completed: 0, attempted: false, error: "Whole-screen input is not available on this PC." };
      let translated;
      try { translated = steps.map(windowsStep); } catch (error) { return { completed: 0, attempted: false, error: error instanceof Error ? error.message : String(error) }; }
      const id = randomUUID();
      // Cancellation is answered by the helper at once, even before this input starts.
      const cancel = () => { void call("cancel", { target: id }).catch(() => {}); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const result = await call("input", { window: identity(windowId), expect: regions.get(windowId), steps: translated }, { id, timeoutMs: limits.input });
        if (result.ok !== true) return { completed: 0, attempted: false, error: typeof result.message === "string" ? result.message : "The window refused input." };
        return { completed: integer(result.completed, 0, translated.length) ? result.completed : 0, attempted: result.attempted !== false,
          ...(typeof result.error === "string" ? { error: result.error } : {}) };
      } finally { signal?.removeEventListener("abort", cancel); }
    },
    /** Ends the helper; the next call starts a new one. */
    async close() {
      if (helper) await stop(helper);
    },
  };
}
