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

// 2. Virtualization platform — the actual WSL2 prerequisite. The full
// Microsoft-Hyper-V role is Pro/Enterprise only; VirtualMachinePlatform
// is what WSL2 needs and is available on Home too. Keeping the internal
// id "hyperv" so the UI's component-state contract doesn't shift.
/** @returns {Promise<OpenShellComponent>} */
async function checkHyperV() {
  try {
    const r = await runPowerShell(
      "Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform " +
        "| Select-Object -ExpandProperty State",
    );
    const state = r.stdout.trim();
    if (state === "Enabled") {
      return {
        id: "hyperv",
        label: "Virtualization (WSL2)",
        state: "ok",
        version: null,
        detail: null,
        actionable: null,
      };
    }
    return {
      id: "hyperv",
      label: "Virtualization (WSL2)",
      state: "missing",
      version: null,
      detail: state
        ? `VirtualMachinePlatform state: ${state}`
        : "VirtualMachinePlatform feature not present.",
      actionable:
        "Enable it from Windows Features (\"Virtual Machine Platform\"), or run " +
        "`dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart` as admin.",
    };
  } catch (err) {
    return {
      id: "hyperv",
      label: "Virtualization (WSL2)",
      state: "unknown",
      version: null,
      detail: `Could not query VirtualMachinePlatform: ${err.message || err}`,
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

// 6. OpenShell CLI installed inside the distro. Tries the JSON form
// first (newer CLIs), then plain `--version`, so the doctor still
// captures *some* version string when upstream stops emitting JSON.
/** @returns {Promise<OpenShellComponent>} */
async function checkOpenShellCli() {
  try {
    const r = await wslRun(
      ["-d", DISTRO_NAME, "--", "openshell", "version", "--json"],
      { timeout: 10_000 },
    );
    if (r.exitCode !== 0) {
      // Some releases moved version under `--version` instead of a
      // `version` subcommand. Try once more before declaring the binary
      // missing — that lets the doctor distinguish "no binary" from
      // "binary present but CLI surface changed".
      const fallback = await wslRun(
        ["-d", DISTRO_NAME, "--", "openshell", "--version"],
        { timeout: 10_000 },
      ).catch(() => null);
      if (fallback && fallback.exitCode === 0) {
        const v = fallback.stdout.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? fallback.stdout.trim();
        return {
          id: "openshell-cli",
          label: "OpenShell CLI",
          state: "ok",
          version: v || null,
          detail: null,
          actionable: null,
        };
      }
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

// Disk usage inside the distro. Spec §5 row "User runs out of disk":
// surface a warn at <10% free, missing at <5% (sandbox creation will
// fail). We probe via `df -B1 --output=avail,size /` so the parse is a
// pair of plain integers (no SI suffixes to deal with).
/** @returns {Promise<OpenShellComponent>} */
async function checkDiskUsage() {
  try {
    const r = await wslRun(
      ["-d", DISTRO_NAME, "--", "df", "-B1", "--output=avail,size", "/"],
      { timeout: 10_000 },
    );
    if (r.exitCode !== 0) {
      return {
        id: "disk",
        label: "Disk (in distro)",
        state: "unknown",
        version: null,
        detail: r.stderr || "df failed inside distro.",
        actionable: null,
      };
    }
    // df --output=avail,size emits a header line then one data line:
    //   Avail      1B-blocks
    //   <bytes>    <bytes>
    const dataLine = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l, idx, all) => idx > 0 && l.length > 0 && all[0].toLowerCase().includes("avail"));
    if (!dataLine) {
      return {
        id: "disk",
        label: "Disk (in distro)",
        state: "unknown",
        version: null,
        detail: "Could not parse df output.",
        actionable: null,
      };
    }
    const [availStr, totalStr] = dataLine.split(/\s+/);
    const avail = Number(availStr);
    const total = Number(totalStr);
    if (!Number.isFinite(avail) || !Number.isFinite(total) || total === 0) {
      return {
        id: "disk",
        label: "Disk (in distro)",
        state: "unknown",
        version: null,
        detail: "Could not parse df output.",
        actionable: null,
      };
    }
    const freeRatio = avail / total;
    const summary = `${formatBytes(avail)} free of ${formatBytes(total)}`;
    if (freeRatio < 0.05) {
      return {
        id: "disk",
        label: "Disk (in distro)",
        state: "missing",
        version: summary,
        detail: `Only ${(freeRatio * 100).toFixed(1)}% free; sandbox creation may fail.`,
        actionable:
          "Reclaim space: `wsl -d openwork-openshell -- docker image prune -af` " +
          "and `wsl --shrink openwork-openshell` from PowerShell.",
      };
    }
    if (freeRatio < 0.10) {
      return {
        id: "disk",
        label: "Disk (in distro)",
        state: "warn",
        version: summary,
        detail: `${(freeRatio * 100).toFixed(1)}% free.`,
        actionable:
          "Consider `wsl -d openwork-openshell -- docker image prune -af` " +
          "to reclaim space before the next session.",
      };
    }
    return {
      id: "disk",
      label: "Disk (in distro)",
      state: "ok",
      version: summary,
      detail: null,
      actionable: null,
    };
  } catch (err) {
    return {
      id: "disk",
      label: "Disk (in distro)",
      state: "unknown",
      version: null,
      detail: `Could not probe disk: ${err.message || err}`,
      actionable: null,
    };
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// Orphan wsl-side processes. Spec §5 row "wsl.exe orphan accumulates
// over a day". When a sandbox lifecycle breaks down (the WSL #12159 bug
// or an EDR mid-kill), agent processes can survive their parent and
// pile up. > 5 surviving processes is the spec's trigger for a
// "Restart OpenShell" toast.
/** @returns {Promise<OpenShellComponent>} */
async function checkOrphans() {
  try {
    // pgrep -fc matches against the full command line and prints the
    // count. We look for shell processes owned by PID 1 — the canonical
    // shape an orphan takes after its parent exits in WSL.
    const r = await wslRun(
      [
        "-d",
        DISTRO_NAME,
        "--",
        "bash",
        "-c",
        "ps -eo ppid,pid,comm --no-headers | awk '$1 == 1 && $3 ~ /^(sh|bash|openshell|node)$/' | wc -l",
      ],
      { timeout: 10_000 },
    );
    if (r.exitCode !== 0) {
      return {
        id: "orphans",
        label: "WSL orphan processes",
        state: "unknown",
        version: null,
        detail: r.stderr || "Could not enumerate processes.",
        actionable: null,
      };
    }
    const count = Number(r.stdout.trim());
    if (!Number.isFinite(count)) {
      return {
        id: "orphans",
        label: "WSL orphan processes",
        state: "unknown",
        version: null,
        detail: "Could not parse orphan count.",
        actionable: null,
      };
    }
    if (count > 5) {
      return {
        id: "orphans",
        label: "WSL orphan processes",
        state: "warn",
        version: String(count),
        detail: `${count} orphaned processes inside the distro.`,
        actionable:
          "Restart OpenShell: `wsl --terminate openwork-openshell` from PowerShell " +
          "(then relaunch the app). Workspaces are not affected.",
      };
    }
    return {
      id: "orphans",
      label: "WSL orphan processes",
      state: "ok",
      version: String(count),
      detail: null,
      actionable: null,
    };
  } catch (err) {
    return {
      id: "orphans",
      label: "WSL orphan processes",
      state: "unknown",
      version: null,
      detail: `Could not probe orphans: ${err.message || err}`,
      actionable: null,
    };
  }
}

// 7. OpenShell gateway pod is Ready. The gateway is what spawns per-session
// sandboxes; without it, sandbox creation is impossible. The JSON shape
// from `openshell status` has shifted across versions — when the parse
// fails we surface the raw text so IT/the user can see what the CLI
// actually printed instead of an opaque "unknown" badge.
/** @returns {Promise<OpenShellComponent>} */
async function checkOpenShellGateway() {
  try {
    const r = await wslRun(
      ["-d", DISTRO_NAME, "--", "openshell", "status", "--json"],
      { timeout: 10_000 },
    );
    if (r.exitCode !== 0) {
      // Strings like "No gateway configured" arrive here with a non-zero
      // exit on some CLI versions; the `actionable` line steers the user
      // at the Restart button which now drives the docker-direct fallback.
      const stderr = (r.stderr || "").trim();
      const stdout = (r.stdout || "").trim();
      const detail = stderr || stdout || "openshell status failed.";
      return {
        id: "openshell-gateway",
        label: "OpenShell gateway",
        state: "missing",
        version: null,
        detail,
        actionable: "Click Settings → Sandbox → Restart gateway, or reset the distro if that fails.",
      };
    }
    const parsed = parseJsonSafely(r.stdout);
    if (parsed === null) {
      // CLI succeeded but didn't return JSON. Don't pretend we know its
      // state — surface the raw text so the next bug report has the
      // information we'd otherwise have to ask for.
      const preview = (r.stdout || "").trim().slice(0, 400);
      return {
        id: "openshell-gateway",
        label: "OpenShell gateway",
        state: "warn",
        version: null,
        detail: `openshell status returned non-JSON output: "${preview}"`,
        actionable: "Click Settings → Sandbox → Restart gateway. If that fails, file a bug with this detail.",
      };
    }
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
      actionable: "Click Settings → Sandbox → Restart gateway.",
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
    await checkDiskUsage(),
    await checkOrphans(),
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
  checkDiskUsage,
  checkOrphans,
};
