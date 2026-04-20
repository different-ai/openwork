import type { ServerRegistryService } from "./server-registry-service.js";
import type { ServerRepositories } from "../database/repositories.js";
import type {
  BackendKind,
  JsonObject,
  WorkspaceKind,
  WorkspaceRecord,
  WorkspaceRuntimeStateRecord,
} from "../database/types.js";

type WorkspacePreset = "minimal" | "remote" | "starter";

export type WorkspaceBackend = {
  kind: BackendKind;
  local: null | {
    configDir: string | null;
    dataDir: string | null;
    opencodeProjectId: string | null;
  };
  remote: null | {
    directory: string | null;
    hostUrl: string | null;
    remoteType: "openwork" | "opencode";
    remoteWorkspaceId: string | null;
    workspaceName: string | null;
  };
  serverId: string;
};

export type WorkspaceRuntimeSummary = {
  backendKind: BackendKind;
  health: JsonObject | null;
  lastError: JsonObject | null;
  lastSessionRefreshAt: string | null;
  lastSyncAt: string | null;
  updatedAt: string | null;
};

export type WorkspaceSummary = {
  backend: WorkspaceBackend;
  createdAt: string;
  displayName: string;
  hidden: boolean;
  id: string;
  kind: WorkspaceKind;
  preset: WorkspacePreset;
  runtime: WorkspaceRuntimeSummary;
  server: ReturnType<ServerRegistryService["serialize"]>;
  slug: string;
  status: WorkspaceRecord["status"];
  updatedAt: string;
};

export type WorkspaceDetail = WorkspaceSummary & {
  notes: JsonObject | null;
};

export type WorkspaceRegistryService = ReturnType<typeof createWorkspaceRegistryService>;

function asJsonObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as JsonObject;
}

function readPreset(workspace: WorkspaceRecord): WorkspacePreset {
  const legacyDesktop = asJsonObject(workspace.notes?.legacyDesktop);
  const preset = typeof legacyDesktop?.preset === "string" ? legacyDesktop.preset.trim().toLowerCase() : "";
  if (preset === "minimal" || preset === "starter") {
    return preset;
  }

  return workspace.kind === "remote" ? "remote" : "starter";
}

function readRemoteDirectory(workspace: WorkspaceRecord) {
  const value = workspace.notes?.directory;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRemoteType(workspace: WorkspaceRecord): "openwork" | "opencode" {
  const explicit = workspace.notes?.remoteType;
  return explicit === "opencode" ? "opencode" : "openwork";
}

function readRemoteWorkspaceName(workspace: WorkspaceRecord) {
  const legacyDesktop = asJsonObject(workspace.notes?.legacyDesktop);
  const value = legacyDesktop?.openworkWorkspaceName;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function serializeRuntimeState(runtimeState: WorkspaceRuntimeStateRecord | null, backendKind: BackendKind): WorkspaceRuntimeSummary {
  return {
    backendKind,
    health: runtimeState?.health ?? null,
    lastError: runtimeState?.lastError ?? null,
    lastSessionRefreshAt: runtimeState?.lastSessionRefreshAt ?? null,
    lastSyncAt: runtimeState?.lastSyncAt ?? null,
    updatedAt: runtimeState?.updatedAt ?? null,
  };
}

export function createWorkspaceRegistryService(input: {
  repositories: ServerRepositories;
  servers: ServerRegistryService;
}) {
  const { repositories } = input;

  function resolveBackend(workspace: WorkspaceRecord): WorkspaceBackend {
    const runtimeState = repositories.workspaceRuntimeState.getByWorkspaceId(workspace.id);
    const backendKind = runtimeState?.backendKind ?? (workspace.kind === "remote" ? "remote_openwork" : "local_opencode");

    if (backendKind === "remote_openwork") {
      const server = input.servers.getById(workspace.serverId);
      return {
        kind: backendKind,
        local: null,
        remote: {
          directory: readRemoteDirectory(workspace),
          hostUrl: server?.baseUrl ?? null,
          remoteType: readRemoteType(workspace),
          remoteWorkspaceId: workspace.remoteWorkspaceId,
          workspaceName: readRemoteWorkspaceName(workspace),
        },
        serverId: workspace.serverId,
      };
    }

    return {
      kind: "local_opencode",
      local: {
        configDir: workspace.configDir,
        dataDir: workspace.dataDir,
        opencodeProjectId: workspace.opencodeProjectId,
      },
      remote: null,
      serverId: workspace.serverId,
    };
  }

  function serializeWorkspace(workspace: WorkspaceRecord) {
    const server = input.servers.getById(workspace.serverId);
    if (!server) {
      throw new Error(`Workspace ${workspace.id} points at missing server ${workspace.serverId}.`);
    }

    const backend = resolveBackend(workspace);
    const runtimeState = repositories.workspaceRuntimeState.getByWorkspaceId(workspace.id);
    return {
      backend,
      createdAt: workspace.createdAt,
      displayName: workspace.displayName,
      hidden: workspace.isHidden,
      id: workspace.id,
      kind: workspace.kind,
      notes: workspace.notes,
      preset: readPreset(workspace),
      runtime: serializeRuntimeState(runtimeState, backend.kind),
      server: input.servers.serialize(server, { includeBaseUrl: false }),
      slug: workspace.slug,
      status: workspace.status,
      updatedAt: workspace.updatedAt,
    } satisfies WorkspaceDetail;
  }

  function canReadWorkspace(workspace: WorkspaceRecord, options?: { includeHidden?: boolean }) {
    return options?.includeHidden === true || !workspace.isHidden;
  }

  return {
    getById(workspaceId: string, options?: { includeHidden?: boolean }) {
      const workspace = repositories.workspaces.getById(workspaceId);
      if (!workspace || !canReadWorkspace(workspace, options)) {
        return null;
      }
      return serializeWorkspace(workspace);
    },

    list(options?: { includeHidden?: boolean }) {
      return repositories.workspaces
        .list({ includeHidden: options?.includeHidden ?? false })
        .filter((workspace) => canReadWorkspace(workspace, options))
        .map((workspace) => serializeWorkspace(workspace));
    },

    resolveBackend,
    serializeWorkspace,
  };
}
