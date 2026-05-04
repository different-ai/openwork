import { HTTPException } from "hono/http-exception";
import { requestRemoteOpenwork } from "../adapters/remote-openwork.js";
import { createRemoteWorkspaceId, createServerId } from "../database/identifiers.js";
import type { ServerRepositories } from "../database/repositories.js";
import type { HostingKind, JsonObject, ServerRecord, WorkspaceRecord } from "../database/types.js";

type RemoteWorkspaceSnapshot = {
  directory: string | null;
  displayName: string;
  remoteWorkspaceId: string;
};

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("baseUrl is required.");
  }
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withProtocol);
  return url.toString().replace(/\/+$/, "");
}

function stripWorkspaceMount(value: string) {
  const url = new URL(normalizeUrl(value));
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  const prev = segments[segments.length - 2] ?? "";
  if (prev === "w" && last) {
    url.pathname = `/${segments.slice(0, -2).join("/")}`;
  }
  return url.toString().replace(/\/+$/, "");
}

function detectRemoteHostingKind(value: string): HostingKind {
  const hostname = new URL(value).hostname.toLowerCase();
  if (
    hostname === "app.openworklabs.com"
    || hostname === "app.openwork.software"
    || hostname.endsWith(".openworklabs.com")
    || hostname.endsWith(".openwork.software")
  ) {
    return "cloud";
  }
  return "self_hosted";
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizeRemoteWorkspaceItems(payload: unknown): RemoteWorkspaceSnapshot[] {
  const record = asObject(payload);
  const items = Array.isArray(record.items) ? record.items : [];
  return items.flatMap((entry) => {
    const item = asObject(entry);
    const backend = asObject(item.backend);
    const local = asObject(backend.local);
    const remote = asObject(backend.remote);
    const remoteWorkspaceId = pickString(item, ["id"]);
    if (!remoteWorkspaceId) {
      return [];
    }
    const displayName = pickString(item, ["displayName", "name"]) ?? remoteWorkspaceId;
    const directory = pickString(local, ["dataDir", "directory"])
      ?? pickString(remote, ["directory"])
      ?? pickString(item, ["path", "directory"]);
    return [{
      directory,
      displayName,
      remoteWorkspaceId,
    } satisfies RemoteWorkspaceSnapshot];
  });
}

export type RemoteServerService = ReturnType<typeof createRemoteServerService>;

export function createRemoteServerService(input: {
  repositories: ServerRepositories;
}) {
  function buildServerRecord(payload: {
    baseUrl: string;
    hostToken?: string | null;
    label?: string | null;
    token?: string | null;
  }) {
    const baseUrl = stripWorkspaceMount(payload.baseUrl);
    const serverId = createServerId("remote", baseUrl);
    const existing = input.repositories.servers.getById(serverId);
    const auth: JsonObject = {
      ...(existing?.auth ?? {}),
      ...(payload.token?.trim() ? { openworkToken: payload.token.trim(), openworkClientToken: payload.token.trim() } : {}),
      ...(payload.hostToken?.trim() ? { openworkHostToken: payload.hostToken.trim() } : {}),
    };
    const label = payload.label?.trim() || existing?.label || new URL(baseUrl).host;
    const server = input.repositories.servers.upsert({
      auth: Object.keys(auth).length > 0 ? auth : existing?.auth ?? null,
      baseUrl,
      capabilities: {
        ...(existing?.capabilities ?? {}),
        phase: 9,
        remoteWorkspaceDiscovery: true,
        remoteWorkspaceRouting: true,
      },
      hostingKind: existing?.hostingKind ?? detectRemoteHostingKind(baseUrl),
      id: serverId,
      isEnabled: true,
      isLocal: false,
      kind: "remote",
      label,
      lastSeenAt: new Date().toISOString(),
      notes: {
        ...(existing?.notes ?? {}),
        connectedVia: "server-v2-phase9",
      },
      source: existing?.source ?? "connected",
    });
    return server;
  }

  async function fetchRemoteWorkspaces(server: ServerRecord) {
    const response = await requestRemoteOpenwork<unknown>({
      path: "/workspaces",
      server,
      timeoutMs: 10_000,
    });
    return normalizeRemoteWorkspaceItems(response);
  }

  function updateWorkspaceRuntime(workspace: WorkspaceRecord, details: Record<string, unknown>) {
    const current = input.repositories.workspaceRuntimeState.getByWorkspaceId(workspace.id);
    input.repositories.workspaceRuntimeState.upsert({
      backendKind: "remote_openwork",
      health: {
        ...(current?.health ?? {}),
        ...details,
      },
      lastError: null,
      lastSessionRefreshAt: current?.lastSessionRefreshAt ?? null,
      lastSyncAt: new Date().toISOString(),
      workspaceId: workspace.id,
    });
  }

  function markMissingWorkspace(workspace: WorkspaceRecord) {
    input.repositories.workspaces.upsert({
      ...workspace,
      notes: {
        ...(workspace.notes ?? {}),
        sync: {
          missing: true,
          recordedAt: new Date().toISOString(),
        },
      },
      status: "attention",
    });
    const current = input.repositories.workspaceRuntimeState.getByWorkspaceId(workspace.id);
    input.repositories.workspaceRuntimeState.upsert({
      backendKind: "remote_openwork",
      health: current?.health ?? null,
      lastError: {
        code: "not_found",
        message: "Remote workspace was not returned during the latest sync.",
        recordedAt: new Date().toISOString(),
      },
      lastSessionRefreshAt: current?.lastSessionRefreshAt ?? null,
      lastSyncAt: new Date().toISOString(),
      workspaceId: workspace.id,
    });
  }

  function syncRemoteWorkspaceRecords(server: ServerRecord, discovered: RemoteWorkspaceSnapshot[], hints?: { directory?: string | null; workspaceId?: string | null }) {
    const existing = input.repositories.workspaces.listByServerId(server.id, { includeHidden: true }).filter((workspace) => workspace.kind === "remote");
    const seenWorkspaceIds = new Set<string>();
    const synced: WorkspaceRecord[] = [];

    for (const remoteWorkspace of discovered) {
      const workspaceId = createRemoteWorkspaceId({
        baseUrl: server.baseUrl ?? "",
        remoteType: "openwork",
        remoteWorkspaceId: remoteWorkspace.remoteWorkspaceId,
      });
      seenWorkspaceIds.add(workspaceId);
      const previous = input.repositories.workspaces.getById(workspaceId);
      const workspace = input.repositories.workspaces.upsert({
        configDir: null,
        dataDir: null,
        displayName: remoteWorkspace.displayName,
        id: workspaceId,
        isHidden: false,
        kind: "remote",
        notes: {
          ...(previous?.notes ?? {}),
          directory: remoteWorkspace.directory,
          remoteType: "openwork",
          sync: {
            directoryHint: hints?.directory?.trim() || null,
            syncedAt: new Date().toISOString(),
          },
        },
        opencodeProjectId: null,
        remoteWorkspaceId: remoteWorkspace.remoteWorkspaceId,
        serverId: server.id,
        slug: previous?.slug ?? workspaceId,
        status: "ready",
      });
      synced.push(workspace);
      updateWorkspaceRuntime(workspace, {
        remoteServerId: server.id,
        remoteWorkspaceId: remoteWorkspace.remoteWorkspaceId,
      });
    }

    for (const workspace of existing) {
      if (!seenWorkspaceIds.has(workspace.id)) {
        markMissingWorkspace(workspace);
      }
    }

    const requestedWorkspaceId = hints?.workspaceId?.trim();
    const requestedDirectory = hints?.directory?.trim();
    const selected = synced.find((workspace) => workspace.remoteWorkspaceId === requestedWorkspaceId)
      ?? synced.find((workspace) => typeof workspace.notes?.directory === "string" && requestedDirectory && workspace.notes.directory === requestedDirectory)
      ?? synced[0]
      ?? null;

    return {
      selectedWorkspaceId: selected?.id ?? null,
      workspaces: synced,
    };
  }

  return {
    async connect(inputValue: {
      baseUrl: string;
      directory?: string | null;
      hostToken?: string | null;
      label?: string | null;
      token?: string | null;
      workspaceId?: string | null;
    }) {
      const server = buildServerRecord(inputValue);
      const discovered = await fetchRemoteWorkspaces(server);
      if (discovered.length === 0) {
        throw new HTTPException(404, { message: "Remote OpenWork server did not return any visible workspaces." });
      }
      const result = syncRemoteWorkspaceRecords(server, discovered, {
        directory: inputValue.directory,
        workspaceId: inputValue.workspaceId,
      });
      return {
        selectedWorkspaceId: result.selectedWorkspaceId,
        server,
        workspaces: result.workspaces,
      };
    },

    async sync(serverId: string, hints?: { directory?: string | null; workspaceId?: string | null }) {
      const server = input.repositories.servers.getById(serverId);
      if (!server || server.kind !== "remote") {
        throw new HTTPException(404, { message: `Remote server not found: ${serverId}` });
      }
      const discovered = await fetchRemoteWorkspaces(server);
      const result = syncRemoteWorkspaceRecords(server, discovered, hints);
      input.repositories.servers.upsert({
        ...server,
        lastSeenAt: new Date().toISOString(),
      });
      return {
        selectedWorkspaceId: result.selectedWorkspaceId,
        server: input.repositories.servers.getById(server.id)!,
        workspaces: result.workspaces,
      };
    },
  };
}
