import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createComputerControl } from "./computer-control.mjs";
import { createRemoteComputerAdapter } from "./computer-remote.mjs";
import { createX11Driver } from "./computer-x11-driver.mjs";
import { browserEgressStatus, createCloudBrowser } from "./chromium.mjs";
import { BrowserSecretError, createBrowserSecrets } from "./browser-secrets.mjs";

const execute = promisify(execFile);
const failure = (code, error) => Object.assign(new Error(error), { code });
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const SECRETS_OFF = "Secrets for the cloud browser are not available for this organization.";

/** An operation's time limit whose clock stops while the operation waits for the person. */
function operationLimit(ms) {
  const controller = new AbortController();
  let left = ms, since = 0, waits = 0, ended = false;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const start = () => { since = Date.now(); timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), left); timer.unref?.(); };
  start();
  return {
    signal: controller.signal,
    /** Stops the clock until the returned function is called. */
    wait() {
      if (waits++ === 0) { clearTimeout(timer); left = Math.max(0, left - (Date.now() - since)); }
      let waiting = true;
      return () => { if (!waiting) return; waiting = false; if (--waits === 0 && !ended && !controller.signal.aborted) start(); };
    },
    end() { ended = true; clearTimeout(timer); },
  };
}

/**
 * One member-owned VM, one input lease, and the existing browser and computer contracts.
 * Programs always run standard JavaScript under the same VM authority checks.
 */
export async function createCloudComputer({ directory, display = ":99", enabled, machine, browserEndpoint, applications, onActivity = () => {}, privateBrowsing = false,
  secretsEnabled = async () => false,
  // How long one operation may run, not counting the time it waits for the person's answer; and how long an approval
  // to enter a secret waits for that answer before it counts as declined.
  operationMs = 120_000, requestMs = 300_000 }) {
  for (const value of [operationMs, requestMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Computer time limits must be positive bounded milliseconds.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Secret handles live in this process's memory only: never in `directory`, a command line, an environment
  // variable or the guest log. Each belongs to one conversation and is listed, used and removed by that
  // conversation's id alone, so the conversation that takes the computer next cannot reach it; a conversation
  // that gets the computer back still has its own. Everything is forgotten when the computer closes or the
  // organization's rollout is no longer verified.
  // A secret names https websites only; loopback http is accepted where the operator's diagnostic browser may open
  // loopback pages at all.
  const secrets = createBrowserSecrets({ allowLoopbackHttp: privateBrowsing === true });
  let secretsOn = false;
  let verifications = 0;
  let applied = 0;
  /** Conversation -> its one open approval to enter a secret. @type {Map<string, { request: Record<string, unknown>, settle: (allowed: boolean) => void }>} */
  const approvals = new Map();
  let owner = null;
  let paused = false;
  let generation = 0;
  let current = null;
  let busy = false;
  let closed = false;
  let verified = false;
  let authoritySuspended = false;
  let framePending = null;
  let runningScript = null;
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
  function dismissApprovals() { for (const pending of [...approvals.values()]) pending.settle(false); }
  /**
   * Asks the person, in the conversation whose operation is running, whether a named secret may be entered on `site`.
   * Asked every time; only the answer `allow` to this request's id is a yes. Takeover, Stop, the end of the operation,
   * a change of conversation, the rollout turning off and closing all answer no.
   */
  function approveSecret(sessionId, asked, signal) {
    return new Promise((resolve) => {
      const operation = current;
      if (!secretsOn || closed || paused || !operation || operation.generation !== generation || owner !== sessionId || signal?.aborted || operation.signal.aborted) { resolve(false); return; }
      approvals.get(sessionId)?.settle(false);
      const resume = operation.limit.wait();
      const decline = () => pending.settle(false);
      const pending = {
        request: { id: randomUUID(), reason: "credential", computer: "Cloud computer", placement: "remote", standing: false,
          credential: { site: String(asked?.site ?? ""), secret: { label: String(asked?.label ?? ""), kind: asked?.kind, field: String(asked?.field ?? "") } } },
        settle(allowed) {
          if (approvals.get(sessionId) !== pending) return;
          approvals.delete(sessionId);
          clearTimeout(timer); signal?.removeEventListener("abort", decline); operation.signal.removeEventListener("abort", decline);
          resume(); onActivity();
          resolve(allowed === true);
        },
      };
      const timer = setTimeout(decline, requestMs);
      timer.unref?.();
      approvals.set(sessionId, pending);
      signal?.addEventListener("abort", decline, { once: true });
      operation.signal.addEventListener("abort", decline, { once: true });
      onActivity();
    });
  }
  const browser = createCloudBrowser({ statePath: join(directory, "browser-tabs.json"), endpoint: browserEndpoint, privateBrowsing,
    enabled: () => !closed && !paused, assertActive,
    secrets, secretsEnabled: () => secretsOn && !closed, approveSecret,
    verifyEgress: async () => {
      const result = await browserEgressStatus(async (command, args) => {
        const result = await localMachine.run([command, ...args].map(quote).join(" "), 5000);
        if (result.exitCode !== 0) throw new Error("Kernel policy query failed");
        return result.stdout;
      });
      if (!result.ok) throw failure("egress_unavailable", "The cloud browser's private-network filter is unavailable. Reconnect the computer.");
    },
    // Browser input invalidates every native observation. Ending the native
    // lease leaves the browser alive; the next computer call opens a fresh one.
    beforeInput: async () => { assertActive(); if (owner) await control.endTurn({ sessionId: owner }); assertActive(); },
  });
  async function authorize() {
    const turn = ++verifications;
    const [allowed, handles] = closed ? [false, false] : await Promise.all([enabled().catch(() => false),
      Promise.resolve().then(secretsEnabled).then((on) => on === true, () => false)]);
    // An answer that was asked for before the one already applied says nothing newer about the rollout.
    if (turn > applied) {
      applied = turn;
      const on = allowed === true && handles && !closed;
      // Turning off forgets every secret and placeholder; a verification that finds it still on changes nothing.
      if (secretsOn && !on) { secrets.clear(); dismissApprovals(); }
      secretsOn = on;
    }
    verified = allowed;
    await control.setRemoteEnabled(allowed);
    if (!allowed) {
      authoritySuspended = true;
      generation++; current?.controller.abort(); browser.pause();
      throw failure("feature_disabled", "Cloud computer is unavailable for this organization.");
    }
    if (authoritySuspended && !paused && !busy) {
      browser.resume(); browser.invalidate();
      authoritySuspended = false;
    }
  }
  /** Every call from the person's side verifies both rollouts first, as every other call to this computer does. */
  async function assertSecrets() {
    await authorize().catch(() => {});
    if (!secretsOn) throw failure("feature_disabled", SECRETS_OFF);
  }
  const conversation = (sessionId) => typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256;
  async function halt() {
    generation++; current?.controller.abort(); dismissApprovals(); browser.pause(); browser.invalidate();
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
      let limit = null;
      try {
        if (owner && owner !== body.sessionId) { await halt(); browser.resume(); }
        owner = body.sessionId;
        const controller = new AbortController();
        limit = operationLimit(operationMs);
        current = { controller, generation, limit, signal: AbortSignal.any([signal, controller.signal, limit.signal]) };
        onActivity();
        assertActive();
        if (path === "/computer/program") {
          if (!["computer", "browser"].includes(body.surface) || typeof body.code !== "string" || body.code.length > 32_000
            || body.timeoutMs !== undefined && (!Number.isInteger(body.timeoutMs) || body.timeoutMs < 1000 || body.timeoutMs > 60_000)) throw failure("invalid_arguments", "Provide a surface, bounded code and a timeout from 1000 to 60000 milliseconds.");
          const { runComputerProgram } = await import("@openwork/computer-use/runtime");
          // The organization picks the interpreter; nothing in the request body can. Unreadable means the original.
          assertActive();
          const signal = current.signal;
          return await runComputerProgram(body, {
            computer: async (name, args, signal) => {
              assertActive(); browser.invalidate();
              const result = await control.execute({ sessionId: body.sessionId, name, args }, { signal, includePostImage: false });
              assertActive(); return result;
            },
            browser: async (operation, args, signal) => {
              assertActive();
              const result = await browser.request({ sessionId: body.sessionId, operation, args }, { signal, recovery: body.browserRecovery === true });
              assertActive(); return result;
            },
          }, signal);
        }
        if (path === "/browser/task") {
          const result = await browser.request(body, { signal: current.signal, recovery: body.browserRecovery === true });
          assertActive();
          return result;
        }
        if (path !== "/computer/task") throw failure("not_found", "Unknown computer operation.");
        if (applications && ["computer_apps", "computer_launch", "computer_app_script"].includes(body.name)) {
          // Application launches and scripts use the same input rail as browser/native input,
          // so Stop and takeover cancel them. Both invalidate coordinates from before.
          if (body.name !== "computer_apps" && owner) await control.endTurn({ sessionId: owner });
          browser.invalidate();
          assertActive();
          const script = body.name === "computer_app_script" ? applications.script(body.args, current.signal) : null;
          if (script) runningScript = script;
          let result;
          try { result = body.name === "computer_apps" ? await applications.list()
            : body.name === "computer_launch" ? await applications.launch(body.args, current.signal)
            : await script;
          } finally { if (runningScript === script) runningScript = null; }
          assertActive();
          return { ...(result?.ok === false ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        browser.invalidate();
        const result = await control.execute(body, { signal: current.signal });
        assertActive();
        return result;
      } finally { limit?.end(); busy = false; current = null; onActivity(); }
    },
    // The person's side of secret handles. None of these waits for `busy`: a secret is added and an approval is
    // answered while the operation that asked is still running.
    secrets: {
      async list(sessionId) { await assertSecrets(); return conversation(sessionId) ? secrets.list(sessionId) : []; },
      /** Never throws and never repeats what was typed: the value goes to the store and nowhere else. */
      async add(input) {
        try { await assertSecrets(); } catch { return { ok: false, code: "feature_disabled", error: SECRETS_OFF }; }
        try {
          if (!conversation(input?.sessionId)) throw new BrowserSecretError("invalid_secret", "A secret belongs to one conversation. Open a conversation first.");
          return { ok: true, secret: secrets.add({ sessionId: input.sessionId, label: input.label, kind: input.kind, origins: input.origins, value: input.value }) };
        } catch (error) { return { ok: false, code: "invalid_secret", error: error instanceof BrowserSecretError ? error.message : "The secret could not be saved." }; }
      },
      async remove(sessionId, secretRef) { await assertSecrets(); return conversation(sessionId) && typeof secretRef === "string" && secrets.remove(sessionId, secretRef); },
    },
    /** The open approval to enter a secret in this conversation, as the chat shows it; null when there is none. */
    async request(sessionId) {
      await assertSecrets();
      const pending = conversation(sessionId) ? approvals.get(sessionId) : undefined;
      if (!pending) return null;
      onActivity();
      return structuredClone(pending.request);
    },
    /** True when this answered the conversation's open approval. A wrong id or conversation answers nothing. */
    async answerRequest(input) {
      await assertSecrets();
      const pending = conversation(input?.sessionId) ? approvals.get(input.sessionId) : undefined;
      if (!pending || typeof input.id !== "string" || pending.request.id !== input.id) return false;
      pending.settle(input.answer === "allow");
      return true;
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
        await runningScript?.catch(() => {});
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
    async close() {
      closed = true; clearInterval(authorityTimer);
      secretsOn = false; dismissApprovals(); secrets.clear();
      await halt(); browser.close(); await control.reset(true);
    },
  };
}

export { browserEgressStatus } from "./chromium.mjs";
