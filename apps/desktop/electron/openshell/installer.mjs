// Bootstrap orchestrator for the OpenShell stack on Windows. Six
// idempotent phases (preflight → wsl → distro → docker → openshell →
// verify) drive WSL2 install, distro import from a bundled Ubuntu rootfs,
// Docker Engine install inside the distro, and OpenShell CLI + gateway
// bring-up. State is persisted across the reboot that `wsl --install`
// forces on first install, so the second launch resumes cleanly.
//
// Each phase is dependency-injected through PHASES + the runner accepts
// a `phases` override so unit tests can mock the heavy commands and run
// the orchestrator on Linux.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openshellDoctor } from "./doctor.mjs";
import { DISTRO_NAME, wslRun } from "./wsl.mjs";

const DEFAULT_STATE_FILE = path.join(os.homedir(), ".openwork", "openshell-install.json");
const MIN_WIN11_BUILD = 22_000;
const MIN_RAM_GB = 14; // 16 GB nominal with system reserve slack
const MIN_FREE_DISK_GB = 30;
const DOCKER_INSTALL_TIMEOUT_MS = 10 * 60_000;
const OPENSHELL_INSTALL_TIMEOUT_MS = 10 * 60_000;
const DISTRO_IMPORT_TIMEOUT_MS = 5 * 60_000;

/**
 * @typedef {Object} InstallerState
 * @property {string[]} completed
 * @property {boolean} rebootRequired
 * @property {string|null} lastError
 * @property {number|null} startedAt
 * @property {number|null} updatedAt
 *
 * @typedef {Object} PhaseContext
 * @property {(evt: {phase: string, message: string, percent?: number}) => void} [onProgress]
 * @property {AbortSignal} [signal]
 * @property {InstallerState} [state]
 * @property {string} [rootfsPath]
 * @property {string} [powershellExe]
 */

function defaultState() {
  return {
    completed: [],
    rebootRequired: false,
    lastError: null,
    startedAt: null,
    updatedAt: null,
  };
}

function normalizeState(parsed) {
  const seen = new Set();
  const completed = [];
  for (const id of Array.isArray(parsed?.completed) ? parsed.completed : []) {
    if (typeof id !== "string") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    completed.push(id);
  }
  return {
    completed,
    rebootRequired: !!parsed?.rebootRequired,
    lastError: typeof parsed?.lastError === "string" ? parsed.lastError : null,
    startedAt: Number.isFinite(parsed?.startedAt) ? parsed.startedAt : null,
    updatedAt: Number.isFinite(parsed?.updatedAt) ? parsed.updatedAt : null,
  };
}

export async function loadInstallerState(filePath = DEFAULT_STATE_FILE) {
  try {
    const text = await readFile(filePath, "utf8");
    return normalizeState(JSON.parse(text));
  } catch {
    return defaultState();
  }
}

export async function saveInstallerState(state, filePath = DEFAULT_STATE_FILE) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const out = { ...state, updatedAt: Date.now() };
  await writeFile(filePath, JSON.stringify(out, null, 2), "utf8");
  return out;
}

class RebootRequiredError extends Error {
  constructor(message = "A reboot is required to continue.") {
    super(message);
    this.code = "REBOOT_REQUIRED";
  }
}

// ─────────────── Phase implementations ──────────────────────────────────

/** @param {PhaseContext} ctx */
async function phasePreflight({ onProgress }) {
  onProgress?.({ phase: "preflight", message: "Checking system requirements..." });
  if (process.platform !== "win32") {
    throw new Error(
      `OpenShell requires Windows 11; detected ${process.platform}.`,
    );
  }
  const release = os.release();
  const buildMatch = release.match(/^\d+\.\d+\.(\d+)/);
  const build = buildMatch ? Number(buildMatch[1]) : 0;
  if (build < MIN_WIN11_BUILD) {
    throw new Error(
      `Windows build ${build || "unknown"} is below the required ${MIN_WIN11_BUILD} (Windows 11).`,
    );
  }
  const memGB = os.totalmem() / 1024 ** 3;
  if (memGB < MIN_RAM_GB) {
    throw new Error(
      `Only ${memGB.toFixed(1)} GB RAM detected; OpenShell needs ≥ 16 GB.`,
    );
  }
  onProgress?.({ phase: "preflight", message: "System requirements met.", percent: 100 });
}

/** @param {PhaseContext} ctx */
async function phaseWsl({ onProgress, signal, powershellExe }) {
  onProgress?.({ phase: "wsl", message: "Installing WSL2...", percent: 0 });
  const probe = await wslRun(["--status"], { timeout: 10_000, signal }).catch(() => null);
  if (probe?.exitCode === 0) {
    // Already installed; force version 2 default.
    const set = await wslRun(["--set-default-version", "2"], { timeout: 10_000, signal });
    if (set.exitCode !== 0 && set.exitCode !== null) {
      throw new Error(`wsl --set-default-version 2 failed: ${set.stderr}`);
    }
    onProgress?.({ phase: "wsl", message: "WSL2 already installed.", percent: 100 });
    return;
  }
  // First install. wsl --install needs admin; we spawn an elevated child
  // via PowerShell's Start-Process -Verb RunAs so the user sees one UAC
  // prompt instead of the installer crashing on permission errors.
  const exe = powershellExe || "powershell.exe";
  const result = spawnSync(
    exe,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process wsl.exe -Verb RunAs -Wait -ArgumentList '--install --no-distribution'",
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `wsl --install failed (elevation declined?): ${result.stderr || result.stdout || "unknown"}`,
    );
  }
  throw new RebootRequiredError(
    "WSL2 installed. Please reboot and relaunch OpenWork to continue setup.",
  );
}

/** @param {PhaseContext} ctx */
async function phaseDistro({ onProgress, signal, rootfsPath }) {
  onProgress?.({ phase: "distro", message: `Importing ${DISTRO_NAME}...`, percent: 0 });
  if (!rootfsPath) {
    throw new Error(
      "Rootfs path was not provided. The MSI should ship a bundled tarball at " +
        "resources/openshell/ubuntu-24.04-openshell.tar.gz.",
    );
  }
  if (!existsSync(rootfsPath)) {
    throw new Error(`Bundled rootfs not found at ${rootfsPath}.`);
  }
  // Skip if already registered.
  const list = await wslRun(["--list", "--quiet"], { timeout: 10_000, signal });
  if (list.exitCode === 0) {
    const present = list.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .includes(DISTRO_NAME);
    if (present) {
      onProgress?.({ phase: "distro", message: "Distro already registered.", percent: 100 });
      return;
    }
  }
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const installDir = path.join(localAppData, "openwork", "distro");
  await mkdir(installDir, { recursive: true });
  const importResult = await wslRun(
    ["--import", DISTRO_NAME, installDir, rootfsPath, "--version", "2"],
    { timeout: DISTRO_IMPORT_TIMEOUT_MS, signal },
  );
  if (importResult.exitCode !== 0) {
    throw new Error(`wsl --import failed: ${importResult.stderr || importResult.stdout}`);
  }
  onProgress?.({ phase: "distro", message: "Distro imported.", percent: 100 });
}

/** @param {PhaseContext} ctx */
async function phaseDocker({ onProgress, signal }) {
  onProgress?.({ phase: "docker", message: "Installing Docker Engine inside the distro...", percent: 0 });
  // One bash -c script keeps us to a single wsl.exe round-trip and avoids
  // partial-state failures between apt commands.
  const script = [
    "set -e",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y ca-certificates curl gnupg",
    "install -m 0755 -d /etc/apt/keyrings",
    "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg",
    "chmod a+r /etc/apt/keyrings/docker.gpg",
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list',
    "apt-get update",
    "apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin",
    "service docker start || systemctl enable --now docker || true",
  ].join("\n");
  const r = await wslRun(
    ["-d", DISTRO_NAME, "--user", "root", "--", "bash", "-c", script],
    { timeout: DOCKER_INSTALL_TIMEOUT_MS, signal },
  );
  if (r.exitCode !== 0) {
    throw new Error(`Docker install failed: ${r.stderr || r.stdout}`);
  }
  onProgress?.({ phase: "docker", message: "Docker Engine running inside distro.", percent: 100 });
}

/** @param {PhaseContext} ctx */
async function phaseOpenshell({ onProgress, signal }) {
  onProgress?.({ phase: "openshell", message: "Installing OpenShell CLI...", percent: 0 });
  const script = [
    "set -e",
    "curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell-Community/main/install.sh | bash",
    "openshell init --bootstrap-policies",
    "openshell gateway start --detach",
  ].join("\n");
  const r = await wslRun(
    ["-d", DISTRO_NAME, "--", "bash", "-c", script],
    { timeout: OPENSHELL_INSTALL_TIMEOUT_MS, signal },
  );
  if (r.exitCode !== 0) {
    throw new Error(`OpenShell install failed: ${r.stderr || r.stdout}`);
  }
  onProgress?.({ phase: "openshell", message: "OpenShell CLI + gateway ready.", percent: 100 });
}

/** @param {PhaseContext} ctx */
async function phaseVerify({ onProgress }) {
  onProgress?.({ phase: "verify", message: "Verifying installation...", percent: 0 });
  const result = await openshellDoctor();
  if (result.status !== "ready") {
    const reason = result.fatal[0] ?? result.actionable[0] ?? `status: ${result.status}`;
    throw new Error(`Verify failed: ${reason}`);
  }
  onProgress?.({ phase: "verify", message: "All components healthy.", percent: 100 });
}

const DEFAULT_PHASES = [
  { id: "preflight", run: phasePreflight },
  { id: "wsl", run: phaseWsl },
  { id: "distro", run: phaseDistro },
  { id: "docker", run: phaseDocker },
  { id: "openshell", run: phaseOpenshell },
  { id: "verify", run: phaseVerify },
];

// ─────────────── Orchestrator ───────────────────────────────────────────

/**
 * @param {Object} [options]
 * @param {(phase: string, status: "starting"|"done"|"failed"|"reboot_required", error?: Error) => void} [options.onPhase]
 * @param {(evt: {phase: string, message: string, percent?: number}) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.rootfsPath]
 * @param {string} [options.powershellExe]
 * @param {string} [options.stateFile]
 * @param {typeof DEFAULT_PHASES} [options.phases] - DI seam for tests
 * @returns {Promise<{ status: "ready"|"reboot_required"|"cancelled", state: InstallerState }>}
 */
export async function installOpenShellStack(options = {}) {
  const {
    onPhase,
    onProgress,
    signal,
    rootfsPath,
    powershellExe,
    stateFile = DEFAULT_STATE_FILE,
    phases = DEFAULT_PHASES,
  } = options;

  let state = await loadInstallerState(stateFile);
  if (!state.startedAt) {
    state.startedAt = Date.now();
    state = await saveInstallerState(state, stateFile);
  }

  for (const phase of phases) {
    if (signal?.aborted) {
      return { status: "cancelled", state };
    }
    if (state.completed.includes(phase.id)) continue;

    onPhase?.(phase.id, "starting");
    try {
      await phase.run({ onProgress, signal, state, rootfsPath, powershellExe });
      state.completed.push(phase.id);
      state.lastError = null;
      state.rebootRequired = false;
      state = await saveInstallerState(state, stateFile);
      onPhase?.(phase.id, "done");
    } catch (err) {
      const message = err?.message ?? String(err);
      state.lastError = `${phase.id}: ${message}`;
      if (err?.code === "REBOOT_REQUIRED") {
        state.rebootRequired = true;
        state = await saveInstallerState(state, stateFile);
        onPhase?.(phase.id, "reboot_required", err);
        return { status: "reboot_required", state };
      }
      state = await saveInstallerState(state, stateFile);
      onPhase?.(phase.id, "failed", err);
      throw err;
    }
  }
  return { status: "ready", state };
}

/** Exported for tests so the suite can drive the orchestrator without
 *  hitting wsl.exe / PowerShell at all. */
export const __testing = {
  defaultState,
  normalizeState,
  RebootRequiredError,
  DEFAULT_PHASES,
  phases: {
    preflight: phasePreflight,
    wsl: phaseWsl,
    distro: phaseDistro,
    docker: phaseDocker,
    openshell: phaseOpenshell,
    verify: phaseVerify,
  },
};
