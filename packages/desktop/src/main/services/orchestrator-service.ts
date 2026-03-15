import { ipcMain } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import type {
  OrchestratorDetachedHost,
  OrchestratorStatus,
  OrchestratorWorkspace,
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
  const candidates = [
    path.join(path.dirname(process.execPath), process.platform === "win32" ? "openwork-orchestrator.exe" : "openwork-orchestrator"),
    process.resourcesPath
      ? path.join(process.resourcesPath, "sidecars", process.platform === "win32" ? "openwork-orchestrator.exe" : "openwork-orchestrator")
      : null,
    process.resourcesPath
      ? path.join(process.resourcesPath, process.platform === "win32" ? "openwork-orchestrator.exe" : "openwork-orchestrator")
      : null,
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
  return {
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
  };
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
}
