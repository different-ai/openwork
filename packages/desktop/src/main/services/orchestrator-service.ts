import { ipcMain } from "electron";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type {
  OrchestratorStatus,
  OrchestratorWorkspace,
} from "../../../../app/src/app/lib/desktop-contract";
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

export function createOrchestratorService() {
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
}
