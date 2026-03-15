import { app, ipcMain } from "electron";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceInfo, WorkspaceList } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";
import { validatePathInput, validateWorkspaceId } from "../ipc/validation";
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
}
