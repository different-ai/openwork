import { app, ipcMain } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  ExecResult,
  OpenworkDockerCleanupResult,
  OrchestratorDetachedHost,
  OrchestratorStatus,
  OrchestratorWorkspace,
  SandboxDebugProbeResult,
  SandboxDoctorResult,
} from "../../../../app/src/app/lib/desktop-contract";
import type { SandboxCreateProgressEvent } from "../../../../app/src/app/lib/openwork-desktop";
import { IPC_CHANNELS } from "../ipc/channels";

type OrchestratorHealth = {
  ok: boolean;
  daemon?: OrchestratorStatus["daemon"];
  opencode?: OrchestratorStatus["opencode"];
  cliVersion?: string | null;
  sidecar?: OrchestratorStatus["sidecar"];
  binaries?: OrchestratorStatus["binaries"];
  activeId?: string | null;
  workspaceCount?: number | null;
};

type OrchestratorWorkspaceList = {
  activeId?: string | null;
  workspaces: OrchestratorWorkspace[];
};

type OrchestratorStateFile = {
  daemon?: OrchestratorStatus["daemon"];
  opencode?: OrchestratorStatus["opencode"];
  cliVersion?: string | null;
  sidecar?: OrchestratorStatus["sidecar"];
  binaries?: OrchestratorStatus["binaries"];
  activeId?: string | null;
  workspaces?: OrchestratorWorkspace[];
};

type OrchestratorWorkspaceResponse = {
  workspace: OrchestratorWorkspace;
};

type OrchestratorDisposeResponse = {
  disposed: boolean;
};

type OrchestratorServiceOptions = {
  emitSandboxProgress?: (event: SandboxCreateProgressEvent) => void;
};

function resolveOrchestratorDataDir() {
  const configured = process.env.OPENWORK_DATA_DIR?.trim();
  if (configured) {
    return configured;
  }

  return path.join(process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || ".", ".openwork", "openwork-orchestrator");
}

function orchestratorStatePath(dataDir: string) {
  return path.join(dataDir, "openwork-orchestrator-state.json");
}

function readOrchestratorState(dataDir: string) {
  const statePath = orchestratorStatePath(dataDir);
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as OrchestratorStateFile;
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

function emitSandboxProgress(
  options: OrchestratorServiceOptions,
  runId: string,
  stage: string,
  message: string,
  payload?: unknown,
) {
  options.emitSandboxProgress?.({
    runId,
    stage,
    message,
    payload,
  });
}

function deriveOrchestratorContainerName(runId: string) {
  const sanitized = runId
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .slice(0, 24);
  return `openwork-orchestrator-${sanitized}`;
}

async function allocateFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function resolveOrchestratorCommand() {
  const currentFile = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const appPath = app.getAppPath();
  const sourceSidecarDirs = [
    path.resolve(appPath, "resources/sidecars"),
    path.resolve(appPath, "../resources/sidecars"),
    path.resolve(currentDir, "../../../resources/sidecars"),
    path.resolve(currentDir, "../../../../../resources/sidecars"),
  ];
  const candidates = [
    path.join(path.dirname(process.execPath), process.platform === "win32" ? "openwork-orchestrator.exe" : "openwork-orchestrator"),
    process.resourcesPath
      ? path.join(process.resourcesPath, "sidecars", process.platform === "win32" ? "openwork-orchestrator.exe" : "openwork-orchestrator")
      : null,
    process.resourcesPath
      ? path.join(process.resourcesPath, process.platform === "win32" ? "openwork-orchestrator.exe" : "openwork-orchestrator")
      : null,
    ...sourceSidecarDirs.map((dir) => path.join(dir, process.platform === "win32" ? "openwork-orchestrator.exe" : "openwork-orchestrator")),
  ].filter((candidate): candidate is string => Boolean(candidate) && existsSync(candidate as string));

  return candidates[0] ?? (process.platform === "win32" ? "openwork.exe" : "openwork");
}

async function waitForOpenworkHealth(baseUrl: string, timeoutMs: number, onTick: (elapsedMs: number, lastError: string | null) => void) {
  const startedAt = Date.now();
  let lastTickAt = 0;
  let lastError: string | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const elapsedMs = Date.now() - startedAt;
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
      if (response.ok) {
        return elapsedMs;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (Date.now() - lastTickAt > 850) {
      lastTickAt = Date.now();
      onTick(elapsedMs, lastError);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(lastError ?? "Timed out waiting for OpenWork server");
}

type DockerCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
  program: string;
};

function truncateForDebug(input: string, max = 1200) {
  const trimmed = input.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}...[truncated]`;
}

function truncateForReport(input: string, max = 48_000) {
  const trimmed = input.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}...[truncated]`;
}

function resolveDockerCandidates() {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const key of ["OPENWORK_DOCKER_BIN", "OPENWRK_DOCKER_BIN", "DOCKER_BIN"] as const) {
    const value = process.env[key]?.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      candidates.push(value);
    }
  }

  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, process.platform === "win32" ? "docker.exe" : "docker");
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  for (const candidate of [
    "/opt/homebrew/bin/docker",
    "/usr/local/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ]) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates.filter((candidate) => existsSync(candidate));
}

function runLocalCommandWithTimeout(program: string, args: string[], timeoutMs: number) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timed out after ${timeoutMs}ms running ${program} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}

async function runDockerCommandDetailed(args: string[], timeoutMs: number): Promise<DockerCommandResult> {
  const candidates = [...resolveDockerCandidates(), process.platform === "win32" ? "docker.exe" : "docker"];
  const errors: string[] = [];

  for (const program of candidates) {
    try {
      const result = await runLocalCommandWithTimeout(program, args, timeoutMs);
      return {
        ...result,
        program,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(
    `Failed to run docker: ${errors.join("; ")} (Set OPENWORK_DOCKER_BIN or OPENWRK_DOCKER_BIN to your docker binary)`,
  );
}

async function runDockerCommand(args: string[], timeoutMs: number) {
  const result = await runDockerCommandDetailed(args, timeoutMs);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseDockerClientVersion(stdout: string) {
  const line = stdout.split(/\r?\n/)[0]?.trim() ?? "";
  return line.toLowerCase().startsWith("docker version") ? line : null;
}

function parseDockerServerVersion(stdout: string) {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Server Version:")) {
      const value = trimmed.slice("Server Version:".length).trim();
      if (value) {
        return value;
      }
    }
  }
  return null;
}

function isOpenworkManagedContainer(name: string) {
  return name.startsWith("openwork-orchestrator-") || name.startsWith("openwork-dev-") || name.startsWith("openwrk-");
}

async function listOpenworkManagedContainers() {
  const result = await runDockerCommand(["ps", "-a", "--format", "{{.Names}}"], 8000);
  if (result.status !== 0) {
    const combined = `${result.stdout.trim()}\n${result.stderr.trim()}`.trim();
    throw new Error(combined ? `docker ps -a failed (status ${result.status}): ${combined}` : `docker ps -a failed (status ${result.status})`);
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name && isOpenworkManagedContainer(name))
    .sort();
}

async function dockerContainerState(containerName: string) {
  const result = await runDockerCommand(["inspect", "-f", "{{.State.Status}}", containerName], 4000);
  if (result.status !== 0) {
    return null;
  }

  const value = result.stdout.trim();
  return value || null;
}

function fallbackStatusFromState(dataDir: string, lastError: string | null): OrchestratorStatus {
  const state = readOrchestratorState(dataDir);
  const workspaces = state?.workspaces ?? [];
  const activeId = state?.activeId?.trim() ? state.activeId : null;
  return {
    running: false,
    dataDir,
    daemon: state?.daemon ?? null,
    opencode: state?.opencode ?? null,
    cliVersion: state?.cliVersion ?? null,
    sidecar: state?.sidecar ?? null,
    binaries: state?.binaries ?? null,
    activeId,
    workspaceCount: workspaces.length,
    workspaces,
    lastError,
  };
}

async function resolveOrchestratorStatus(dataDir: string, lastError: string | null) {
  const fallback = fallbackStatusFromState(dataDir, lastError);
  const baseUrl = fallback.daemon?.baseUrl?.trim();
  if (!baseUrl) {
    return fallback;
  }

  try {
    const health = await fetchJson<OrchestratorHealth>(`${baseUrl.replace(/\/$/, "")}/health`);
    const workspacePayload = await fetchJson<OrchestratorWorkspaceList>(`${baseUrl.replace(/\/$/, "")}/workspaces`).catch(() => null);
    const workspaces = workspacePayload?.workspaces ?? fallback.workspaces;
    const activeId = workspacePayload?.activeId?.trim()
      ? workspacePayload.activeId
      : health.activeId?.trim()
        ? health.activeId
        : null;
    return {
      running: health.ok,
      dataDir,
      daemon: health.daemon ?? null,
      opencode: health.opencode ?? null,
      cliVersion: health.cliVersion ?? null,
      sidecar: health.sidecar ?? null,
      binaries: health.binaries ?? null,
      activeId,
      workspaceCount: workspacePayload?.workspaces.length ?? health.workspaceCount ?? workspaces.length,
      workspaces,
      lastError: null,
    } satisfies OrchestratorStatus;
  } catch (error) {
    return {
      ...fallback,
      lastError: error instanceof Error ? error.message : String(error),
    } satisfies OrchestratorStatus;
  }
}

function resolveBaseUrlFromStatus(status: OrchestratorStatus) {
  const baseUrl = status.daemon?.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error("orchestrator daemon is not running");
  }
  return baseUrl;
}

export function createOrchestratorService(options: OrchestratorServiceOptions = {}) {
  const service = {
    async status() {
      return resolveOrchestratorStatus(resolveOrchestratorDataDir(), null);
    },

    async activateWorkspace(input: { workspacePath: string; name?: string | null }) {
      const status = await this.status();
      const baseUrl = resolveBaseUrlFromStatus(status);
      const added = await fetchJson<OrchestratorWorkspaceResponse>(`${baseUrl.replace(/\/$/, "")}/workspaces`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: input.workspacePath,
          name: input.name ?? null,
        }),
      });

      const id = added.workspace.id;
      await fetchJson(`${baseUrl.replace(/\/$/, "")}/workspaces/${id}/activate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "",
      });

      void fetch(`${baseUrl.replace(/\/$/, "")}/workspaces/${id}/path`).catch(() => undefined);
      return added.workspace;
    },

    async disposeInstance(input: { workspacePath: string }) {
      const status = await this.status();
      const baseUrl = resolveBaseUrlFromStatus(status);
      const added = await fetchJson<OrchestratorWorkspaceResponse>(`${baseUrl.replace(/\/$/, "")}/workspaces`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: input.workspacePath,
        }),
      });

      const id = added.workspace.id;
      const disposed = await fetchJson<OrchestratorDisposeResponse>(`${baseUrl.replace(/\/$/, "")}/instances/${id}/dispose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: "",
      });

      return disposed.disposed;
    },

    async startDetached(input: {
      workspacePath: string;
      sandboxBackend?: "none" | "docker" | null;
      runId?: string | null;
      openworkToken?: string | null;
      openworkHostToken?: string | null;
    }): Promise<OrchestratorDetachedHost> {
      const workspacePath = input.workspacePath.trim();
      if (!workspacePath) {
        throw new Error("workspacePath is required");
      }

      const sandboxBackend = (input.sandboxBackend ?? "none").trim().toLowerCase();
      const wantsDockerSandbox = sandboxBackend === "docker";
      const sandboxRunId = input.runId?.trim() || randomUUID();
      const sandboxContainerName = wantsDockerSandbox ? deriveOrchestratorContainerName(sandboxRunId) : null;
      const port = await allocateFreePort();
      const token = input.openworkToken?.trim() || randomUUID();
      const hostToken = input.openworkHostToken?.trim() || randomUUID();
      const openworkUrl = `http://127.0.0.1:${port}`;

      emitSandboxProgress(options, sandboxRunId, "init", "Starting sandbox...", {
        workspacePath,
        openworkUrl,
        port,
        sandboxBackend: wantsDockerSandbox ? "docker" : "none",
        containerName: sandboxContainerName,
      });

      const command = resolveOrchestratorCommand();
      const args = [
        "start",
        "--workspace",
        workspacePath,
        "--approval",
        "auto",
        "--no-opencode-auth",
        "--opencode-router",
        "true",
        "--detach",
        "--openwork-host",
        "0.0.0.0",
        "--openwork-port",
        String(port),
        "--openwork-token",
        token,
        "--openwork-host-token",
        hostToken,
        "--run-id",
        sandboxRunId,
      ];

      if (wantsDockerSandbox) {
        args.push("--sandbox", "docker");
      }

      emitSandboxProgress(options, sandboxRunId, "spawn.config", "Launching sandbox host...", {
        command,
        args,
        env: {
          PATH: process.env.PATH ?? null,
          OPENWORK_DOCKER_BIN: process.env.OPENWORK_DOCKER_BIN ?? null,
          OPENWRK_DOCKER_BIN: process.env.OPENWRK_DOCKER_BIN ?? null,
          DOCKER_BIN: process.env.DOCKER_BIN ?? null,
        },
      });

      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();

      emitSandboxProgress(options, sandboxRunId, "spawned", "Sandbox process launched. Waiting for OpenWork server...", {
        openworkUrl,
      });

      const timeoutMs = wantsDockerSandbox ? 90_000 : 12_000;
      try {
        const elapsedMs = await waitForOpenworkHealth(openworkUrl, timeoutMs, (tickElapsedMs, lastError) => {
          emitSandboxProgress(options, sandboxRunId, "openwork.waiting", "Waiting for OpenWork server...", {
            openworkUrl,
            elapsedMs: tickElapsedMs,
            lastError,
            containerState: sandboxContainerName ? "unknown" : null,
          });
        });

        emitSandboxProgress(options, sandboxRunId, "openwork.healthy", "OpenWork server is ready.", {
          openworkUrl,
          elapsedMs,
          containerState: sandboxContainerName ? "unknown" : null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitSandboxProgress(options, sandboxRunId, "error", "Sandbox failed to start.", {
          error: message,
          openworkUrl,
          containerState: sandboxContainerName ? "unknown" : null,
        });
        throw new Error(message);
      }

      return {
        openworkUrl,
        token,
        hostToken,
        port,
        sandboxBackend: wantsDockerSandbox ? "docker" : null,
        sandboxRunId: wantsDockerSandbox ? sandboxRunId : null,
        sandboxContainerName,
      };
    },

    async sandboxDoctor(): Promise<SandboxDoctorResult> {
      const candidates = resolveDockerCandidates();
      const debug: NonNullable<SandboxDoctorResult["debug"]> = {
        candidates,
        selectedBin: null,
        versionCommand: null,
        infoCommand: null,
      };

      let versionResult: DockerCommandResult;
      try {
        versionResult = await runDockerCommandDetailed(["--version"], 2000);
      } catch (error) {
        return {
          installed: false,
          daemonRunning: false,
          permissionOk: false,
          ready: false,
          clientVersion: null,
          serverVersion: null,
          error: error instanceof Error ? error.message : String(error),
          debug,
        };
      }

      debug.selectedBin = versionResult.program;
      debug.versionCommand = {
        status: versionResult.status,
        stdout: truncateForDebug(versionResult.stdout),
        stderr: truncateForDebug(versionResult.stderr),
      };

      if (versionResult.status !== 0) {
        return {
          installed: false,
          daemonRunning: false,
          permissionOk: false,
          ready: false,
          clientVersion: null,
          serverVersion: null,
          error: `docker --version failed (status ${versionResult.status}): ${versionResult.stderr.trim()}`,
          debug,
        };
      }

      const clientVersion = parseDockerClientVersion(versionResult.stdout);

      let infoResult: DockerCommandResult;
      try {
        infoResult = await runDockerCommandDetailed(["info"], 8000);
      } catch (error) {
        return {
          installed: true,
          daemonRunning: false,
          permissionOk: false,
          ready: false,
          clientVersion,
          serverVersion: null,
          error: error instanceof Error ? error.message : String(error),
          debug,
        };
      }

      debug.infoCommand = {
        status: infoResult.status,
        stdout: truncateForDebug(infoResult.stdout),
        stderr: truncateForDebug(infoResult.stderr),
      };

      if (infoResult.status === 0) {
        return {
          installed: true,
          daemonRunning: true,
          permissionOk: true,
          ready: true,
          clientVersion,
          serverVersion: parseDockerServerVersion(infoResult.stdout),
          error: null,
          debug,
        };
      }

      const combined = `${infoResult.stdout.trim()}\n${infoResult.stderr.trim()}`.trim();
      const lower = combined.toLowerCase();
      const permissionOk =
        !lower.includes("permission denied") &&
        !lower.includes("got permission denied") &&
        !lower.includes("access is denied");
      const daemonRunning =
        !lower.includes("cannot connect to the docker daemon") &&
        !lower.includes("is the docker daemon running") &&
        !lower.includes("error during connect") &&
        !lower.includes("connection refused") &&
        !lower.includes("failed to connect to the docker api") &&
        !lower.includes("dial unix") &&
        !lower.includes("no such file or directory");

      return {
        installed: true,
        daemonRunning,
        permissionOk,
        ready: false,
        clientVersion,
        serverVersion: null,
        error: combined || `docker info failed (status ${infoResult.status})`,
        debug,
      };
    },

    async sandboxStop(input: { containerName: string }): Promise<ExecResult> {
      const name = input.containerName.trim();
      if (!name) {
        throw new Error("containerName is required");
      }
      if (!name.startsWith("openwork-orchestrator-")) {
        throw new Error("Refusing to stop container: expected name starting with 'openwork-orchestrator-'");
      }
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
        throw new Error("containerName contains invalid characters");
      }

      const result = await runDockerCommand(["stop", name], 15000);
      return {
        ok: result.status === 0,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },

    async sandboxCleanupOpenworkContainers(): Promise<OpenworkDockerCleanupResult> {
      const candidates = await listOpenworkManagedContainers();
      if (candidates.length === 0) {
        return { candidates, removed: [], errors: [] };
      }

      const removed: string[] = [];
      const errors: string[] = [];
      for (const name of candidates) {
        try {
          const result = await runDockerCommand(["rm", "-f", name], 20000);
          if (result.status === 0) {
            removed.push(name);
          } else {
            const combined = `${result.stdout.trim()}\n${result.stderr.trim()}`.trim();
            errors.push(`${name}: ${combined ? `exit ${result.status}: ${truncateForDebug(combined)}` : `exit ${result.status}`}`);
          }
        } catch (error) {
          errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return { candidates, removed, errors };
    },

    async sandboxDebugProbe(): Promise<SandboxDebugProbeResult> {
      const startedAt = Date.now();
      const runId = `probe-${randomUUID()}`;
      const workspacePath = path.join(os.tmpdir(), `openwork-sandbox-probe-${randomUUID()}`);
      await mkdir(workspacePath, { recursive: true });

      let workspaceRemoved = false;
      const cleanupErrors: string[] = [];
      const doctor = await service.sandboxDoctor();
      let detachedHost: OrchestratorDetachedHost | null = null;
      let dockerInspect: SandboxDebugProbeResult["dockerInspect"] = null;
      let dockerLogs: SandboxDebugProbeResult["dockerLogs"] = null;
      let error: string | null = null;

      if (doctor.ready) {
        try {
          detachedHost = await service.startDetached({
            workspacePath,
            sandboxBackend: "docker",
            runId,
          });

          const containerName = detachedHost.sandboxContainerName ?? deriveOrchestratorContainerName(runId);

          try {
            const inspectResult = await runDockerCommandDetailed(["inspect", containerName], 6000);
            dockerInspect = {
              status: inspectResult.status,
              stdout: truncateForReport(inspectResult.stdout),
              stderr: truncateForReport(inspectResult.stderr),
            };
          } catch (inspectError) {
            cleanupErrors.push(`docker inspect failed: ${inspectError instanceof Error ? inspectError.message : String(inspectError)}`);
          }

          try {
            const logsResult = await runDockerCommandDetailed(["logs", "--timestamps", "--tail", "400", containerName], 8000);
            dockerLogs = {
              status: logsResult.status,
              stdout: truncateForReport(logsResult.stdout),
              stderr: truncateForReport(logsResult.stderr),
            };
          } catch (logsError) {
            cleanupErrors.push(`docker logs failed: ${logsError instanceof Error ? logsError.message : String(logsError)}`);
          }
        } catch (probeError) {
          error = `Sandbox probe failed to start: ${probeError instanceof Error ? probeError.message : String(probeError)}`;
        }
      } else {
        error = doctor.error ?? "Docker is not ready for sandbox creation";
      }

      const containerName = detachedHost?.sandboxContainerName ?? (doctor.ready ? deriveOrchestratorContainerName(runId) : null);
      let containerRemoved = false;
      let removeResult: SandboxDebugProbeResult["cleanup"]["removeResult"] = null;
      if (containerName) {
        try {
          const result = await runDockerCommandDetailed(["rm", "-f", containerName], 20000);
          containerRemoved = result.status === 0;
          removeResult = {
            status: result.status,
            stdout: truncateForReport(result.stdout),
            stderr: truncateForReport(result.stderr),
          };
        } catch (removeError) {
          cleanupErrors.push(`docker rm -f ${containerName} failed: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
        }
      }

      try {
        await rm(workspacePath, { recursive: true, force: true });
        workspaceRemoved = true;
      } catch (workspaceError) {
        cleanupErrors.push(`Failed to remove probe workspace: ${workspaceError instanceof Error ? workspaceError.message : String(workspaceError)}`);
      }

      return {
        startedAt,
        finishedAt: Date.now(),
        runId,
        workspacePath,
        ready: doctor.ready && !error,
        doctor,
        detachedHost,
        dockerInspect,
        dockerLogs,
        cleanup: {
          containerName,
          containerRemoved,
          removeResult,
          workspaceRemoved,
          errors: cleanupErrors,
        },
        error,
      };
    },
  };

  return service;
}

export type OrchestratorService = ReturnType<typeof createOrchestratorService>;

export function registerOrchestratorIpc(service: OrchestratorService) {
  ipcMain.handle(IPC_CHANNELS.orchestrator("status"), () => service.status());
  ipcMain.handle(
    IPC_CHANNELS.orchestrator("activateWorkspace"),
    (_event, input: { workspacePath: string; name?: string | null }) => service.activateWorkspace(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.orchestrator("disposeInstance"),
    (_event, input: { workspacePath: string }) => service.disposeInstance(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.orchestrator("startDetached"),
    (_event, input: Parameters<OrchestratorService["startDetached"]>[0]) => service.startDetached(input),
  );
  ipcMain.handle(IPC_CHANNELS.orchestrator("sandboxDoctor"), () => service.sandboxDoctor());
  ipcMain.handle(
    IPC_CHANNELS.orchestrator("sandboxStop"),
    (_event, input: { containerName: string }) => service.sandboxStop(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.orchestrator("sandboxCleanupOpenworkContainers"),
    () => service.sandboxCleanupOpenworkContainers(),
  );
  ipcMain.handle(IPC_CHANNELS.orchestrator("sandboxDebugProbe"), () => service.sandboxDebugProbe());
}
