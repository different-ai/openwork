import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  createOpenWorkServerClient,
  getSystemHealth,
  getSystemStatus,
  getWorkspaces,
  getWorkspacesByWorkspaceId,
  type OpenWorkServerV2HealthResponse,
  type OpenWorkServerV2SystemStatusResponse,
  type OpenWorkServerV2WorkspaceDetailResponse,
  type OpenWorkServerV2WorkspaceListResponse,
} from "@openwork/server-sdk";
import { normalizeOpenworkServerUrl } from "../../lib/openwork-server";
import type { OpenworkServerCapabilities } from "../../lib/openwork-server";
import type { OpenworkServerInfo, WorkspaceInfo, WorkspaceList } from "../../lib/tauri";
import { isTauriRuntime } from "../../utils";
import { isServerV2Enabled } from "./flag";
import { createRemoteServerId, LOCAL_SERVER_ID } from "./ids";
import {
  buildSyntheticDiagnostics,
  normalizeLegacyDiagnostics,
  normalizeServerV2Capabilities,
  normalizeServerV2Diagnostics,
  normalizeServerV2WorkspaceDetail,
  normalizeServerV2WorkspaceList,
} from "./normalize";
import { recordServerVersionDecision } from "./observability";
import { resolveServerVersionRoute, shouldFallbackToLegacy } from "./routing";
import type {
  ExplicitServerTargetInput,
  ServerStatusProbe,
  ServerTarget,
  ServerVersionAccessors,
} from "./types";
import {
  fetchLegacyCapabilities,
  fetchLegacySystemHealth,
  fetchLegacySystemStatus,
} from "./legacy/system";

function resolveHostingKind(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const hostname = url.hostname.toLowerCase();
    if (hostname.endsWith(".openwork.cloud")) {
      return "cloud" as const;
    }
  } catch {
    // ignore
  }
  return "self_hosted" as const;
}

function normalizeTargetBaseUrl(baseUrl: string) {
  const normalized = normalizeOpenworkServerUrl(baseUrl);
  if (!normalized) {
    throw new Error("OpenWork server URL is required.");
  }
  return normalized;
}

function getContractHint(info: OpenworkServerInfo | null | undefined) {
  return info?.startupMode === "server-v2"
    ? "server-v2"
    : info?.startupMode === "legacy"
      ? "legacy"
      : "unknown";
}

function buildHeaders(target: ServerTarget) {
  const headers: Record<string, string> = {};
  if (target.token) {
    headers.Authorization = `Bearer ${target.token}`;
  }
  if (target.hostToken) {
    headers["X-OpenWork-Host-Token"] = target.hostToken;
  }
  return headers;
}

async function fetchServerV2Status(target: ServerTarget) {
  const client = createOpenWorkServerClient({
    baseUrl: target.baseUrl,
    fetch: isTauriRuntime() ? tauriFetch : globalThis.fetch,
    headers: buildHeaders(target),
    responseStyle: "data",
    throwOnError: true,
  });

  const [healthResult, statusResult] = await Promise.all([
    getSystemHealth({ client, throwOnError: true }),
    getSystemStatus({ client, throwOnError: true }),
  ]);

  return {
    health: healthResult.data as OpenWorkServerV2HealthResponse,
    status: statusResult.data as OpenWorkServerV2SystemStatusResponse,
  };
}

async function fetchServerV2WorkspaceList(target: ServerTarget) {
  const client = createOpenWorkServerClient({
    baseUrl: target.baseUrl,
    fetch: isTauriRuntime() ? tauriFetch : globalThis.fetch,
    headers: buildHeaders(target),
    responseStyle: "data",
    throwOnError: true,
  });

  const result = await getWorkspaces({ client, throwOnError: true });
  return result.data as OpenWorkServerV2WorkspaceListResponse;
}

async function fetchServerV2WorkspaceDetail(target: ServerTarget, workspaceId: string) {
  const client = createOpenWorkServerClient({
    baseUrl: target.baseUrl,
    fetch: isTauriRuntime() ? tauriFetch : globalThis.fetch,
    headers: buildHeaders(target),
    responseStyle: "data",
    throwOnError: true,
  });

  const result = await getWorkspacesByWorkspaceId({
    client,
    path: { workspaceId },
    throwOnError: true,
  });
  return result.data as OpenWorkServerV2WorkspaceDetailResponse;
}

export function createServerVersionAdapter(accessors: ServerVersionAccessors) {
  const developerMode = () => accessors.developerMode();
  const rolloutEnabled = () => isServerV2Enabled();

  const listTargets = () => {
    const targets = new Map<string, ServerTarget>();
    const hostInfo = accessors.openworkServerHostInfo();
    const settings = accessors.openworkServerSettings();
    const selectedWorkspace = accessors.selectedWorkspaceDisplay();

    if (hostInfo?.baseUrl?.trim()) {
      const baseUrl = normalizeTargetBaseUrl(hostInfo.baseUrl);
      targets.set(LOCAL_SERVER_ID, {
        baseUrl,
        contractHint: getContractHint(hostInfo),
        hostToken: hostInfo.hostToken?.trim() || undefined,
        hostingKind: "desktop",
        kind: "local",
        label: "Local OpenWork Server",
        legacyCapabilities: accessors.openworkServerCapabilities(),
        serverId: LOCAL_SERVER_ID,
        source: "desktop-host",
        token: hostInfo.clientToken?.trim() || undefined,
      });
    }

    const remoteWorkspaceUrl = selectedWorkspace.workspaceType === "remote"
      ? selectedWorkspace.openworkHostUrl?.trim() || selectedWorkspace.baseUrl?.trim() || ""
      : "";
    if (remoteWorkspaceUrl) {
      const baseUrl = normalizeTargetBaseUrl(remoteWorkspaceUrl);
      const serverId = createRemoteServerId(baseUrl);
      targets.set(serverId, {
        baseUrl,
        contractHint: "unknown",
        hostingKind: resolveHostingKind(baseUrl),
        kind: "remote",
        label: selectedWorkspace.name || "Remote OpenWork Server",
        legacyCapabilities: null,
        serverId,
        source: "selected-remote-workspace",
        token: selectedWorkspace.openworkToken?.trim() || settings.token?.trim() || undefined,
      });
    }

    if (settings.urlOverride?.trim()) {
      const baseUrl = normalizeTargetBaseUrl(settings.urlOverride);
      const serverId = createRemoteServerId(baseUrl);
      if (!targets.has(serverId)) {
        targets.set(serverId, {
          baseUrl,
          contractHint: "unknown",
          hostingKind: resolveHostingKind(baseUrl),
          kind: "remote",
          label: "Configured OpenWork Server",
          legacyCapabilities: null,
          serverId,
          source: "server-settings",
          token: settings.token?.trim() || undefined,
        });
      }
    }

    return Array.from(targets.values());
  };

  const resolvePrimaryServerId = () => {
    const startupPreference = accessors.startupPreference();
    const selectedWorkspace = accessors.selectedWorkspaceDisplay();
    const settings = accessors.openworkServerSettings();
    const hostInfo = accessors.openworkServerHostInfo();

    if (startupPreference !== "server" && hostInfo?.baseUrl?.trim()) {
      return LOCAL_SERVER_ID;
    }

    if (selectedWorkspace.workspaceType === "remote") {
      const remoteWorkspaceUrl = selectedWorkspace.openworkHostUrl?.trim() || selectedWorkspace.baseUrl?.trim() || "";
      if (remoteWorkspaceUrl) {
        return createRemoteServerId(remoteWorkspaceUrl);
      }
    }

    if (settings.urlOverride?.trim()) {
      return createRemoteServerId(settings.urlOverride);
    }

    if (hostInfo?.baseUrl?.trim()) {
      return LOCAL_SERVER_ID;
    }

    return null;
  };

  const resolveTarget = (serverId: string, explicit?: ExplicitServerTargetInput): ServerTarget => {
    if (explicit) {
      const baseUrl = normalizeTargetBaseUrl(explicit.baseUrl);
      return {
        baseUrl,
        contractHint: "unknown",
        hostToken: explicit.hostToken?.trim() || undefined,
        hostingKind: resolveHostingKind(baseUrl),
        kind: serverId === LOCAL_SERVER_ID ? "local" : "remote",
        label: explicit.label?.trim() || "OpenWork Server",
        legacyCapabilities: null,
        serverId,
        source: serverId === LOCAL_SERVER_ID ? "desktop-host" : "server-settings",
        token: explicit.token?.trim() || undefined,
      };
    }

    const target = listTargets().find((entry) => entry.serverId === serverId);
    if (!target) {
      throw new Error(`Unknown Server V2 target: ${serverId}`);
    }
    return target;
  };

  const probeStatus = async (input: {
    explicitTarget?: ExplicitServerTargetInput;
    serverId: string;
  }): Promise<ServerStatusProbe> => {
    const target = resolveTarget(input.serverId, input.explicitTarget);
    const route = resolveServerVersionRoute({
      contractHint: target.contractHint,
      feature: "system-status",
      rolloutEnabled: rolloutEnabled(),
      targetKind: target.kind,
    });

    const runLegacy = async () => {
      const health = await fetchLegacySystemHealth(target);
      if (!target.token) {
        recordServerVersionDecision(developerMode(), "status:legacy-limited", {
          baseUrl: target.baseUrl,
          reason: route.reason,
          serverId: target.serverId,
        });
        return {
          capabilities: null,
          contract: "legacy" as const,
          diagnostics: buildSyntheticDiagnostics({
            target,
            uptimeMs: health.uptimeMs,
            version: health.version,
          }),
          status: "limited" as const,
        } satisfies ServerStatusProbe;
      }

      const legacy = await fetchLegacySystemStatus(target);
      const capabilities = target.legacyCapabilities ?? await fetchLegacyCapabilities(target).catch(() => null);
      recordServerVersionDecision(developerMode(), "status:legacy", {
        baseUrl: target.baseUrl,
        reason: route.reason,
        serverId: target.serverId,
      });
      return {
        capabilities,
        contract: "legacy" as const,
        diagnostics: normalizeLegacyDiagnostics({ diagnostics: legacy.diagnostics }),
        status: capabilities ? "connected" as const : "limited" as const,
      } satisfies ServerStatusProbe;
    };

    const runServerV2 = async () => {
      const status = await fetchServerV2Status(target);
      recordServerVersionDecision(developerMode(), "status:server-v2", {
        baseUrl: target.baseUrl,
        reason: route.reason,
        serverId: target.serverId,
      });
      return {
        capabilities: normalizeServerV2Capabilities(status.status),
        contract: "server-v2" as const,
        diagnostics: normalizeServerV2Diagnostics({ status: status.status, target }),
        status: "limited" as const,
      } satisfies ServerStatusProbe;
    };

    if (route.primary === "legacy") {
      return runLegacy();
    }

    try {
      return await runServerV2();
    } catch (error) {
      if (route.fallback !== "legacy" || !shouldFallbackToLegacy(error)) {
        throw error;
      }

      recordServerVersionDecision(developerMode(), "status:fallback-legacy", {
        baseUrl: target.baseUrl,
        message: error instanceof Error ? error.message : String(error),
        serverId: target.serverId,
      });
      return runLegacy();
    }
  };

  const probeHealth = async (input: {
    explicitTarget?: ExplicitServerTargetInput;
    serverId: string;
  }) => {
    const target = resolveTarget(input.serverId, input.explicitTarget);
    const route = resolveServerVersionRoute({
      contractHint: target.contractHint,
      feature: "system-health",
      rolloutEnabled: rolloutEnabled(),
      targetKind: target.kind,
    });

    if (route.primary === "server-v2") {
      try {
        const status = await fetchServerV2Status(target);
        recordServerVersionDecision(developerMode(), "health:server-v2", {
          baseUrl: target.baseUrl,
          reason: route.reason,
          serverId: target.serverId,
        });
        return {
          contract: "server-v2" as const,
          health: status.health,
          ok: status.health.data.status === "ok",
        };
      } catch (error) {
        if (route.fallback !== "legacy" || !shouldFallbackToLegacy(error)) {
          throw error;
        }
        recordServerVersionDecision(developerMode(), "health:fallback-legacy", {
          baseUrl: target.baseUrl,
          message: error instanceof Error ? error.message : String(error),
          serverId: target.serverId,
        });
      }
    }

    const legacy = await fetchLegacySystemHealth(target);
    recordServerVersionDecision(developerMode(), "health:legacy", {
      baseUrl: target.baseUrl,
      reason: route.reason,
      serverId: target.serverId,
    });
    return {
      contract: "legacy" as const,
      health: legacy,
      ok: legacy.ok === true,
    };
  };

  const createSdk = (input: {
    explicitTarget?: ExplicitServerTargetInput;
    serverId: string;
  }) => ({
    system: {
      health: () => probeHealth(input),
      status: () => probeStatus(input),
    },
    workspaces: {
      detail: async (workspaceId: string, options?: { legacyWorkspaceList?: WorkspaceList | null }) => {
        const target = resolveTarget(input.serverId, input.explicitTarget);
        const route = resolveServerVersionRoute({
          contractHint: target.contractHint,
          feature: "workspace-read",
          rolloutEnabled: rolloutEnabled(),
          targetKind: target.kind,
        });

        const runLegacy = () => {
          const item = (options?.legacyWorkspaceList?.workspaces ?? []).find((workspace) => workspace.id === workspaceId);
          if (!item) {
            throw new Error(`Workspace not found in legacy cache: ${workspaceId}`);
          }
          return item;
        };

        const runServerV2 = async () => {
          const response = await fetchServerV2WorkspaceDetail(target, workspaceId);
          return normalizeServerV2WorkspaceDetail({
            legacyWorkspaceList: options?.legacyWorkspaceList ?? null,
            response,
          });
        };

        if (route.primary === "legacy") {
          return runLegacy();
        }

        try {
          return await runServerV2();
        } catch (error) {
          if (route.fallback !== "legacy" || !shouldFallbackToLegacy(error)) {
            throw error;
          }
          return runLegacy();
        }
      },
      list: async (options?: { legacyWorkspaceList?: WorkspaceList | null }) => {
        const target = resolveTarget(input.serverId, input.explicitTarget);
        const route = resolveServerVersionRoute({
          contractHint: target.contractHint,
          feature: "workspace-read",
          rolloutEnabled: rolloutEnabled(),
          targetKind: target.kind,
        });

        const runLegacy = () => options?.legacyWorkspaceList ?? { selectedId: "", watchedId: null, workspaces: [] };

        const runServerV2 = async () => {
          const response = await fetchServerV2WorkspaceList(target);
          return normalizeServerV2WorkspaceList({
            legacyWorkspaceList: options?.legacyWorkspaceList ?? null,
            response,
          });
        };

        if (route.primary === "legacy") {
          return runLegacy();
        }

        try {
          return await runServerV2();
        } catch (error) {
          if (route.fallback !== "legacy" || !shouldFallbackToLegacy(error)) {
            throw error;
          }
          return runLegacy();
        }
      },
    },
    target: () => resolveTarget(input.serverId, input.explicitTarget),
  });

  return {
    createSdk,
    isServerV2Enabled: rolloutEnabled,
    listTargets,
    probeHealth,
    probeStatus,
    resolvePrimaryServerId,
    resolveTarget,
  };
}
