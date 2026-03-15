import AdmZip from "adm-zip";
import { app, ipcMain } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ExecResult,
  WorkspaceInfo,
  WorkspaceList,
  WorkspaceOpenworkConfig,
  WorkspaceExportSummary,
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

function isSecretName(name: string) {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) {
    return true;
  }
  if (lower === "credentials.json" || lower === "credentials.yml" || lower === "credentials.yaml") {
    return true;
  }
  return [".key", ".pem", ".p12", ".pfx"].some((suffix) => lower.endsWith(suffix));
}

async function collectWorkspaceEntries(workspaceRoot: string) {
  const entries: Array<{ absolutePath: string; relativePath: string }> = [];
  const excluded = new Set<string>();

  const maybeConfigPath = path.join(workspaceRoot, "opencode.json");
  if (existsSync(maybeConfigPath)) {
    if (isSecretName(path.basename(maybeConfigPath))) {
      excluded.add("opencode.json");
    } else {
      entries.push({ absolutePath: maybeConfigPath, relativePath: "opencode.json" });
    }
  }

  const walk = async (currentPath: string) => {
    const children = await readdir(currentPath, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = path.join(currentPath, child.name);
      const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
      if (child.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (isSecretName(child.name)) {
        excluded.add(relativePath);
        continue;
      }

      entries.push({ absolutePath, relativePath });
    }
  };

  const opencodeDir = path.join(workspaceRoot, ".opencode");
  if (existsSync(opencodeDir)) {
    await walk(opencodeDir);
  }

  return {
    entries,
    excluded: Array.from(excluded),
  };
}

function isSafeArchivePath(entryName: string) {
  const normalized = path.posix.normalize(entryName);
  return !normalized.startsWith("../") && normalized !== ".." && !path.isAbsolute(normalized);
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

    async addAuthorizedRoot(input: {
      workspacePath: string;
      folderPath: string;
    }): Promise<ExecResult> {
      const workspacePath = path.resolve(
        validatePathInput(input.workspacePath, { label: "workspacePath", allowRelative: false }),
      );
      const folderPath = path.resolve(
        validatePathInput(input.folderPath, { label: "folderPath", allowRelative: false }),
      );

      const state = await store.load();
      const workspace = state.workspaces.find(
        (entry) => normalizeWorkspacePathKey(entry.path) === normalizeWorkspacePathKey(workspacePath),
      );
      if (!workspace || workspace.workspaceType !== "local") {
        throw new Error("workspacePath must belong to a local workspace");
      }

      const config = await this.openworkRead({ workspacePath });
      const roots = new Set(config.authorizedRoots.map((entry) => normalizeWorkspacePathKey(entry)));
      roots.add(normalizeWorkspacePathKey(workspacePath));
      roots.add(normalizeWorkspacePathKey(folderPath));
      config.authorizedRoots = Array.from(roots);

      await this.openworkWrite({ workspacePath, config });
      return {
        ok: true,
        status: 0,
        stdout: "Updated authorizedRoots",
        stderr: "",
      };
    },

    async exportConfig(input: {
      workspaceId: string;
      outputPath: string;
    }): Promise<WorkspaceExportSummary> {
      const workspaceId = validateWorkspaceId(input.workspaceId);
      const outputPath = path.resolve(validatePathInput(input.outputPath, { label: "outputPath", allowRelative: false }));
      const state = await store.load();
      const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
      if (!workspace) {
        throw new Error("Unknown workspaceId");
      }

      if (workspace.workspaceType !== "local") {
        throw new Error("Workspace export is only supported for local workspaces");
      }

      const workspaceRoot = workspace.path;
      const { entries, excluded } = await collectWorkspaceEntries(workspaceRoot);
      if (entries.length === 0) {
        throw new Error("No workspace config files found to export");
      }

      await mkdir(path.dirname(outputPath), { recursive: true });
      const zip = new AdmZip();
      const includedPaths: string[] = [];

      for (const entry of entries) {
        zip.addLocalFile(entry.absolutePath, path.posix.dirname(entry.relativePath), path.posix.basename(entry.relativePath));
        includedPaths.push(entry.relativePath);
      }

      zip.addFile(
        "manifest.json",
        Buffer.from(
          JSON.stringify(
            {
              version: 1,
              createdAtMs: Date.now(),
              workspace: {
                id: workspace.id,
                name: workspace.name,
                path: workspace.path,
              },
              included: includedPaths,
              excluded,
            },
            null,
            2,
          ),
        ),
      );
      zip.writeZip(outputPath);

      return {
        outputPath,
        included: includedPaths.length,
        excluded,
      };
    },

    async importConfig(input: {
      archivePath: string;
      targetDir: string;
      name?: string | null;
    }): Promise<WorkspaceList> {
      const archivePath = path.resolve(validatePathInput(input.archivePath, { label: "archivePath", allowRelative: false }));
      const targetDir = path.resolve(validatePathInput(input.targetDir, { label: "targetDir", allowRelative: false }));
      const targetExists = existsSync(targetDir);
      if (targetExists) {
        const children = await readdir(targetDir);
        if (children.length > 0) {
          throw new Error("Target folder must be empty");
        }
      }

      await mkdir(targetDir, { recursive: true });

      const zip = new AdmZip(archivePath);
      for (const entry of zip.getEntries()) {
        const entryName = entry.entryName.replace(/\\/g, "/");
        if (entryName === "manifest.json") {
          continue;
        }
        if (!isSafeArchivePath(entryName)) {
          throw new Error("Archive contains an unsafe path");
        }
        if (!(entryName === "opencode.json" || entryName.startsWith(".opencode/"))) {
          continue;
        }

        const baseName = path.posix.basename(entryName);
        if (isSecretName(baseName)) {
          continue;
        }

        const outputPath = path.join(targetDir, entryName);
        if (entry.isDirectory) {
          await mkdir(outputPath, { recursive: true });
          continue;
        }

        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, entry.getData());
      }

      const opencodeDir = path.join(targetDir, ".opencode");
      if (!existsSync(opencodeDir)) {
        throw new Error("Archive is missing .opencode config");
      }

      const openworkPath = resolveOpenworkConfigPath(targetDir);
      let preset = "starter";
      let workspaceName = normalizeOptionalText(input.name);

      if (existsSync(openworkPath)) {
        const raw = await readFile(openworkPath, "utf8");
        const config = JSON.parse(raw) as WorkspaceOpenworkConfig;
        config.authorizedRoots = [targetDir];
        if (!workspaceName && config.workspace?.name?.trim()) {
          workspaceName = config.workspace.name.trim();
        }
        if (config.workspace?.preset?.trim()) {
          preset = config.workspace.preset.trim();
        }
        await writeFile(openworkPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      } else {
        await mkdir(path.dirname(openworkPath), { recursive: true });
        await writeFile(openworkPath, `${JSON.stringify({
          version: 1,
          workspace: {
            name: path.basename(targetDir) || "Workspace",
            createdAt: Date.now(),
            preset,
          },
          authorizedRoots: [targetDir],
          reload: null,
        } satisfies WorkspaceOpenworkConfig, null, 2)}\n`, "utf8");
      }

      const name = (workspaceName ?? path.basename(targetDir) ?? "Workspace").trim();
      const id = stableWorkspaceId(targetDir);
      const state = await store.load();
      const pathKey = normalizeWorkspacePathKey(targetDir);
      state.workspaces = state.workspaces.filter(
        (workspace) => normalizeWorkspacePathKey(workspace.path) !== pathKey,
      );
      state.workspaces.push({
        id,
        name,
        path: targetDir,
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
      });
      state.activeId = id;
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
  ipcMain.handle(
    IPC_CHANNELS.workspace("addAuthorizedRoot"),
    (_event, input: Parameters<WorkspaceService["addAuthorizedRoot"]>[0]) => service.addAuthorizedRoot(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.workspace("exportConfig"),
    (_event, input: Parameters<WorkspaceService["exportConfig"]>[0]) => service.exportConfig(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.workspace("importConfig"),
    (_event, input: Parameters<WorkspaceService["importConfig"]>[0]) => service.importConfig(input),
  );
}
