import type { ServerRepositories } from "../database/repositories.js";
import type { JsonObject, ServerRecord } from "../database/types.js";

export type ServerRegistrySummary = {
  hiddenWorkspaceCount: number;
  localServerId: string;
  remoteServerCount: number;
  totalServers: number;
  visibleWorkspaceCount: number;
};

export type ServerInventoryItem = {
  auth: {
    configured: boolean;
    scheme: "bearer" | "none";
  };
  baseUrl: string | null;
  capabilities: JsonObject;
  hostingKind: ServerRecord["hostingKind"];
  id: string;
  isEnabled: boolean;
  isLocal: boolean;
  kind: ServerRecord["kind"];
  label: string;
  lastSeenAt: string | null;
  source: string;
  updatedAt: string;
};

export type ServerRegistryService = ReturnType<typeof createServerRegistryService>;

function hasServerAuth(record: ServerRecord) {
  if (!record.auth) {
    return false;
  }

  return Object.values(record.auth).some((value) => typeof value === "string" && value.trim().length > 0);
}

export function createServerRegistryService(input: {
  localServerId: string;
  repositories: ServerRepositories;
}) {
  const { repositories } = input;

  function serialize(record: ServerRecord, options?: { includeBaseUrl?: boolean }) {
    return {
      auth: {
        configured: hasServerAuth(record),
        scheme: hasServerAuth(record) ? "bearer" : "none",
      },
      baseUrl: options?.includeBaseUrl === false ? null : record.baseUrl,
      capabilities: record.capabilities,
      hostingKind: record.hostingKind,
      id: record.id,
      isEnabled: record.isEnabled,
      isLocal: record.isLocal,
      kind: record.kind,
      label: record.label,
      lastSeenAt: record.lastSeenAt,
      source: record.source,
      updatedAt: record.updatedAt,
    } satisfies ServerInventoryItem;
  }

  return {
    getById(serverId: string) {
      return repositories.servers.getById(serverId);
    },

    list(options?: { includeBaseUrl?: boolean }) {
      return repositories.servers.list().map((record) => serialize(record, options));
    },

    serialize,

    summarize(): ServerRegistrySummary {
      const servers = repositories.servers.list();
      const allWorkspaces = repositories.workspaces.list({ includeHidden: true });
      const hiddenWorkspaceCount = allWorkspaces.filter((workspace) => workspace.isHidden).length;
      return {
        hiddenWorkspaceCount,
        localServerId: input.localServerId,
        remoteServerCount: servers.filter((server) => server.kind === "remote").length,
        totalServers: servers.length,
        visibleWorkspaceCount: allWorkspaces.length - hiddenWorkspaceCount,
      };
    },
  };
}
