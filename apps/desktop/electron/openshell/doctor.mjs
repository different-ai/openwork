// Health-check engine for the OpenShell stack. Produces a structured
// OpenShellDoctorResult that the renderer displays as a settings checklist.
// This is the single source of truth — UI code never inspects individual
// processes, it calls openshellDoctor() and trusts the aggregate.

import { spawn } from "node:child_process";
import os from "node:os";

import { DISTRO_NAME, distroExists, wslRun } from "./wsl.mjs";

/**
 * @typedef {("ready"|"degraded"|"missing"|"unsupported")} DoctorStatus
 * @typedef {("ok"|"warn"|"missing"|"unknown")} ComponentState
 *
 * @typedef {Object} OpenShellComponent
 * @property {string} id
 * @property {string} label
 * @property {ComponentState} state
 * @property {string|null} version
 * @property {string|null} detail
 * @property {string|null} [actionable]
 *
 * @typedef {Object} OpenShellDoctorResult
 * @property {DoctorStatus} status
 * @property {OpenShellComponent[]} components
 * @property {string[]} actionable
 * @property {string[]} fatal
 */

const MIN_WIN11_BUILD = 22_000;
const POWERSHELL_TIMEOUT_MS = 15_000;

function resolvePowerShellExe() {
  return process.env.OPENWORK_POWERSHELL_EXE || "powershell.exe";
}

async function runPowerShell(command, { timeout = POWERSHELL_TIMEOUT_MS } = {}) {
  const exe = resolvePowerShellExe();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        exe,
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      reject(err);
      return;
    }
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (c) => stdout.push(c));
    child.stderr.on("data", (c) => stderr.push(c));
    const timer =
      timeout > 0
        ? setTimeout(() => child.kill("SIGKILL"), timeout)
        : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
  });
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// 1. Windows version. No shellout needed: os.release() returns the NT
// kernel version like "10.0.22631"; Windows 11 starts at build 22000.
/** @returns {Promise<OpenShellComponent>} */
async function checkWindows() {
  if (os.platform() !== "win32") {
    return {
      id: "windows",
      label: "Windows 11",
      state: "missing",
      version: os.platform(),
      detail: "OpenShell requires Windows 11. Mac/Linux users should use the Docker sandbox.",
      actionable: null,
    };
  }
  const release = os.release();
  const match = release.match(/^\d+\.\d+\.(\d+)/);
  const build = match ? Number(match[1]) : 0;
  if (build >= MIN_WIN11_BUILD) {
    return {
      id: "windows",
      label: "Windows 11",
      state: "ok",
      version: release,
      detail: null,
      actionable: null,
    };
  }
  return {
    id: "windows",
    label: "Windows 11",
    state: "missing",
    version: release,
    detail: `Detected Windows build ${build || "unknown"}; need ≥ ${MIN_WIN11_BUILD}.`,
    actionable: "Upgrade to Windows 11.",
  };
}

// 2. Hyper-V. Requires PowerShell; the optional-feature query is the
// canonical way to detect it on Windows 11 desktop SKUs.
/** @returns {Promise<OpenShellComponent>} */
async function checkHyperV() {
  try {
    const r = await runPowerShell(
      "Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V " +
        "| Select-Object -ExpandProperty State",
    );
    const state = r.stdout.trim();
    if (state === "Enabled") {
      return {
        id: "hyperv",
        label: "Hyper-V",
        state: "ok",
        version: null,
        detail: null,
        actionable: null,
      };
    }
    return {
      id: "hyperv",
      label: "Hyper-V",
      state: "missing",
      version: null,
      detail: state ? `Hyper-V state: ${state}` : "Hyper-V feature not present.",
      actionable:
        "Enable Hyper-V from Windows Features, or run " +
        "`dism /online /enable-feature /featurename:Microsoft-Hyper-V /all /norestart` as admin.",
    };
  } catch (err) {
    return {
      id: "hyperv",
      label: "Hyper-V",
      state: "unknown",
      version: null,
      detail: `Could not query Hyper-V: ${err.message || err}`,
      actionable: null,
    };
  }
}

// 3. WSL2 installed and v2 default.
/** @returns {Promise<OpenShellComponent>} */
async function checkWsl() {
  try {
    const r = await wslRun(["--status"], { timeout: 10_000 });
    if (r.exitCode !== 0) {
      return {
        id: "wsl",
        label: "WSL2",
        state: "missing",
        version: null,
        detail: r.stderr || "wsl --status exited non-zero.",
        actionable:
          "Install WSL2: run the OpenShell installer (Settings → Sandbox → Install).",
      };
    }
    const defaultVersion = r.stdout.match(/Default Version:\s*(\d)/i)?.[1];
    if (defaultVersion !== "2") {
      return {
        id: "wsl",
        label: "WSL2",
        state: "warn",
        version: defaultVersion ?? null,
        detail: `WSL default version is ${defaultVersion ?? "unknown"}; need 2.`,
        actionable: "Run `wsl --set-default-version 2`.",
      };
    }
    return {
      id: "wsl",
      label: "WSL2",
      state: "ok",
      version: defaultVersion,
      detail: null,
      actionable: null,
    };
  } catch (err) {
    return {
      id: "wsl",
      label: "WSL2",
      state: "missing",
      version: null,
      detail: `wsl.exe not callable: ${err.message || err}`,
      actionable: "Install WSL2 via the OpenShell installer.",
    };
  }
}

// 4. Our distro is registered.
/** @returns {Promise<OpenShellComponent>} */
async function checkDistro() {
  try {
    const present = await distroExists();
    if (present) {
      return {
        id: "distro",
        label: `Distro (${DISTRO_NAME})`,
        state: "ok",
        version: null,
        detail: null,
        actionable: null,
      };
    }
    return {
      id: "distro",
      label: `Distro (${DISTRO_NAME})`,
      state: "missing",
      version: null,
      detail: `WSL distro "${DISTRO_NAME}" is not registered.`,
      actionable: "Run the OpenShell installer (Settings → Sandbox → Install).",
    };
  } catch (err) {
    return {
      id: "distro",
      label: `Distro (${DISTRO_NAME})`,
      state: "unknown",
      version: null,
      detail: `Could not list distros: ${err.message || err}`,
      actionable: null,
    };
  }
}

// 5. Docker Engine running inside our distro.
/** @returns {Promise<OpenShellComponent>} */
async function checkDockerInDistro() {
  try {
    const r = await wslRun(
      ["-d", DISTRO_NAME, "--", "docker", "info", "--format", "{{json .}}"],
      { timeout: 10_000 },
    );
    if (r.exitCode !== 0) {
      return {
        id: "docker",
        label: "Docker (in distro)",
        state: "missing",
        version: null,
        detail: r.stderr || "docker info failed inside distro.",
        actionable:
          "Run `service docker start` inside the distro, or re-run the installer.",
      };
    }
    const info = parseJsonSafely(r.stdout);
    const serverVersion = info?.ServerVersion ?? null;
    return {
      id: "docker",
      label: "Docker (in distro)",
      state: "ok",
      version: serverVersion,
      detail: null,
      actionable: null,
    };
  } catch (err) {
    return {
      id: "docker",
      label: "Docker (in distro)",
      state: "unknown",
      version: null,
      detail: `Could not query Docker: ${err.message || err}`,
      actionable: null,
    };
  }
}

// 6. OpenShell CLI installed inside the distro.
/** @returns {Promise<OpenShellComponent>} */
async function checkOpenShellCli() {
  try {
    const r = await wslRun(
      ["-d", DISTRO_NAME, "--", "openshell", "version", "--json"],
      { timeout: 10_000 },
    );
    if (r.exitCode !== 0) {
      return {
        id: "openshell-cli",
        label: "OpenShell CLI",
        state: "missing",
        version: null,
        detail: r.stderr || "openshell binary not found.",
        actionable: "Re-run the OpenShell installer.",
      };
    }
    const parsed = parseJsonSafely(r.stdout);
    const version = parsed?.version ?? r.stdout.trim() ?? null;
    return {
      id: "openshell-cli",
      label: "OpenShell CLI",
      state: "ok",
      version,
      detail: null,
      actionable: null,
    };
  } catch (err) {
    return {
      id: "openshell-cli",
      label: "OpenShell CLI",
      state: "unknown",
      version: null,
      detail: `Could not query openshell: ${err.message || err}`,
      actionable: null,
    };
  }
}

// 7. OpenShell gateway pod is Ready. The gateway is what spawns per-session
// sandboxes; without it, sandbox creation is impossible.
/** @returns {Promise<OpenShellComponent>} */
async function checkOpenShellGateway() {
  try {
    const r = await wslRun(
      ["-d", DISTRO_NAME, "--", "openshell", "status", "--json"],
      { timeout: 10_000 },
    );
    if (r.exitCode !== 0) {
      return {
        id: "openshell-gateway",
        label: "OpenShell gateway",
        state: "missing",
        version: null,
        detail: r.stderr || "openshell status failed.",
        actionable: "Run `openshell gateway start --detach` inside the distro.",
      };
    }
    const parsed = parseJsonSafely(r.stdout);
    const gatewayState = parsed?.gateway?.state ?? parsed?.state ?? null;
    if (gatewayState === "Ready" || gatewayState === "ok") {
      return {
        id: "openshell-gateway",
        label: "OpenShell gateway",
        state: "ok",
        version: parsed?.version ?? null,
        detail: null,
        actionable: null,
      };
    }
    return {
      id: "openshell-gateway",
      label: "OpenShell gateway",
      state: "warn",
      version: parsed?.version ?? null,
      detail: `Gateway state: ${gatewayState ?? "unknown"}.`,
      actionable: "Restart the gateway from Settings, or re-run `openshell gateway start`.",
    };
  } catch (err) {
    return {
      id: "openshell-gateway",
      label: "OpenShell gateway",
      state: "unknown",
      version: null,
      detail: `Could not query gateway: ${err.message || err}`,
      actionable: null,
    };
  }
}

function aggregateStatus(components) {
  // unsupported beats everything: we can't even attempt remediation if the
  // platform itself rules OpenShell out.
  const windows = components.find((c) => c.id === "windows");
  const hyperv = components.find((c) => c.id === "hyperv");
  if (windows?.state === "missing" || hyperv?.state === "missing") {
    return "unsupported";
  }
  if (components.some((c) => c.state === "missing")) return "missing";
  if (components.some((c) => c.state === "warn" || c.state === "unknown")) {
    return "degraded";
  }
  return "ready";
}

function deriveActionable(components) {
  return components
    .filter((c) => c.actionable)
    .map((c) => `${c.label}: ${c.actionable}`);
}

function deriveFatal(components) {
  return components
    .filter((c) => c.state === "missing" && c.detail)
    .map((c) => `${c.label}: ${c.detail}`);
}

/** @returns {Promise<OpenShellDoctorResult>} */
export async function openshellDoctor() {
  const components = [
    await checkWindows(),
    await checkHyperV(),
    await checkWsl(),
    await checkDistro(),
    await checkDockerInDistro(),
    await checkOpenShellCli(),
    await checkOpenShellGateway(),
  ];
  return {
    status: aggregateStatus(components),
    components,
    actionable: deriveActionable(components),
    fatal: deriveFatal(components),
  };
}

// Exported for testing — lets the suite verify aggregation independently of
// the live checks.
export const __testing = {
  aggregateStatus,
  deriveActionable,
  deriveFatal,
  checkWindows,
  checkHyperV,
  checkWsl,
  checkDistro,
  checkDockerInDistro,
  checkOpenShellCli,
  checkOpenShellGateway,
};
