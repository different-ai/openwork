import { app, type App } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceInfo, WorkspaceList } from "../../../../app/src/app/lib/desktop-contract";

export const WORKSPACE_STATE_VERSION = 1;

export type WorkspaceState = WorkspaceList & {
  version: number;
};

type WorkspaceRegistryStoreOptions = {
  app: Pick<App, "getPath">;
};

export function createDefaultWorkspaceState(): WorkspaceState {
  return {
    version: WORKSPACE_STATE_VERSION,
    activeId: "",
    workspaces: [],
  };
}

function normalizeWorkspaceInfo(raw: unknown): WorkspaceInfo | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.name !== "string" || typeof record.path !== "string") {
    return null;
  }

  if (typeof record.preset !== "string") {
    return null;
  }

  if (record.workspaceType !== "local" && record.workspaceType !== "remote") {
    return null;
  }

  return record as unknown as WorkspaceInfo;
}

function normalizeWorkspaceState(raw: unknown): WorkspaceState {
  if (!raw || typeof raw !== "object") {
    return createDefaultWorkspaceState();
  }

  const record = raw as Record<string, unknown>;
  const workspaces = Array.isArray(record.workspaces)
    ? record.workspaces.map(normalizeWorkspaceInfo).filter((value): value is WorkspaceInfo => value !== null)
    : [];

  return {
    version:
      typeof record.version === "number" && Number.isFinite(record.version)
        ? Math.max(record.version, WORKSPACE_STATE_VERSION)
        : WORKSPACE_STATE_VERSION,
    activeId: typeof record.activeId === "string" ? record.activeId : "",
    workspaces,
  };
}

export function createWorkspaceRegistryStore(options: WorkspaceRegistryStoreOptions) {
  return {
    getPaths() {
      const userDataDir = options.app.getPath("userData");
      return {
        userDataDir,
        stateFilePath: path.join(userDataDir, "openwork-workspaces.json"),
      };
    },

    async load(): Promise<WorkspaceState> {
      const { stateFilePath } = this.getPaths();

      try {
        const raw = await readFile(stateFilePath, "utf8");
        return normalizeWorkspaceState(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return createDefaultWorkspaceState();
        }

        throw new Error(`Failed to read ${stateFilePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async save(state: WorkspaceState): Promise<void> {
      const normalizedState = normalizeWorkspaceState(state);
      const { userDataDir, stateFilePath } = this.getPaths();

      await mkdir(userDataDir, { recursive: true });
      await writeFile(stateFilePath, `${JSON.stringify(normalizedState, null, 2)}\n`, "utf8");
    },
  };
}

export function createDefaultWorkspaceRegistryStore() {
  return createWorkspaceRegistryStore({ app });
}
