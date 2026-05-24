// Thin client for the OpenShell CLI inside our WSL distro. All real
// sandbox semantics — K3s pod, OPA policy enforcement, port-forward,
// stdin/stdout tunneling — live inside the openshell binary; this file
// just shells out to `wsl.exe -d openwork-openshell -- openshell ...`
// and waits for the well-known readiness line.

import { DISTRO_NAME, wslRun, wslSpawn } from "./wsl.mjs";

const READY_PREFIX = "sandbox ready:";
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_CLI_TIMEOUT_MS = 30_000;

function parseJsonOrThrow(text, what) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${what}: invalid JSON response: ${err.message}`);
  }
}

function makeLineSplitter(handler) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) handler(line);
  };
}

/**
 * Spawn `openshell sandbox create` and resolve when the readiness line
 * appears on stdout. The returned process keeps running for the lifetime
 * of the sandbox; cleanup() kills it and asks the CLI to tear down.
 *
 * @param {Object} opts
 * @param {string} opts.name
 * @param {string} opts.policyPath
 * @param {string} [opts.workspaceTarPath]
 * @param {number} opts.hostPort
 * @param {number} opts.internalPort
 * @param {string[]} opts.command           - e.g. ["sh", "/entrypoint.sh"]
 * @param {(evt: {stream: "stdout"|"stderr", line: string}) => void} [opts.onLog]
 * @param {number} [opts.readyTimeoutMs]
 * @returns {Promise<{name: string, process: import("node:child_process").ChildProcess, cleanup: () => Promise<void>}>}
 */
export async function createSandbox(opts) {
  const {
    name,
    policyPath,
    workspaceTarPath,
    hostPort,
    internalPort,
    command,
    onLog,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  } = opts;

  if (!name) throw new Error("createSandbox: name is required");
  if (!policyPath) throw new Error("createSandbox: policyPath is required");
  if (!Array.isArray(command) || command.length === 0) {
    throw new Error("createSandbox: command must be a non-empty array");
  }
  if (!Number.isFinite(hostPort) || !Number.isFinite(internalPort)) {
    throw new Error("createSandbox: hostPort and internalPort must be numbers");
  }

  const args = ["-d", DISTRO_NAME, "--", "openshell", "sandbox", "create",
    "--name", name,
    "--policy", policyPath,
    "--port-forward", `127.0.0.1:${hostPort}:${internalPort}`];
  if (workspaceTarPath) {
    args.push("--workspace-tarball", workspaceTarPath);
  }
  args.push("--", ...command);

  const child = wslSpawn(args);

  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const onStdoutLine = (line) => {
      if (onLog) onLog({ stream: "stdout", line });
      if (line.startsWith(READY_PREFIX)) {
        settle(() =>
          resolve({
            name,
            process: child,
            cleanup: async () => {
              try {
                child.kill("SIGTERM");
              } catch {
                // Already exited.
              }
              try {
                await deleteSandbox(name);
              } catch {
                // Best-effort: caller can't recover from a failed delete here.
              }
            },
          }),
        );
      }
    };

    const onStderrLine = (line) => {
      if (onLog) onLog({ stream: "stderr", line });
    };

    child.stdout.on("data", makeLineSplitter(onStdoutLine));
    child.stderr.on("data", makeLineSplitter(onStderrLine));

    const timer = setTimeout(() => {
      settle(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        reject(
          new Error(
            `OpenShell sandbox "${name}" did not report ready within ${readyTimeoutMs}ms.`,
          ),
        );
      });
    }, readyTimeoutMs);

    child.on("error", (err) => {
      settle(() => reject(err));
    });

    child.on("exit", (code) => {
      settle(() =>
        reject(
          new Error(
            `OpenShell sandbox "${name}" exited with code ${code} before reporting ready.`,
          ),
        ),
      );
    });
  });
}

export async function deleteSandbox(name) {
  if (!name) throw new Error("deleteSandbox: name is required");
  return wslRun(
    ["-d", DISTRO_NAME, "--", "openshell", "sandbox", "delete", name, "--force"],
    { timeout: DEFAULT_CLI_TIMEOUT_MS },
  );
}

export async function getSandboxStatus(name) {
  if (!name) throw new Error("getSandboxStatus: name is required");
  const r = await wslRun(
    ["-d", DISTRO_NAME, "--", "openshell", "sandbox", "status", name, "--json"],
    { timeout: 10_000 },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `getSandboxStatus("${name}") failed: ${r.stderr || r.stdout || "unknown error"}`,
    );
  }
  return parseJsonOrThrow(r.stdout, `getSandboxStatus("${name}")`);
}

export async function listSandboxes() {
  const r = await wslRun(
    ["-d", DISTRO_NAME, "--", "bash", "-c", "timeout 15 openshell sandbox list --json"],
    { timeout: 20_000 },
  );
  if (r.exitCode === 124) {
    throw new Error(
      "OpenShell gateway is not responding (sandbox list timed out). " +
        "Restart the gateway from Settings \u2192 Sandbox \u2192 OpenShell health \u2192 Restart Gateway.",
    );
  }
  if (r.exitCode !== 0) {
    throw new Error(`listSandboxes failed: ${r.stderr || r.stdout || "unknown error"}`);
  }
  return parseJsonOrThrow(r.stdout, "listSandboxes");
}

export async function getGatewayStatus() {
  const r = await wslRun(
    ["-d", DISTRO_NAME, "--", "openshell", "gateway", "status", "--json"],
    { timeout: 10_000 },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `getGatewayStatus failed: ${r.stderr || r.stdout || "unknown error"}`,
    );
  }
  return parseJsonOrThrow(r.stdout, "getGatewayStatus");
}
