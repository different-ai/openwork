import { spawn } from "node:child_process";
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
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
  ]);
  return { Client, StdioClientTransport };
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
  timeouts = {},
} = {}) {
  const limits = { probe: 5_000, handshake: 5_000, call: 120_000, close: 7_000, ...timeouts };
  // Do not pass provider credentials, Node preload flags or dynamic-loader overrides.
  const env = Object.fromEntries(["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "TMPDIR"]
    .filter((key) => typeof process.env[key] === "string" && !process.env[key].startsWith("()"))
    .map((key) => [key, process.env[key]]));
  let setupPending = null;
  let setupPermission = null;

  async function inspect() {
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
      return { binary, permissions, readiness: "ready", detail: "Computer Use is ready. Each app session still requires your approval." };
    } catch {
      return { readiness: "unavailable", detail: "The Computer Use helper could not report a valid permission status. Rebuild or reinstall Coworker." };
    }
  }

  return {
    id: "this-mac",
    label: "This Mac",
    placement: "desktop",
    protocol: protocolVersion,
    async readiness() {
      const { readiness, detail, permissions } = await inspect();
      return { readiness, detail, ...(permissions ? { permissions } : {}) };
    },
    async setup(permission) {
      if (!["accessibility", "screenRecording"].includes(permission)) throw new Error("Choose Accessibility or Screen Recording settings.");
      if (setupPending) {
        if (setupPermission !== permission) throw new Error("Finish the current macOS permission request first.");
        return setupPending;
      }
      setupPermission = permission;
      setupPending = (async () => {
        const state = await inspect();
        if (!state.binary) throw new Error(state.detail);
        // Match --check and MCP's responsible application. Do not use LaunchServices.
        const child = spawnChild(state.binary, ["permissions", permission], { env, stdio: "ignore" });
        let failed = false;
        child.on("error", () => { failed = true; });
        const exited = new Promise((resolve) => {
          child.once("close", resolve);
        });
        try {
          const code = await bounded(() => exited, limits.call);
          if (failed || code !== 0) throw new Error("Could not open macOS permission settings. Open System Settings > Privacy & Security manually.");
        } catch (error) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await bounded(() => exited, limits.close);
          }
          throw error;
        }
      })().finally(() => { setupPending = null; setupPermission = null; });
      return setupPending;
    },
    async connect() {
      const state = await inspect();
      if (state.readiness !== "ready") throw new Error(state.detail);
      const { Client, StdioClientTransport } = await mcp();
      const client = new Client({ name: "open-coworker-computer", version: "1.0.0" }, { capabilities: {}, enforceStrictCapabilities: true });
      // Visual native controls, with standalone consent and human-only Continue.
      const transport = new StdioClientTransport({ command: state.binary, args: ["mcp-coworker"], env, stderr: "ignore" });
      let closed = false;
      let terminationConfirmed = false;
      let busy = false;
      const lifetime = new AbortController();
      const terminated = new Promise((resolve) => {
        transport.onclose = () => { closed = true; terminationConfirmed = true; resolve(); };
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
