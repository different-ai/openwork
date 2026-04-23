import { useSyncExternalStore } from "react";

import { parse } from "jsonc-parser";

import { currentLocale, t } from "../../../i18n";
import {
  CHROME_DEVTOOLS_MCP_ID,
  MCP_QUICK_CONNECT,
  type McpDirectoryInfo,
} from "../../../app/constants";
import { createClient, unwrap } from "../../../app/lib/opencode";
import { finishPerf, perfNow, recordPerfLog } from "../../../app/lib/perf-log";
import {
  getDesktopHomeDir,
  readOpencodeConfig,
  writeOpencodeConfig,
  type OpencodeConfigFile,
} from "../../../app/lib/desktop";
import { toSessionTransportDirectory } from "../../../app/lib/session-scope";
import {
  parseMcpServersFromContent,
  removeMcpFromConfig,
  usesChromeDevtoolsAutoConnect,
  validateMcpServerName,
} from "../../../app/mcp";
import type {
  Client,
  McpServerEntry,
  McpStatusMap,
  ReloadReason,
  ReloadTrigger,
} from "../../../app/types";
import { isDesktopRuntime, normalizeDirectoryPath, safeStringify } from "../../../app/utils";

import type { OpenworkServerStore } from "./openwork-server-store";

type SetStateAction<T> = T | ((current: T) => T);

export type ConnectionsStoreSnapshot = {
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  mcpAuthModalOpen: boolean;
  mcpAuthEntry: McpDirectoryInfo | null;
  mcpAuthNeedsReload: boolean;
};

type MutableState = ConnectionsStoreSnapshot;

export type ConnectionsStore = ReturnType<typeof createConnectionsStore>;

export function createConnectionsStore(options: {
  client: () => Client | null;
  setClient: (value: Client | null) => void;
  projectDir: () => string;
  selectedWorkspaceId: () => string;
  selectedWorkspaceRoot: () => string;
  workspaceType: () => "local" | "remote";
  openworkServer: OpenworkServerStore;
  runtimeWorkspaceId: () => string | null;
  ensureRuntimeWorkspaceId?: () => Promise<string | null | undefined>;
  setProjectDir?: (value: string) => void;
  developerMode: () => boolean;
  markReloadRequired?: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
}) {
  const listeners = new Set<() => void>();
  const translate = (key: string) => t(key, currentLocale());

  let started = false;
  let disposed = false;
  let lastWorkspaceContextKey = "";
  let lastProjectDir = "";
  let snapshot: ConnectionsStoreSnapshot;

  let state: MutableState = {
    mcpServers: [],
    mcpStatus: null,
    mcpLastUpdatedAt: null,
    mcpStatuses: {},
    mcpConnectingName: null,
    selectedMcp: null,
    mcpAuthModalOpen: false,
    mcpAuthEntry: null,
    mcpAuthNeedsReload: false,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const refreshSnapshot = () => {
    snapshot = {
      mcpServers: state.mcpServers,
      mcpStatus: state.mcpStatus,
      mcpLastUpdatedAt: state.mcpLastUpdatedAt,
      mcpStatuses: state.mcpStatuses,
      mcpConnectingName: state.mcpConnectingName,
      selectedMcp: state.selectedMcp,
      mcpAuthModalOpen: state.mcpAuthModalOpen,
      mcpAuthEntry: state.mcpAuthEntry,
      mcpAuthNeedsReload: state.mcpAuthNeedsReload,
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
    typeof next === "function" ? (next as (value: T) => T)(current) : next;

  const getWorkspaceContextKey = () => {
    const workspaceId = options.selectedWorkspaceId().trim();
    const root = normalizeDirectoryPath(options.selectedWorkspaceRoot().trim());
    const runtimeWorkspaceId = (options.runtimeWorkspaceId() ?? "").trim();
    const workspaceType = options.workspaceType();
    return `${workspaceType}:${workspaceId}:${root}:${runtimeWorkspaceId}`;
  };

  const getOpenworkSnapshot = () => options.openworkServer.getSnapshot();

  const filterConfiguredStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
    const configured = new Set(entries.map((entry) => entry.name));
    return Object.fromEntries(
      Object.entries(status).filter(([name]) => configured.has(name)),
    ) as McpStatusMap;
  };

  const readMcpConfigFile = async (scope: "project" | "global"): Promise<OpencodeConfigFile | null> => {
    const projectDir = options.projectDir().trim();
    const openworkSnapshot = getOpenworkSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.config?.read;

    if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
      return openworkClient.readOpencodeConfigFile(openworkWorkspaceId, scope);
    }

    if (!isDesktopRuntime()) {
      return null;
    }

    return readOpencodeConfig(scope, projectDir);
  };

  const ensureActiveClient = async () => {
    let activeClient = options.client();
    if (activeClient) {
      return activeClient;
    }

    const openworkSnapshot = getOpenworkSnapshot();
    const openworkBaseUrl = openworkSnapshot.openworkServerBaseUrl.trim();
    const token = openworkSnapshot.openworkServerAuth.token?.trim();
    if (!openworkBaseUrl || !token) {
      return null;
    }

    activeClient = createClient(`${openworkBaseUrl.replace(/\/+$/, "")}/opencode`, undefined, {
      token,
      mode: "openwork",
    });
    options.setClient(activeClient);
    return activeClient;
  };

  const resolveWritableOpenworkTarget = async () => {
    const openworkSnapshot = getOpenworkSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    let openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = openworkSnapshot.openworkServerCapabilities;
    if (!openworkWorkspaceId && openworkClient && openworkSnapshot.openworkServerStatus === "connected") {
      openworkWorkspaceId = (await options.ensureRuntimeWorkspaceId?.()) ?? null;
    }

    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.mcp?.write;

    return {
      openworkClient,
      openworkWorkspaceId,
      canUseOpenworkServer: Boolean(canUseOpenworkServer),
    };
  };

  const resolveProjectDir = async (activeClient: Client | null, currentProjectDir: string) => {
    let resolvedProjectDir = currentProjectDir;
    if (!resolvedProjectDir && activeClient) {
      try {
        const pathInfo = unwrap(await activeClient.path.get());
        const discoveredRaw = toSessionTransportDirectory(pathInfo.directory ?? "");
        const discovered = discoveredRaw.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
        if (discovered) {
          resolvedProjectDir = discovered;
          options.setProjectDir?.(discovered);
        }
      } catch {
        // ignore
      }
    }

    return resolvedProjectDir;
  };

  async function refreshMcpServers() {
    if (disposed) return;

    const projectDir = options.projectDir().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = !isRemoteWorkspace;
    const openworkSnapshot = getOpenworkSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkSnapshot.openworkServerCapabilities?.mcp?.read;

    if (isRemoteWorkspace) {
      if (!canUseOpenworkServer) {
        mutateState((current) => ({
          ...current,
          mcpStatus: "OpenWork server unavailable. MCP config is read-only.",
          mcpServers: [],
          mcpStatuses: {},
        }));
        return;
      }

      try {
        setStateField("mcpStatus", null);
        const response = await openworkClient.listMcp(openworkWorkspaceId);
        const next = response.items.map((entry) => ({
          name: entry.name,
          config: entry.config as McpServerEntry["config"],
        }));

        let nextStatuses: McpStatusMap = {};
        const activeClient = options.client();
        if (activeClient && projectDir) {
          try {
            const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
            nextStatuses = filterConfiguredStatuses(status as McpStatusMap, next);
          } catch {
            nextStatuses = {};
          }
        }

        mutateState((current) => ({
          ...current,
          mcpServers: next,
          mcpLastUpdatedAt: Date.now(),
          mcpStatuses: nextStatuses,
          mcpStatus: next.length ? null : "No MCP servers configured yet.",
        }));
      } catch (error) {
        mutateState((current) => ({
          ...current,
          mcpServers: [],
          mcpStatuses: {},
          mcpStatus:
            error instanceof Error ? error.message : "Failed to load MCP servers",
        }));
      }
      return;
    }

    if (isLocalWorkspace && canUseOpenworkServer) {
      try {
        setStateField("mcpStatus", null);
        const response = await openworkClient.listMcp(openworkWorkspaceId);
        const next = response.items.map((entry) => ({
          name: entry.name,
          config: entry.config as McpServerEntry["config"],
        }));

        let nextStatuses: McpStatusMap = {};
        const activeClient = options.client();
        if (activeClient && projectDir) {
          try {
            const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
            nextStatuses = filterConfiguredStatuses(status as McpStatusMap, next);
          } catch {
            nextStatuses = {};
          }
        }

        mutateState((current) => ({
          ...current,
          mcpServers: next,
          mcpLastUpdatedAt: Date.now(),
          mcpStatuses: nextStatuses,
          mcpStatus: next.length ? null : "No MCP servers configured yet.",
        }));
      } catch (error) {
        mutateState((current) => ({
          ...current,
          mcpServers: [],
          mcpStatuses: {},
          mcpStatus:
            error instanceof Error ? error.message : "Failed to load MCP servers",
        }));
      }
      return;
    }

    if (!isDesktopRuntime()) {
      mutateState((current) => ({
        ...current,
        mcpStatus: "MCP configuration is only available for local workspaces.",
        mcpServers: [],
        mcpStatuses: {},
      }));
      return;
    }

    if (!projectDir) {
      mutateState((current) => ({
        ...current,
        mcpStatus: "Pick a workspace folder to load MCP servers.",
        mcpServers: [],
        mcpStatuses: {},
      }));
      return;
    }

    try {
      setStateField("mcpStatus", null);
      const config = await readOpencodeConfig("project", projectDir);
      if (!config.exists || !config.content) {
        mutateState((current) => ({
          ...current,
          mcpServers: [],
          mcpStatuses: {},
          mcpStatus: "No opencode.json found yet. Create one by connecting an MCP.",
        }));
        return;
      }

      const next = parseMcpServersFromContent(config.content);
      let nextStatuses = state.mcpStatuses;
      const activeClient = options.client();
      if (activeClient) {
        try {
          const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
          nextStatuses = filterConfiguredStatuses(status as McpStatusMap, next);
        } catch {
          nextStatuses = {};
        }
      }

      mutateState((current) => ({
        ...current,
        mcpServers: next,
        mcpLastUpdatedAt: Date.now(),
        mcpStatuses: nextStatuses,
        mcpStatus: next.length ? null : "No MCP servers configured yet.",
      }));
    } catch (error) {
      mutateState((current) => ({
        ...current,
        mcpServers: [],
        mcpStatuses: {},
        mcpStatus: error instanceof Error ? error.message : "Failed to load MCP servers",
      }));
    }
  }

  async function connectMcp(entry: McpDirectoryInfo) {
    const startedAt = perfNow();
    const openworkSnapshot = getOpenworkSnapshot();
    const isRemoteWorkspace =
      options.workspaceType() === "remote" ||
      (!isDesktopRuntime() && openworkSnapshot.openworkServerStatus === "connected");
    const projectDir = options.projectDir().trim();
    const entryType = entry.type ?? "remote";

    recordPerfLog(options.developerMode(), "mcp.connect", "start", {
      name: entry.name,
      type: entryType,
      workspaceType: isRemoteWorkspace ? "remote" : "local",
      projectDir: projectDir || null,
    });

    const { openworkClient, openworkWorkspaceId, canUseOpenworkServer } =
      await resolveWritableOpenworkTarget();

    if (isRemoteWorkspace && !canUseOpenworkServer) {
      setStateField("mcpStatus", "OpenWork server unavailable. MCP config is read-only.");
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "openwork-server-unavailable",
      });
      return;
    }

    if (!canUseOpenworkServer && !isDesktopRuntime()) {
      setStateField("mcpStatus", translate("mcp.desktop_required"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "desktop-required",
      });
      return;
    }

    if (!isRemoteWorkspace && !projectDir) {
      setStateField("mcpStatus", translate("mcp.pick_workspace_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace",
      });
      return;
    }

    const activeClient = await ensureActiveClient();
    if (!activeClient) {
      setStateField("mcpStatus", translate("mcp.connect_server_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "no-active-client",
      });
      return;
    }

    const resolvedProjectDir = await resolveProjectDir(activeClient, projectDir);
    if (!resolvedProjectDir) {
      setStateField("mcpStatus", translate("mcp.pick_workspace_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace-after-discovery",
      });
      return;
    }

    const slug = entry.id ?? entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const action = snapshot.mcpServers.some((server) => server.name === slug) ? "updated" : "added";

    try {
      mutateState((current) => ({ ...current, mcpStatus: null, mcpConnectingName: entry.name }));

      let mcpEnvironment: Record<string, string> | undefined;

      const mcpEntryConfig: Record<string, unknown> = {
        type: entryType,
        enabled: true,
      };

      if (entryType === "remote") {
        if (!entry.url) {
          throw new Error("Missing MCP URL.");
        }
        mcpEntryConfig["url"] = entry.url;
        if (entry.oauth) {
          mcpEntryConfig["oauth"] = {};
        }
      }

      if (entryType === "local") {
        if (!entry.command?.length) {
          throw new Error("Missing MCP command.");
        }
        mcpEntryConfig["command"] = entry.command;

        if (
          slug === CHROME_DEVTOOLS_MCP_ID &&
          usesChromeDevtoolsAutoConnect(entry.command) &&
          isDesktopRuntime()
        ) {
          try {
            const hostHome = (await getDesktopHomeDir()).replace(/[\\/]+$/, "");
            if (hostHome) {
              mcpEnvironment = { HOME: hostHome };
              mcpEntryConfig["environment"] = mcpEnvironment;
            }
          } catch {
            // ignore and let the MCP use the default worker environment
          }
        }
      }

      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        await openworkClient.addMcp(openworkWorkspaceId, {
          name: slug,
          config: mcpEntryConfig,
        });
      } else {
        const configFile = await readOpencodeConfig("project", resolvedProjectDir);

        let existingConfig: Record<string, unknown> = {};
        if (configFile.exists && configFile.content?.trim()) {
          try {
            existingConfig = parse(configFile.content) ?? {};
          } catch (parseErr) {
            recordPerfLog(options.developerMode(), "mcp.connect", "config-parse-failed", {
              error: parseErr instanceof Error ? parseErr.message : String(parseErr),
            });
            existingConfig = {};
          }
        }

        if (!existingConfig["$schema"]) {
          existingConfig["$schema"] = "https://opencode.ai/config.json";
        }

        const mcpSection = (existingConfig["mcp"] as Record<string, unknown>) ?? {};
        existingConfig["mcp"] = mcpSection;
        mcpSection[slug] = mcpEntryConfig;

        const writeResult = await writeOpencodeConfig(
          "project",
          resolvedProjectDir,
          `${JSON.stringify(existingConfig, null, 2)}\n`,
        );
        if (!writeResult.ok) {
          throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
        }
      }

      const mcpAddConfig =
        entryType === "remote"
          ? {
              type: "remote" as const,
              url: entry.url!,
              enabled: true,
              ...(entry.oauth ? { oauth: {} } : {}),
            }
          : {
              type: "local" as const,
              command: entry.command!,
              enabled: true,
              ...(mcpEnvironment ? { environment: mcpEnvironment } : {}),
            };

      const status = unwrap(
        await activeClient.mcp.add({
          directory: resolvedProjectDir,
          name: slug,
          config: mcpAddConfig,
        }),
      );

      setStateField("mcpStatuses", status as McpStatusMap);
      options.markReloadRequired?.("mcp", { type: "mcp", name: slug, action });
      await refreshMcpServers();

      if (entry.oauth) {
        mutateState((current) => ({
          ...current,
          mcpAuthEntry: entry,
          mcpAuthNeedsReload: true,
          mcpAuthModalOpen: true,
        }));
      } else {
        setStateField("mcpStatus", translate("mcp.connected"));
      }

      await refreshMcpServers();
      finishPerf(options.developerMode(), "mcp.connect", "done", startedAt, {
        name: entry.name,
        type: entryType,
        slug,
      });
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : translate("mcp.connect_failed"),
      );
      finishPerf(options.developerMode(), "mcp.connect", "error", startedAt, {
        name: entry.name,
        type: entryType,
        error: error instanceof Error ? error.message : safeStringify(error),
      });
    } finally {
      setStateField("mcpConnectingName", null);
    }
  }

  function authorizeMcp(entry: McpServerEntry) {
    if (entry.config.type !== "remote" || entry.config.oauth === false) {
      setStateField("mcpStatus", translate("mcp.login_unavailable"));
      return;
    }

    const matchingQuickConnect = MCP_QUICK_CONNECT.find((candidate) => {
      const candidateSlug = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return candidateSlug === entry.name || candidate.name === entry.name;
    });

    mutateState((current) => ({
      ...current,
      mcpAuthEntry:
        matchingQuickConnect ?? {
          name: entry.name,
          description: "",
          type: "remote",
          url: entry.config.url,
          oauth: true,
        },
      mcpAuthNeedsReload: false,
      mcpAuthModalOpen: true,
    }));
  }

  async function logoutMcpAuth(name: string) {
    const openworkSnapshot = getOpenworkSnapshot();
    const isRemoteWorkspace =
      options.workspaceType() === "remote" ||
      (!isDesktopRuntime() && openworkSnapshot.openworkServerStatus === "connected");
    const projectDir = options.projectDir().trim();

    const { openworkClient, openworkWorkspaceId, canUseOpenworkServer } =
      await resolveWritableOpenworkTarget();

    if (isRemoteWorkspace && !canUseOpenworkServer) {
      setStateField("mcpStatus", "OpenWork server unavailable. MCP auth is read-only.");
      return;
    }

    if (!canUseOpenworkServer && !isDesktopRuntime()) {
      setStateField("mcpStatus", translate("mcp.desktop_required"));
      return;
    }

    const activeClient = await ensureActiveClient();
    if (!activeClient) {
      setStateField("mcpStatus", translate("mcp.connect_server_first"));
      return;
    }

    const resolvedProjectDir = await resolveProjectDir(activeClient, projectDir);
    if (!resolvedProjectDir) {
      setStateField("mcpStatus", translate("mcp.pick_workspace_first"));
      return;
    }

    const safeName = validateMcpServerName(name);
    setStateField("mcpStatus", null);

    try {
      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        await openworkClient.logoutMcpAuth(openworkWorkspaceId, safeName);
      } else {
        try {
          await activeClient.mcp.disconnect({ directory: resolvedProjectDir, name: safeName });
        } catch {
          // ignore
        }
        await activeClient.mcp.auth.remove({ directory: resolvedProjectDir, name: safeName });
      }

      try {
        const status = unwrap(await activeClient.mcp.status({ directory: resolvedProjectDir }));
        setStateField("mcpStatuses", status as McpStatusMap);
      } catch {
        // ignore
      }

      await refreshMcpServers();
      setStateField("mcpStatus", translate("mcp.logout_success").replace("{server}", safeName));
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : translate("mcp.logout_failed"),
      );
    }
  }

  async function removeMcp(name: string) {
    try {
      setStateField("mcpStatus", null);

      const openworkSnapshot = getOpenworkSnapshot();
      const openworkClient = openworkSnapshot.openworkServerClient;
      const openworkWorkspaceId = options.runtimeWorkspaceId();
      const canUseOpenworkServer =
        openworkSnapshot.openworkServerStatus === "connected" &&
        openworkClient &&
        openworkWorkspaceId &&
        openworkSnapshot.openworkServerCapabilities?.mcp?.write;

      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        await openworkClient.removeMcp(openworkWorkspaceId, name);
      } else {
        const projectDir = options.projectDir().trim();
        if (!projectDir) {
          setStateField("mcpStatus", translate("mcp.pick_workspace_first"));
          return;
        }
        await removeMcpFromConfig(projectDir, name);
      }

      options.markReloadRequired?.("mcp", { type: "mcp", name, action: "removed" });
      await refreshMcpServers();
      if (snapshot.selectedMcp === name) {
        setStateField("selectedMcp", null);
      }
      setStateField("mcpStatus", null);
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : translate("mcp.remove_failed"),
      );
    }
  }

  function closeMcpAuthModal() {
    mutateState((current) => ({
      ...current,
      mcpAuthModalOpen: false,
      mcpAuthEntry: null,
      mcpAuthNeedsReload: false,
    }));
  }

  async function completeMcpAuthModal() {
    closeMcpAuthModal();
    await refreshMcpServers();
  }

  const syncFromOptions = () => {
    const workspaceContextKey = getWorkspaceContextKey();
    const projectDir = options.projectDir().trim();
    const changed =
      workspaceContextKey !== lastWorkspaceContextKey || projectDir !== lastProjectDir;

    lastWorkspaceContextKey = workspaceContextKey;
    lastProjectDir = projectDir;

    if (!started || disposed || !isDesktopRuntime() || !changed) {
      return;
    }

    void refreshMcpServers();
  };

  const start = () => {
    if (started) return;
    // StrictMode double-mount re-arms after dispose.
    disposed = false;
    started = true;
    syncFromOptions();
  };

  const dispose = () => {
    disposed = true;
    started = false;
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => snapshot;

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    get mcpServers() {
      return snapshot.mcpServers;
    },
    get mcpStatus() {
      return snapshot.mcpStatus;
    },
    get mcpLastUpdatedAt() {
      return snapshot.mcpLastUpdatedAt;
    },
    get mcpStatuses() {
      return snapshot.mcpStatuses;
    },
    get mcpConnectingName() {
      return snapshot.mcpConnectingName;
    },
    get selectedMcp() {
      return snapshot.selectedMcp;
    },
    setSelectedMcp(value: SetStateAction<string | null>) {
      const resolved = applyStateAction(state.selectedMcp, value);
      setStateField("selectedMcp", resolved);
    },
    quickConnect: MCP_QUICK_CONNECT,
    readMcpConfigFile,
    refreshMcpServers,
    connectMcp,
    authorizeMcp,
    logoutMcpAuth,
    removeMcp,
    get mcpAuthModalOpen() {
      return snapshot.mcpAuthModalOpen;
    },
    get mcpAuthEntry() {
      return snapshot.mcpAuthEntry;
    },
    get mcpAuthNeedsReload() {
      return snapshot.mcpAuthNeedsReload;
    },
    closeMcpAuthModal,
    completeMcpAuthModal,
  };
}

export function useConnectionsStoreSnapshot(store: ConnectionsStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
