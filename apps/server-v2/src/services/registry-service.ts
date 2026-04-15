import path from "node:path";
import {
  createInternalWorkspaceId,
  createLocalWorkspaceId,
  createRemoteWorkspaceId,
  createServerId,
  deriveWorkspaceSlugSource,
} from "../database/identifiers.js";
import type { ServerRepositories } from "../database/repositories.js";
import { ensureWorkspaceConfigDir, type ServerWorkingDirectory } from "../database/working-directory.js";
import type {
  BackendKind,
  HostingKind,
  JsonObject,
  ServerRecord,
  WorkspaceKind,
  WorkspaceRecord,
} from "../database/types.js";

export type LegacyRemoteWorkspaceInput = {
  baseUrl: string;
  displayName: string;
  directory?: string | null;
  legacyNotes: JsonObject;
  remoteType: "openwork" | "opencode";
  remoteWorkspaceId?: string | null;
  serverAuth?: JsonObject | null;
  serverBaseUrl: string;
  serverHostingKind: HostingKind;
  serverLabel: string;
  workspaceStatus?: WorkspaceRecord["status"];
};

export type LegacyLocalWorkspaceInput = {
  dataDir: string;
  displayName: string;
  kind?: Extract<WorkspaceKind, "control" | "help" | "local">;
  legacyNotes?: JsonObject | null;
  opencodeProjectId?: string | null;
  status?: WorkspaceRecord["status"];
};

type EnsureLocalServerInput = {
  baseUrl?: string | null;
  capabilities?: JsonObject;
  hostingKind: HostingKind;
  label: string;
  notes?: JsonObject | null;
};

function mergeJson(base: JsonObject | null | undefined, next: JsonObject | null | undefined) {
  if (!base && !next) {
    return null;
  }

  return {
    ...(base ?? {}),
    ...(next ?? {}),
  };
}

function resolveSlug(repositories: ServerRepositories, workspaceId: string, baseSlug: string) {
  let suffix = 1;
  let candidate = baseSlug;
  while (repositories.workspaces.findSlugConflict(candidate, workspaceId)) {
    suffix += 1;
    candidate = `${baseSlug}-${suffix}`;
  }
  return candidate;
}

export function createRegistryService(input: {
  localServerCapabilities: JsonObject;
  repositories: ServerRepositories;
  workingDirectory: ServerWorkingDirectory;
}) {
  const localServerId = createServerId("local", "primary");
  const { repositories } = input;

  function upsertWorkspace(inputWorkspace: Omit<WorkspaceRecord, "createdAt" | "updatedAt" | "slug">) {
    const slugBase = deriveWorkspaceSlugSource({
      dataDir: inputWorkspace.dataDir,
      displayName: inputWorkspace.displayName,
      fallback: inputWorkspace.kind,
    });
    const slug = resolveSlug(repositories, inputWorkspace.id, slugBase);
    return repositories.workspaces.upsert({
      ...inputWorkspace,
      slug,
    });
  }

  return {
    attachLocalServerBaseUrl(baseUrl: string) {
      const existing = input.repositories.servers.getById(localServerId);
      if (!existing) {
        return this.ensureLocalServer({
          baseUrl,
          hostingKind: "self_hosted",
          label: "Local OpenWork Server",
        });
      }

      return input.repositories.servers.upsert({
        ...existing,
        baseUrl,
        capabilities: existing.capabilities,
      });
    },

    ensureLocalServer(server: EnsureLocalServerInput): { created: boolean; server: ServerRecord } {
      const existing = input.repositories.servers.getById(localServerId);
      const next = input.repositories.servers.upsert({
        auth: existing?.auth ?? null,
        baseUrl: server.baseUrl ?? existing?.baseUrl ?? null,
        capabilities: {
          ...input.localServerCapabilities,
          ...(existing?.capabilities ?? {}),
          ...(server.capabilities ?? {}),
        },
        hostingKind: server.hostingKind,
        id: localServerId,
        isEnabled: true,
        isLocal: true,
        kind: "local",
        label: server.label,
        lastSeenAt: new Date().toISOString(),
        notes: mergeJson(existing?.notes, server.notes),
        source: existing?.source ?? "seeded",
      });

      return {
        created: !existing,
        server: next,
      };
    },

    ensureHiddenWorkspace(kind: "control" | "help") {
      const workspaceId = createInternalWorkspaceId(kind);
      const displayName = kind === "control" ? "Control Workspace" : "Help Workspace";
      const workspace = upsertWorkspace({
        configDir: ensureWorkspaceConfigDir(input.workingDirectory, workspaceId),
        dataDir: null,
        displayName,
        id: workspaceId,
        isHidden: true,
        kind,
        notes: {
          internal: true,
          seededBy: "server-v2-phase-2",
        },
        opencodeProjectId: null,
        remoteWorkspaceId: null,
        serverId: localServerId,
        status: "ready",
      });

      const backendKind: BackendKind = "local_opencode";
      input.repositories.workspaceRuntimeState.upsert({
        backendKind,
        health: {
          hidden: true,
          internalWorkspace: kind,
        },
        lastError: null,
        lastSessionRefreshAt: null,
        lastSyncAt: null,
        workspaceId: workspace.id,
      });

      return workspace;
    },

    importLocalWorkspace(workspace: LegacyLocalWorkspaceInput) {
      const workspaceKind = workspace.kind ?? "local";
      const workspaceId = workspaceKind === "local" ? createLocalWorkspaceId(workspace.dataDir) : createInternalWorkspaceId(workspaceKind);
      const configDir = ensureWorkspaceConfigDir(input.workingDirectory, workspaceId);
      const record = upsertWorkspace({
        configDir,
        dataDir: workspace.dataDir,
        displayName: workspace.displayName || path.basename(workspace.dataDir),
        id: workspaceId,
        isHidden: workspaceKind !== "local",
        kind: workspaceKind,
        notes: mergeJson(workspace.legacyNotes ?? null, {
          importSource: "desktop_or_orchestrator",
          workspaceKind,
        }),
        opencodeProjectId: workspace.opencodeProjectId ?? null,
        remoteWorkspaceId: null,
        serverId: localServerId,
        status: workspace.status ?? "imported",
      });

      input.repositories.workspaceRuntimeState.upsert({
        backendKind: "local_opencode",
        health: {
          configDir,
          imported: true,
        },
        lastError: null,
        lastSessionRefreshAt: null,
        lastSyncAt: null,
        workspaceId: record.id,
      });

      return record;
    },

    importRemoteWorkspace(workspace: LegacyRemoteWorkspaceInput) {
      const serverId = createServerId("remote", workspace.serverBaseUrl);
      const existingServer = input.repositories.servers.getById(serverId);
      input.repositories.servers.upsert({
        auth: workspace.serverAuth ?? existingServer?.auth ?? null,
        baseUrl: workspace.serverBaseUrl,
        capabilities: mergeJson(existingServer?.capabilities ?? {}, {
          legacyRemoteType: workspace.remoteType,
          phase: 2,
          source: "desktop-import",
        }) ?? {},
        hostingKind: workspace.serverHostingKind,
        id: serverId,
        isEnabled: true,
        isLocal: false,
        kind: "remote",
        label: workspace.serverLabel,
        lastSeenAt: existingServer?.lastSeenAt ?? null,
        notes: mergeJson(existingServer?.notes, workspace.legacyNotes),
        source: existingServer?.source ?? "imported",
      });

      const workspaceId = createRemoteWorkspaceId({
        baseUrl: workspace.serverBaseUrl,
        directory: workspace.directory,
        remoteType: workspace.remoteType,
        remoteWorkspaceId: workspace.remoteWorkspaceId,
      });
      const record = upsertWorkspace({
        configDir: null,
        dataDir: null,
        displayName: workspace.displayName,
        id: workspaceId,
        isHidden: false,
        kind: "remote",
        notes: mergeJson(workspace.legacyNotes, {
          directory: workspace.directory ?? null,
          remoteType: workspace.remoteType,
        }),
        opencodeProjectId: null,
        remoteWorkspaceId: workspace.remoteWorkspaceId ?? null,
        serverId,
        status: workspace.workspaceStatus ?? "imported",
      });

      input.repositories.workspaceRuntimeState.upsert({
        backendKind: "remote_openwork",
        health: {
          imported: true,
          remoteServerId: serverId,
        },
        lastError: null,
        lastSessionRefreshAt: null,
        lastSyncAt: null,
        workspaceId: record.id,
      });

      return record;
    },

    listServers() {
      return input.repositories.servers.list();
    },

    listWorkspaces(includeHidden = false) {
      return input.repositories.workspaces.list({ includeHidden });
    },

    localServerId,
  };
}

type RegistryService = ReturnType<typeof createRegistryService>;
export type { RegistryService };
