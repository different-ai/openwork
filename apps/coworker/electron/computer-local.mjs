import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperName = "OpenWork Computer Use.app";
const protocolVersion = "openwork.computer-use/1";
const toolNames = new Set([
  "computer_discover",
  "computer_open_session",
  "computer_observe",
  "computer_act",
  "computer_session_status",
  "computer_close_session",
]);

async function loadMcp() {
  const [{ Client }, { StdioClientTransport }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("zod"),
  ]);
  return { Client, StdioClientTransport, uiNotificationSchema: z.object({ method: z.literal("openwork/ui"), params: z.unknown() }) };
}

async function bounded(work, timeoutMs, signal) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Computer Use timed out.")), timeoutMs);
  const cancelled = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return work({ signal: controller.signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs, resetTimeoutOnProgress: false });
      }),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** Main-process only. Dependencies are for tests, never renderer configuration. */
export function createLocalComputerAdapter({
  platform = process.platform,
  osRelease = release(),
  resourcesPath = process.resourcesPath,
  fileExists = existsSync,
  spawnChild = spawn,
  mcp = loadMcp,
  onSetupReturn = () => {},
  timeouts = {},
} = {}) {
  const limits = { probe: 5_000, handshake: 5_000, call: 120_000, close: 7_000, setupPoll: 1_000, setupLifetime: 300_000, ...timeouts };
  // Do not pass provider credentials, Node preload flags or dynamic-loader overrides.
  const env = Object.fromEntries(["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "TMPDIR"]
    .filter((key) => typeof process.env[key] === "string" && !process.env[key].startsWith("()"))
    .map((key) => [key, process.env[key]]));
  let companion = null;
  let setupEpoch = 0;
  let inspectPending = null;

  function inspect() {
    if (!inspectPending) {
      inspectPending = probe().finally(() => { inspectPending = null; });
    }
    return inspectPending;
  }

  async function probe() {
    // Darwin 23 is macOS 14. Never start a newer native binary on an older OS.
    if (platform !== "darwin" || Number.parseInt(osRelease, 10) < 23 || !/^\d+\./.test(osRelease)) {
      return { readiness: "unsupported", detail: "This Mac requires macOS 14 or later for Computer Use." };
    }
    const binary = [
      resourcesPath && path.join(resourcesPath, "helpers", helperName, "Contents", "MacOS", "ComputerUse"),
      path.join(appRoot, "resources", "helpers", helperName, "Contents", "MacOS", "ComputerUse"),
    ].find((candidate) => candidate && fileExists(candidate));
    if (!binary) {
      return { readiness: "unavailable", detail: "The Computer Use helper is missing from this Coworker build. Rebuild or reinstall Coworker." };
    }
    try {
      const child = spawnChild(binary, ["--check"], { env, stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      let failed = false;
      const exited = new Promise((resolve) => {
        child.once("close", (code) => resolve(code));
        child.on("error", () => { failed = true; });
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (stdout.length + chunk.length > 16_384) {
          failed = true;
          child.kill("SIGKILL");
        } else {
          stdout += chunk;
        }
      });
      let code;
      try {
        code = await bounded(() => exited, limits.probe);
      } catch {
        child.kill("SIGKILL");
        try { await bounded(() => exited, limits.close); } catch {
          return { readiness: "unavailable", detail: "The Computer Use permission check stalled and its termination could not be confirmed." };
        }
        return { readiness: "unavailable", detail: "The Computer Use permission check timed out." };
      }
      if (failed || code !== 0) throw new Error("Helper check failed.");
      const state = JSON.parse(stdout);
      if (state?.protocolVersion !== protocolVersion) {
        return { readiness: "unavailable", detail: "The Computer Use helper protocol is incompatible. Rebuild or reinstall Coworker." };
      }
      if (![state.ok, state.supported, state.accessibility, state.screenRecording].every((value) => typeof value === "boolean")) {
        throw new Error("Invalid permission status.");
      }
      if (!state.supported) return { readiness: "unsupported", detail: "Computer Use is not supported on this Mac." };
      const permissions = { accessibility: state.accessibility, screenRecording: state.screenRecording };
      if (!state.accessibility || !state.screenRecording) {
        const missing = [!state.accessibility && "Accessibility", !state.screenRecording && "Screen Recording"].filter(Boolean);
        return { binary, permissions, readiness: "setup-required", detail: `Computer Use needs ${missing.join(" and ")} permission. Open setup to review access.` };
      }
      if (!state.ok) throw new Error("Helper is not ready.");
      return { binary, permissions, readiness: "ready", detail: "Computer Use is ready. Allow this discussion to use supported apps for its task. Sensitive actions still require your authorization." };
    } catch {
      return { readiness: "unavailable", detail: "The Computer Use helper could not report a valid permission status. Rebuild or reinstall Coworker." };
    }
  }

  function clearSetupTimers(record) {
    clearTimeout(record.pollTimer);
    clearTimeout(record.expiryTimer);
    record.pollTimer = null;
    record.expiryTimer = null;
  }

  function stopCompanion(record) {
    if (record.exited) return Promise.resolve();
    if (record.stopping) return record.stopping;
    clearSetupTimers(record);
    record.lifetime.abort(new Error("Computer Use permission setup closed."));
    record.stopping = (async () => {
      if (!record.child) {
        if (companion === record) companion = null;
        return;
      }
      try { record.child.stdin.end(`${JSON.stringify({ type: "close" })}\n`); } catch {}
      try {
        await bounded(() => record.terminated, limits.close);
      } catch {
        try { record.child.kill("SIGKILL"); } catch {}
        try { await bounded(() => record.terminated, limits.close); } catch {
          throw new Error("Computer Use permission setup termination could not be confirmed. The helper may still be running.");
        }
      }
    })();
    void record.stopping.catch(() => {});
    return record.stopping;
  }

  async function dismissSetup(setupId) {
    if (setupId !== undefined && setupId !== companion?.setupId) return;
    setupEpoch++;
    const record = companion;
    if (record) await stopCompanion(record);
  }

  async function writeSetup(record, message) {
    if (!record.ready || record.exited || record.lifetime.signal.aborted) throw new Error("Computer Use permission setup is closed.");
    await bounded(() => new Promise((resolve, reject) => {
      try {
        record.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) reject(new Error("Could not deliver the Computer Use permission setup message."));
          else resolve();
        });
      } catch {
        reject(new Error("Could not deliver the Computer Use permission setup message."));
      }
    }), limits.handshake, record.lifetime.signal);
    record.lifetime.signal.throwIfAborted();
  }

  async function publishStatus(record, state) {
    if (!record?.ready || record.lifetime.signal.aborted) return;
    const { readiness, permissions } = state;
    try {
      await writeSetup(record, { type: "status", readiness, ...(permissions ? { permissions } : {}) });
    } catch {
      await stopCompanion(record).catch(() => {});
    }
  }

  function refreshSetup(record) {
    if (record.lifetime.signal.aborted || !record.ready || !record.visible) return Promise.resolve();
    if (!record.refreshPending) {
      record.refreshPending = (async () => {
        const state = await inspect();
        await publishStatus(record, state);
      })().finally(() => { record.refreshPending = null; });
    }
    return record.refreshPending;
  }

  function scheduleSetupPoll(record) {
    clearTimeout(record.pollTimer);
    record.pollTimer = null;
    if (!record.ready || !record.visible || record.lifetime.signal.aborted) return;
    record.pollTimer = setTimeout(() => {
      void refreshSetup(record).finally(() => scheduleSetupPoll(record));
    }, limits.setupPoll);
    record.pollTimer.unref?.();
  }

  async function startCompanion(record, permission) {
    try {
      const state = await bounded(() => inspect(), limits.probe + limits.close, record.lifetime.signal);
      record.lifetime.signal.throwIfAborted();
      if (record.epoch !== setupEpoch || companion !== record) throw new Error("Computer Use permission setup cancelled.");
      if (!state.binary) throw new Error(state.detail);
      const child = spawnChild(state.binary, ["permissions-coworker", permission], { env, stdio: ["pipe", "pipe", "ignore"] });
      record.child = child;
      record.terminated = new Promise((resolve) => {
        child.once("close", () => {
          record.exited = true;
          clearSetupTimers(record);
          record.lifetime.abort(new Error("Computer Use permission setup exited."));
          if (companion === record) companion = null;
          resolve();
        });
      });
      let acceptReady;
      const ready = new Promise((resolve) => { acceptReady = resolve; });
      const fail = () => { void stopCompanion(record).catch(() => {}); };
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stdout.on("error", fail);
      child.stdout.on("end", fail);
      let pending = "";
      let total = 0;
      let lines = 0;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (record.lifetime.signal.aborted) return;
        total += Buffer.byteLength(chunk);
        if (total > 65_536) { fail(); return; }
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (Buffer.byteLength(line) > 4_096 || ++lines > 2_048) { fail(); return; }
          let event;
          try { event = JSON.parse(line); } catch { fail(); return; }
          if (!event || typeof event !== "object" || Array.isArray(event)) { fail(); return; }
          const keys = event.event === "requested" ? ["event", "permission"] : event.event === "visibility" ? ["event", "visible"] : ["event"];
          if (Object.keys(event).some((key) => !keys.includes(key))) { fail(); return; }
          if (!record.ready) {
            if (event.event !== "ready") { fail(); return; }
            record.ready = true;
            acceptReady();
          } else if (event.event === "requested") {
            if (!["accessibility", "screenRecording"].includes(event.permission)) { fail(); return; }
          } else if (event.event === "refresh") {
            void refreshSetup(record);
          } else if (event.event === "visibility" && typeof event.visible === "boolean") {
            record.visible = event.visible;
            scheduleSetupPoll(record);
          } else if (event.event === "return") {
            fail();
            try { void Promise.resolve(onSetupReturn()).catch(() => {}); } catch {}
            return;
          } else {
            fail(); return;
          }
        }
        if (Buffer.byteLength(pending) > 4_096) fail();
      });
      record.expiryTimer = setTimeout(fail, limits.setupLifetime);
      record.expiryTimer.unref?.();
      await bounded(() => ready, limits.handshake, record.lifetime.signal);
      record.lifetime.signal.throwIfAborted();
      void publishStatus(record, state);
      scheduleSetupPoll(record);
      return { setupId: record.setupId };
    } catch (error) {
      try { await stopCompanion(record); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Computer Use permission setup failed and termination could not be confirmed.");
      }
      throw error;
    }
  }

  return {
    id: "this-mac",
    label: "This Mac",
    placement: "desktop",
    protocol: protocolVersion,
    async readiness() {
      const record = companion;
      const state = await inspect();
      await publishStatus(record, state);
      const { readiness, detail, permissions } = state;
      return { readiness, detail, ...(permissions ? { permissions } : {}) };
    },
    async setup(permission) {
      if (!["accessibility", "screenRecording"].includes(permission)) throw new Error("Choose Accessibility or Screen Recording settings.");
      if (companion?.lifetime.signal.aborted) throw new Error("Computer Use permission setup termination has not been confirmed.");
      if (companion?.starting) {
        if (companion.permission !== permission) throw new Error("Finish the current macOS permission request first.");
        return companion.starting;
      }
      const setupId = randomUUID();
      if (companion) {
        const record = companion;
        record.setupId = setupId;
        try {
          await writeSetup(record, { type: "request", permission });
        } catch (error) {
          try { await stopCompanion(record); } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "Computer Use permission request failed and termination could not be confirmed.");
          }
          throw error;
        }
        return { setupId };
      }
      const record = { setupId, permission, epoch: setupEpoch, lifetime: new AbortController(), visible: true, ready: false, exited: false };
      companion = record;
      record.starting = startCompanion(record, permission).finally(() => { record.starting = null; });
      return record.starting;
    },
    dismissSetup,
    async connect({ onUi = () => {}, onClose = () => {} } = {}) {
      await dismissSetup();
      const state = await inspect();
      if (state.readiness !== "ready") throw new Error(state.detail);
      const { Client, StdioClientTransport, uiNotificationSchema } = await mcp();
      const client = new Client({ name: "open-coworker-computer", version: "1.0.0" }, { capabilities: {}, enforceStrictCapabilities: true });
      // Only this trusted host gets embedded presentation; Continue stays human-only.
      const transport = new StdioClientTransport({ command: state.binary, args: ["mcp-coworker-hosted"], env, stderr: "ignore" });
      let closed = false;
      let terminationConfirmed = false;
      let busy = false;
      const lifetime = new AbortController();
      client.setNotificationHandler(uiNotificationSchema, ({ params }) => {
        if (!closed) onUi(params);
      });
      const terminated = new Promise((resolve) => {
        transport.onclose = () => {
          closed = true; terminationConfirmed = true;
          lifetime.abort(new Error("Computer Use disconnected."));
          resolve(); onClose();
        };
      });
      // SDK close() can return after SIGKILL but before the child exits. Its
      // onclose callback, installed before Client.connect composes it, is the receipt.
      const sdkClose = transport.close.bind(transport);
      let closing;
      transport.close = () => {
        if (terminationConfirmed) return Promise.resolve();
        if (!closing) {
          closed = true;
          lifetime.abort(new Error("Computer Use native session is closing."));
          closing = bounded(async () => {
            await sdkClose();
            await terminated;
          }, limits.close).catch(() => {
            throw new Error("Computer Use native session release could not be confirmed. The helper may still be running.");
          });
          // The SDK also initiates close without awaiting it on handshake failure.
          void closing.catch(() => {});
        }
        return closing;
      };
      /** Resolves only after helper exit guarantees release of its native session. */
      const close = () => transport.close();
      try {
        await bounded(async (options) => {
          await client.connect(transport, options);
          const server = client.getServerVersion();
          if (server?.name !== "openwork-computer-use" || server.version !== "1.0.0" || !client.getServerCapabilities()?.tools) {
            throw new Error("The Computer Use MCP handshake is incompatible.");
          }
          const { tools, nextCursor } = await client.listTools({}, options);
          if (nextCursor !== undefined || tools.length !== toolNames.size || new Set(tools.map((tool) => tool.name)).size !== toolNames.size
            || tools.some((tool) => !toolNames.has(tool.name) || tool.inputSchema?.type !== "object" || tool.inputSchema.additionalProperties !== false)) {
            throw new Error("The Computer Use tool contract is incompatible.");
          }
        }, limits.handshake, lifetime.signal);
        if (closed) throw new Error("Computer Use disconnected during setup.");
      } catch (error) {
        try { await close(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Computer Use connection failed and native session release could not be confirmed.");
        }
        throw error;
      }
      return {
        async notifyUi(params) {
          if (closed) throw new Error("Computer Use connection is closed.");
          if (!params || typeof params !== "object" || Array.isArray(params)
            || Object.keys(params).some((key) => !["id", "action", "windowId", "visible"].includes(key))
            || typeof params.id !== "string" || !params.id || params.id.length > 128
            || !["approve", "deny", "takeover", "resume", "stop", "watch"].includes(params.action)
            || (params.action === "approve" ? !Number.isSafeInteger(params.windowId) || params.windowId < 1 || params.windowId > 0xffffffff : params.windowId !== undefined)
            || (params.action === "watch" ? typeof params.visible !== "boolean" : params.visible !== undefined)) {
            throw new Error("A scoped native presentation action is required.");
          }
          // Notifications must not wait behind a pending consent or agent tool call.
          await bounded(() => client.notification({ method: "openwork/ui", params }), limits.close, lifetime.signal);
        },
        async callTool(name, args, { signal, timeoutMs = limits.call } = {}) {
          if (closed) throw new Error("Computer Use connection is closed.");
          if (!toolNames.has(name)) throw new Error("This Computer Use tool is not allowed.");
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Computer Use arguments must be an object.");
          if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Computer Use timeout must be positive and finite.");
          signal?.throwIfAborted();
          if (busy) throw new Error("Computer Use calls must be sequential.");
          busy = true;
          try {
            // Only signal and a capped deadline are caller-configurable, never transport settings.
            // Raw MCP images stay in this result for the main-process/plugin consumer.
            return await bounded((options) => client.callTool({ name, arguments: args }, undefined, options),
              Math.min(timeoutMs, limits.call), signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal);
          } catch (error) {
            try { await close(); } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], "Computer Use call failed and native session release could not be confirmed.");
            }
            throw error;
          } finally {
            busy = false;
          }
        },
        close,
      };
    },
  };
}
