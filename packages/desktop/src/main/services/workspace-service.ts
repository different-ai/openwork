import { app, ipcMain } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ExecResult,
  WorkspaceInfo,
  WorkspaceList,
  WorkspaceOpenworkConfig,
} from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";
import { validatePathInput, validateUrlInput, validateWorkspaceId } from "../ipc/validation";
import {
  createDefaultWorkspaceRegistryStore,
  type WorkspaceState,
} from "./workspace-registry-store";
import { ensureWorkspaceFiles } from "./workspace-files";

function stableWorkspaceId(key: string) {
  return `ws-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function normalizeWorkspacePathKey(value: string) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeRemoteKey(baseUrl: string, directory?: string | null) {
  return `remote::${baseUrl}${directory ? `::${directory.trim()}` : ""}`;
}

function normalizeOpenworkRemoteKey(hostUrl: string, workspaceId?: string | null) {
  return `openwork::${hostUrl}${workspaceId ? `::${workspaceId.trim()}` : ""}`;
}

function normalizeOptionalText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveOpenworkConfigPath(workspacePath: string) {
  return path.join(workspacePath, ".opencode", "openwork.json");
}

export function createWorkspaceService() {
  const store = createDefaultWorkspaceRegistryStore();

  const toWorkspaceList = (state: WorkspaceState): WorkspaceList => ({
    activeId: state.activeId,
    workspaces: state.workspaces,
  });

  const ensureStarterWorkspace = async (state: WorkspaceState) => {
    const starterPath = path.join(store.getPaths().userDataDir, "workspaces", "starter");
    await mkdir(starterPath, { recursive: true });
    await ensureWorkspaceFiles(starterPath, "starter");

    const existing = state.workspaces.find(
      (workspace) => normalizeWorkspacePathKey(workspace.path) === normalizeWorkspacePathKey(starterPath),
    );
    if (existing) {
      return existing;
    }

    const starter: WorkspaceInfo = {
      id: stableWorkspaceId(starterPath),
      name: "Starter",
      path: starterPath,
      preset: "starter",
      workspaceType: "local",
      remoteType: null,
      baseUrl: null,
      directory: null,
      displayName: null,
      openworkHostUrl: null,
      openworkToken: null,
      openworkWorkspaceId: null,
      openworkWorkspaceName: null,
      sandboxBackend: null,
      sandboxRunId: null,
      sandboxContainerName: null,
    };

    state.workspaces.push(starter);
    return starter;
  };

  return {
    async bootstrap(): Promise<WorkspaceList> {
      const state = await store.load();
      const starter = await ensureStarterWorkspace(state);

      if (!state.activeId.trim()) {
        state.activeId = starter.id;
      }

      if (!state.workspaces.some((workspace) => workspace.id === state.activeId)) {
        state.activeId = starter.id;
      }

      await store.save(state);
      return toWorkspaceList(state);
    },

    async setActive(input: { workspaceId: string }): Promise<WorkspaceList> {
      const workspaceId = validateWorkspaceId(input.workspaceId);
      const state = await store.load();
      if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
        throw new Error("Unknown workspaceId");
      }

      state.activeId = workspaceId;
      await store.save(state);
      return toWorkspaceList(state);
    },

    async create(input: { folderPath: string; name: string; preset: string }): Promise<WorkspaceList> {
      const folderPath = path.resolve(validatePathInput(input.folderPath, { label: "folderPath", allowRelative: false }));
      const name = input.name.trim();
      if (!name) {
        throw new Error("name is required");
      }

      const preset = input.preset.trim() || "starter";
      await mkdir(folderPath, { recursive: true });
      await ensureWorkspaceFiles(folderPath, preset);

      const state = await store.load();
      const pathKey = normalizeWorkspacePathKey(folderPath);
      state.workspaces = state.workspaces.filter(
        (workspace) => normalizeWorkspacePathKey(workspace.path) !== pathKey,
      );

      const workspace: WorkspaceInfo = {
        id: stableWorkspaceId(folderPath),
        name,
        path: folderPath,
        preset,
        workspaceType: "local",
        remoteType: null,
        baseUrl: null,
        directory: null,
        displayName: null,
        openworkHostUrl: null,
        openworkToken: null,
        openworkWorkspaceId: null,
        openworkWorkspaceName: null,
        sandboxBackend: null,
        sandboxRunId: null,
        sandboxContainerName: null,
      };

      state.workspaces.push(workspace);
      state.activeId = workspace.id;
      await store.save(state);
      return toWorkspaceList(state);
    },

    async forget(input: { workspaceId: string }): Promise<WorkspaceList> {
      const workspaceId = validateWorkspaceId(input.workspaceId);
      const state = await store.load();
      const nextWorkspaces = state.workspaces.filter((workspace) => workspace.id !== workspaceId);
      if (nextWorkspaces.length === state.workspaces.length) {
        throw new Error("Unknown workspaceId");
      }

      state.workspaces = nextWorkspaces;
      if (state.activeId === workspaceId) {
        state.activeId = state.workspaces[0]?.id ?? "";
      }

      if (state.workspaces.length === 0) {
        const starter = await ensureStarterWorkspace(state);
        state.activeId = starter.id;
      }

      await store.save(state);
      return toWorkspaceList(state);
    },

    async updateDisplayName(input: { workspaceId: string; displayName?: string | null }): Promise<WorkspaceList> {
      const workspaceId = validateWorkspaceId(input.workspaceId);
      const state = await store.load();
      const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
      if (!workspace) {
        throw new Error("Unknown workspaceId");
      }

      const nextDisplayName = input.displayName?.trim();
      workspace.displayName = nextDisplayName ? nextDisplayName : null;
      await store.save(state);
      return toWorkspaceList(state);
    },

    async createRemote(input: {
      baseUrl: string;
      directory?: string | null;
      displayName?: string | null;
      remoteType?: "openwork" | "opencode" | null;
      openworkHostUrl?: string | null;
      openworkToken?: string | null;
      openworkWorkspaceId?: string | null;
      openworkWorkspaceName?: string | null;
      sandboxBackend?: "docker" | null;
      sandboxRunId?: string | null;
      sandboxContainerName?: string | null;
    }): Promise<WorkspaceList> {
      const baseUrl = validateUrlInput(input.baseUrl, { label: "baseUrl", protocols: ["http:", "https:"] });
      const remoteType = input.remoteType ?? "opencode";
      const directory = normalizeOptionalText(input.directory);
      const displayName = normalizeOptionalText(input.displayName);
      const openworkHostUrl = normalizeOptionalText(input.openworkHostUrl);
      const openworkToken = normalizeOptionalText(input.openworkToken);
      const openworkWorkspaceId = normalizeOptionalText(input.openworkWorkspaceId);
      const openworkWorkspaceName = normalizeOptionalText(input.openworkWorkspaceName);

      if (remoteType === "openwork") {
        if (!openworkHostUrl) {
          throw new Error("openworkHostUrl is required for OpenWork remote");
        }

        validateUrlInput(openworkHostUrl, { label: "openworkHostUrl", protocols: ["http:", "https:"] });
      }

      const id = stableWorkspaceId(
        remoteType === "openwork"
          ? normalizeOpenworkRemoteKey(openworkHostUrl ?? "", openworkWorkspaceId)
          : normalizeRemoteKey(baseUrl, directory),
      );
      const name = openworkWorkspaceName ?? displayName ?? (remoteType === "openwork" ? openworkHostUrl ?? baseUrl : baseUrl);
      const workspacePath = directory ?? "";

      const state = await store.load();
      state.workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
      state.workspaces.push({
        id,
        name,
        path: workspacePath,
        preset: "remote",
        workspaceType: "remote",
        remoteType,
        baseUrl,
        directory,
        displayName,
        openworkHostUrl,
        openworkToken,
        openworkWorkspaceId,
        openworkWorkspaceName,
        sandboxBackend: input.sandboxBackend ?? null,
        sandboxRunId: normalizeOptionalText(input.sandboxRunId),
        sandboxContainerName: normalizeOptionalText(input.sandboxContainerName),
      });
      state.activeId = id;
      await store.save(state);
      return toWorkspaceList(state);
    },

    async updateRemote(input: {
      workspaceId: string;
      baseUrl?: string | null;
      directory?: string | null;
      displayName?: string | null;
      remoteType?: "openwork" | "opencode" | null;
      openworkHostUrl?: string | null;
      openworkToken?: string | null;
      openworkWorkspaceId?: string | null;
      openworkWorkspaceName?: string | null;
      sandboxBackend?: "docker" | null;
      sandboxRunId?: string | null;
      sandboxContainerName?: string | null;
    }): Promise<WorkspaceList> {
      const workspaceId = validateWorkspaceId(input.workspaceId);
      const state = await store.load();
      const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
      if (!workspace) {
        throw new Error("Unknown workspaceId");
      }

      if (workspace.workspaceType !== "remote") {
        throw new Error("workspaceId is not remote");
      }

      if (input.baseUrl?.trim()) {
        workspace.baseUrl = validateUrlInput(input.baseUrl, { label: "baseUrl", protocols: ["http:", "https:"] });
      }

      if (input.directory !== undefined && input.directory !== null) {
        const nextDirectory = normalizeOptionalText(input.directory);
        workspace.directory = nextDirectory;
        workspace.path = nextDirectory ?? "";
      }

      if (input.displayName?.trim()) {
        const nextDisplayName = normalizeOptionalText(input.displayName);
        workspace.displayName = nextDisplayName;
        workspace.name = nextDisplayName ?? workspace.name;
      }

      if (input.remoteType) {
        workspace.remoteType = input.remoteType;
      }

      if (input.openworkHostUrl?.trim()) {
        workspace.openworkHostUrl = validateUrlInput(input.openworkHostUrl, {
          label: "openworkHostUrl",
          protocols: ["http:", "https:"],
        });
      }

      if (input.openworkToken?.trim()) {
        workspace.openworkToken = normalizeOptionalText(input.openworkToken);
      }

      if (input.openworkWorkspaceId?.trim()) {
        workspace.openworkWorkspaceId = normalizeOptionalText(input.openworkWorkspaceId);
      }

      if (input.openworkWorkspaceName?.trim()) {
        const nextWorkspaceName = normalizeOptionalText(input.openworkWorkspaceName);
        workspace.openworkWorkspaceName = nextWorkspaceName;
        if (!workspace.displayName) {
          workspace.name = nextWorkspaceName ?? workspace.name;
        }
      }

      if (input.sandboxBackend) {
        workspace.sandboxBackend = input.sandboxBackend;
      }

      if (input.sandboxRunId?.trim()) {
        workspace.sandboxRunId = normalizeOptionalText(input.sandboxRunId);
      }

      if (input.sandboxContainerName?.trim()) {
        workspace.sandboxContainerName = normalizeOptionalText(input.sandboxContainerName);
      }

      await store.save(state);
      return toWorkspaceList(state);
    },

    async openworkRead(input: { workspacePath: string }): Promise<WorkspaceOpenworkConfig> {
      const workspacePath = path.resolve(
        validatePathInput(input.workspacePath, { label: "workspacePath", allowRelative: false }),
      );
      const openworkPath = resolveOpenworkConfigPath(workspacePath);

      try {
        const raw = await readFile(openworkPath, "utf8");
        return JSON.parse(raw) as WorkspaceOpenworkConfig;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return {
            version: 1,
            workspace: null,
            authorizedRoots: [workspacePath],
            reload: null,
          };
        }

        throw new Error(
          `Failed to read ${openworkPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async openworkWrite(input: {
      workspacePath: string;
      config: WorkspaceOpenworkConfig;
    }): Promise<ExecResult> {
      const workspacePath = path.resolve(
        validatePathInput(input.workspacePath, { label: "workspacePath", allowRelative: false }),
      );
      const openworkPath = resolveOpenworkConfigPath(workspacePath);

      await mkdir(path.dirname(openworkPath), { recursive: true });
      await writeFile(openworkPath, `${JSON.stringify(input.config, null, 2)}\n`, "utf8");

      return {
        ok: true,
        status: 0,
        stdout: `Wrote ${openworkPath}`,
        stderr: "",
      };
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;

export function registerWorkspaceIpc(service: WorkspaceService) {
  ipcMain.handle(IPC_CHANNELS.workspace("bootstrap"), () => service.bootstrap());
  ipcMain.handle(IPC_CHANNELS.workspace("setActive"), (_event, input: { workspaceId: string }) =>
    service.setActive(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.workspace("create"),
    (_event, input: { folderPath: string; name: string; preset: string }) => service.create(input),
  );
  ipcMain.handle(IPC_CHANNELS.workspace("forget"), (_event, input: { workspaceId: string }) => service.forget(input));
  ipcMain.handle(
    IPC_CHANNELS.workspace("updateDisplayName"),
    (_event, input: { workspaceId: string; displayName?: string | null }) => service.updateDisplayName(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.workspace("createRemote"),
    (_event, input: Parameters<WorkspaceService["createRemote"]>[0]) => service.createRemote(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.workspace("updateRemote"),
    (_event, input: Parameters<WorkspaceService["updateRemote"]>[0]) => service.updateRemote(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.workspace("openworkRead"),
    (_event, input: Parameters<WorkspaceService["openworkRead"]>[0]) => service.openworkRead(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.workspace("openworkWrite"),
    (_event, input: Parameters<WorkspaceService["openworkWrite"]>[0]) => service.openworkWrite(input),
  );
}
