import type {
  OpenWorkServerV2SystemStatusResponse,
  OpenWorkServerV2WorkspaceDetailData,
  OpenWorkServerV2WorkspaceListResponse,
  OpenWorkServerV2WorkspaceSummaryData,
} from "@openwork/server-sdk";
import type {
  OpenworkServerCapabilities,
  OpenworkRuntimeSnapshot,
  OpenworkServerDiagnostics,
} from "../../lib/openwork-server";
import type { WorkspaceInfo, WorkspaceList } from "../../lib/tauri";
import { resolveWorkspaceListSelectedId } from "../../lib/tauri";
import type { ServerTarget } from "./types";

function parseServerLocation(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const port = Number.parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10);
    return {
      host: url.hostname,
      port: Number.isFinite(port) ? port : 0,
    };
  } catch {
    return {
      host: baseUrl,
      port: 0,
    };
  }
}

function normalizeSelectedId(items: WorkspaceInfo[], candidate?: string | null) {
  const id = candidate?.trim() ?? "";
  if (id && items.some((workspace) => workspace.id === id)) {
    return id;
  }
  return items[0]?.id ?? "";
}

function buildLegacyWorkspaceIndex(list: WorkspaceList | null | undefined) {
  return new Map((list?.workspaces ?? []).map((workspace) => [workspace.id, workspace] as const));
}

function normalizeWorkspaceFromServerV2(
  item: OpenWorkServerV2WorkspaceSummaryData | OpenWorkServerV2WorkspaceDetailData,
  legacyWorkspace: WorkspaceInfo | null | undefined,
): WorkspaceInfo {
  if (item.backend.kind === "remote_openwork") {
    return {
      id: item.id,
      name: item.displayName,
      path: "",
      preset: "remote",
      workspaceType: "remote",
      remoteType: item.backend.remote?.remoteType ?? legacyWorkspace?.remoteType ?? "openwork",
      baseUrl: legacyWorkspace?.baseUrl ?? null,
      directory: item.backend.remote?.directory ?? legacyWorkspace?.directory ?? null,
      displayName: item.displayName,
      openworkHostUrl: item.backend.remote?.hostUrl ?? legacyWorkspace?.openworkHostUrl ?? legacyWorkspace?.baseUrl ?? null,
      openworkToken: legacyWorkspace?.openworkToken ?? null,
      openworkClientToken: legacyWorkspace?.openworkClientToken ?? null,
      openworkHostToken: legacyWorkspace?.openworkHostToken ?? null,
      openworkWorkspaceId: item.backend.remote?.remoteWorkspaceId ?? legacyWorkspace?.openworkWorkspaceId ?? null,
      openworkWorkspaceName: item.backend.remote?.workspaceName ?? legacyWorkspace?.openworkWorkspaceName ?? null,
      sandboxBackend: legacyWorkspace?.sandboxBackend ?? null,
      sandboxRunId: legacyWorkspace?.sandboxRunId ?? null,
      sandboxContainerName: legacyWorkspace?.sandboxContainerName ?? null,
    } satisfies WorkspaceInfo;
  }

  return {
    id: item.id,
    name: item.displayName,
    path: item.backend.local?.dataDir ?? legacyWorkspace?.path ?? "",
    preset: item.preset,
    workspaceType: "local",
    displayName: item.displayName,
    remoteType: null,
    baseUrl: null,
    directory: null,
    openworkHostUrl: null,
    openworkToken: null,
    openworkClientToken: null,
    openworkHostToken: null,
    openworkWorkspaceId: null,
    openworkWorkspaceName: null,
    sandboxBackend: null,
    sandboxRunId: null,
    sandboxContainerName: null,
  } satisfies WorkspaceInfo;
}

export function normalizeLegacyDiagnostics(input: {
  diagnostics: OpenworkServerDiagnostics;
}) {
  return input.diagnostics;
}

export function buildSyntheticDiagnostics(input: {
  capabilities?: OpenworkServerCapabilities | null;
  target: ServerTarget;
  uptimeMs?: number | null;
  version?: string | null;
}): OpenworkServerDiagnostics {
  const server = parseServerLocation(input.target.baseUrl);
  return {
    ok: true,
    version: input.version ?? "",
    uptimeMs: input.uptimeMs ?? 0,
    readOnly: false,
    approval: { mode: "manual", timeoutMs: 0 },
    corsOrigins: [],
    workspaceCount: 0,
    activeWorkspaceId: null,
    selectedWorkspaceId: null,
    workspace: null,
    authorizedRoots: [],
    server: {
      host: server.host,
      port: server.port,
      configPath: null,
    },
    tokenSource: {
      client: input.target.token ? "app-target" : "none",
      host: input.target.hostToken ? "app-target" : "none",
    },
  } satisfies OpenworkServerDiagnostics;
}

export function normalizeServerV2Capabilities(input: OpenWorkServerV2SystemStatusResponse): OpenworkServerCapabilities {
  const auth = input.data.auth;
  const bundles = input.data.capabilities.bundles ?? {
    fetch: false,
    publish: false,
    workspaceExport: false,
    workspaceImport: false,
  };
  const cloud = input.data.capabilities.cloud ?? {
    persistence: false,
    validation: false,
  };
  const sessions = input.data.capabilities.sessions ?? {
    events: false,
    list: false,
    messages: false,
    mutations: false,
    promptAsync: false,
    revertHistory: false,
  };
  const shares = input.data.capabilities.shares ?? {
    workspaceScoped: false,
  };
  return {
    bundles: {
      fetch: bundles.fetch,
      publish: bundles.publish,
      workspaceExport: bundles.workspaceExport,
      workspaceImport: bundles.workspaceImport,
    },
    cloud: {
      persistence: cloud.persistence,
      validation: cloud.validation,
    },
    commands: { read: false, write: false },
    config: {
      read: input.data.capabilities.config.read,
      write: input.data.capabilities.config.write,
    },
    mcp: {
      read: input.data.capabilities.managed?.mcps === true,
      write: input.data.capabilities.managed?.mcps === true,
    },
    plugins: {
      read: input.data.capabilities.managed?.plugins === true,
      write: input.data.capabilities.managed?.plugins === true,
    },
    shares: {
      workspaceScoped: shares.workspaceScoped,
    },
    serverV2: {
      auth: {
        actorKind: auth.actorKind,
        hostTokenConfigured: auth.configured.hostToken,
        required: auth.required,
      },
      bundles: {
        fetch: bundles.fetch,
        publish: bundles.publish,
        workspaceExport: bundles.workspaceExport,
        workspaceImport: bundles.workspaceImport,
      },
      cloud: {
        persistence: cloud.persistence,
        validation: cloud.validation,
      },
      config: {
        projection: input.data.capabilities.config.projection,
        rawRead: input.data.capabilities.config.rawRead,
        rawWrite: input.data.capabilities.config.rawWrite,
        read: input.data.capabilities.config.read,
        write: input.data.capabilities.config.write,
      },
      files: {
        artifacts: input.data.capabilities.files.artifacts,
        contentRoutes: input.data.capabilities.files.contentRoutes,
        fileSessions: input.data.capabilities.files.fileSessions,
        inbox: input.data.capabilities.files.inbox,
        mutations: input.data.capabilities.files.mutations,
      },
      reload: {
        manualEngineReload: input.data.capabilities.reload.manualEngineReload,
        reconciliation: input.data.capabilities.reload.reconciliation,
        watch: input.data.capabilities.reload.watch,
        workspaceEvents: input.data.capabilities.reload.workspaceEvents,
      },
      registry: {
        backendResolution: input.data.capabilities.registry.backendResolution,
        hiddenWorkspaceFiltering: input.data.capabilities.registry.hiddenWorkspaceFiltering,
        remoteServerConnections: input.data.capabilities.registry.remoteServerConnections,
        remoteWorkspaceSync: input.data.capabilities.registry.remoteWorkspaceSync,
        serverInventory: input.data.capabilities.registry.serverInventory,
        workspaceDetail: input.data.capabilities.registry.workspaceDetail,
        workspaceList: input.data.capabilities.registry.workspaceList,
      },
      runtime: {
        opencodeHealth: input.data.capabilities.runtime.opencodeHealth,
        routerHealth: input.data.capabilities.runtime.routerHealth,
        runtimeSummary: input.data.capabilities.runtime.runtimeSummary,
        runtimeUpgrade: input.data.capabilities.runtime.runtimeUpgrade,
        runtimeVersions: input.data.capabilities.runtime.runtimeVersions,
      },
      sessions: {
        events: sessions.events,
        list: sessions.list,
        messages: sessions.messages,
        mutations: sessions.mutations,
        promptAsync: sessions.promptAsync,
        revertHistory: sessions.revertHistory,
      },
      shares: {
        workspaceScoped: shares.workspaceScoped,
      },
      transport: {
        rootMounted: input.data.capabilities.transport.rootMounted,
        v2: input.data.capabilities.transport.v2,
      },
      workspaces: {
        activate: input.data.capabilities.workspaces.activate,
        createLocal: input.data.capabilities.workspaces.createLocal,
      },
    },
    skills: {
      read: input.data.capabilities.managed?.skills === true,
      source: "openwork",
      write: input.data.capabilities.managed?.skills === true,
    },
    toolProviders: {
      files: {
        inboxPath: ".opencode/openwork/inbox/",
        injection: input.data.capabilities.files.inbox,
        maxBytes: 5_000_000,
        outbox: input.data.capabilities.files.artifacts,
        outboxPath: ".opencode/openwork/outbox/",
      },
    },
  } satisfies OpenworkServerCapabilities;
}

export function normalizeServerV2Diagnostics(input: {
  status: OpenWorkServerV2SystemStatusResponse;
  target: ServerTarget;
}): OpenworkServerDiagnostics {
  const server = parseServerLocation(input.target.baseUrl);
  return {
    ok: input.status.data.status === "ok",
    version: input.status.data.version,
    uptimeMs: input.status.data.uptimeMs,
    readOnly: false,
    approval: { mode: "manual", timeoutMs: 0 },
    corsOrigins: [],
    workspaceCount: input.status.data.registry.visibleWorkspaceCount,
    activeWorkspaceId: null,
    selectedWorkspaceId: null,
    workspace: null,
    authorizedRoots: [],
    server: {
      host: server.host,
      port: server.port,
      configPath: null,
    },
    tokenSource: {
      client: input.target.token ? "app-target" : "none",
      host: input.target.hostToken ? "app-target" : "none",
    },
  } satisfies OpenworkServerDiagnostics;
}

export function normalizeServerV2WorkspaceList(input: {
  legacyWorkspaceList?: WorkspaceList | null;
  response: OpenWorkServerV2WorkspaceListResponse;
}): WorkspaceList {
  const legacyWorkspaceIndex = buildLegacyWorkspaceIndex(input.legacyWorkspaceList);
  const workspaces = input.response.data.items.map((item) => normalizeWorkspaceFromServerV2(item, legacyWorkspaceIndex.get(item.id)));
  const legacySelectedId = resolveWorkspaceListSelectedId(input.legacyWorkspaceList);
  const selectedId = normalizeSelectedId(workspaces, legacySelectedId);
  const watchedId = normalizeSelectedId(workspaces, input.legacyWorkspaceList?.watchedId ?? selectedId);

  return {
    activeId: selectedId,
    selectedId,
    watchedId,
    workspaces,
  } satisfies WorkspaceList;
}

export function normalizeServerV2WorkspaceDetail(input: {
  legacyWorkspaceList?: WorkspaceList | null;
  response: { data: OpenWorkServerV2WorkspaceDetailData };
}): WorkspaceInfo {
  const legacyWorkspaceIndex = buildLegacyWorkspaceIndex(input.legacyWorkspaceList);
  return normalizeWorkspaceFromServerV2(input.response.data, legacyWorkspaceIndex.get(input.response.data.id));
}

export function summarizeLegacyRuntime(input: OpenworkRuntimeSnapshot | null | undefined) {
  const services = Array.isArray(input?.services) ? input.services : [];
  return {
    opencodeVersion: services.find((entry) => entry.name === "opencode")?.actualVersion ?? null,
    routerVersion: services.find((entry) => entry.name === "opencode-router")?.actualVersion ?? null,
  };
}

export function summarizeServerV2Runtime(input: {
  status: OpenWorkServerV2SystemStatusResponse;
}) {
  return {
    opencodeBaseUrl: input.status.data.runtime.opencode.baseUrl,
    opencodeStatus: input.status.data.runtime.opencode.status,
    opencodeVersion: input.status.data.runtime.opencode.version,
    routerBaseUrl: input.status.data.runtime.router.baseUrl,
    routerStatus: input.status.data.runtime.router.status,
    routerVersion: input.status.data.runtime.router.version,
    runtimeSource: input.status.data.runtime.source,
    runtimeTarget: input.status.data.runtime.target,
  };
}
