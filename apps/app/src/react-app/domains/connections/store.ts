import { useSyncExternalStore } from "react";

import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

import { t } from "../../../i18n";
import {
  getMcpServerName,
  MCP_QUICK_CONNECT,
  type McpDirectoryInfo,
} from "../../../app/constants";
import { createClient, unwrap } from "../../../app/lib/opencode";
import { finishPerf, perfNow, recordPerfLog } from "../../../app/lib/perf-log";
import {
  readOpencodeConfig,
  writeOpencodeConfig,
  type OpencodeConfigFile,
} from "../../../app/lib/desktop";
import { toSessionTransportDirectory } from "../../../app/lib/session-scope";
import {
  parseMcpServersFromContent,
  removeMcpFromConfig,
  validateMcpServerName,
} from "../../../app/mcp";
import { buildOpenworkWorkspaceBaseUrl } from "../../../app/lib/openwork-server";
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

    return readOpencodeConfig(scope, projectDir) as Promise<OpencodeConfigFile>;
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

    const mountedBaseUrl =
      buildOpenworkWorkspaceBaseUrl(openworkBaseUrl, options.runtimeWorkspaceId()) ?? openworkBaseUrl;
    activeClient = createClient(`${mountedBaseUrl.replace(/\/+$/, "")}/opencode`, undefined, {
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

  const listMcpFromOpenworkServer = async (projectDir: string) => {
    const openworkSnapshot = getOpenworkSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId =
      options.runtimeWorkspaceId()?.trim() ||
      options.selectedWorkspaceId().trim() ||
      ((await options.ensureRuntimeWorkspaceId?.()) ?? "")?.trim();
    const canTryOpenworkServer =
      openworkSnapshot.openworkServerStatus === "connected" &&
      Boolean(openworkClient) &&
      Boolean(openworkWorkspaceId) &&
      openworkSnapshot.openworkServerCapabilities?.mcp?.read !== false;

    recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-check", {
      workspaceType: options.workspaceType(),
      projectDir: projectDir || null,
      openworkStatus: openworkSnapshot.openworkServerStatus,
      hasOpenworkClient: Boolean(openworkClient),
      openworkWorkspaceId: openworkWorkspaceId || null,
      canReadMcp: openworkSnapshot.openworkServerCapabilities?.mcp?.read ?? null,
      canTryOpenworkServer,
    });

    if (!canTryOpenworkServer || !openworkClient || !openworkWorkspaceId) return null;

    const response = await openworkClient.listMcp(openworkWorkspaceId);
    const next = response.items.map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
      source: entry.source,
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

    recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-result", {
      count: next.length,
      names: next.map((entry) => entry.name),
      sources: next.map((entry) => entry.source ?? "unknown"),
    });

    return { next, nextStatuses };
  };

  const resolveLocalMcpCommand = async (entry: McpDirectoryInfo) => {
    if (entry.serverName !== "openwork-ui") {
      return entry.command;
    }
    try {
      const command = await (window as any).__OPENWORK_ELECTRON__?.invokeDesktop?.("getOpenworkUiMcpCommand");
      if (Array.isArray(command) && command.every((part) => typeof part === "string") && command.length > 0) {
        return command;
      }
    } catch {
      // Fall through to the published package command.
    }
    return entry.command;
  };

  const resolveLocalMcpEnvironment = async (entry: McpDirectoryInfo) => {
    if (entry.serverName !== "openwork-ui") return undefined;
    try {
      const environment = await (window as any).__OPENWORK_ELECTRON__?.invokeDesktop?.("getOpenworkUiMcpEnvironment");
      if (environment && typeof environment === "object" && !Array.isArray(environment)) {
        return Object.fromEntries(
          Object.entries(environment).filter((entry): entry is [string, string] =>
            typeof entry[0] === "string" && typeof entry[1] === "string"
          ),
        );
      }
    } catch {
      // Discovery fallback in openwork-ui-mcp still handles normal launches.
    }
    return undefined;
  };

  async function refreshMcpServers() {
    if (disposed) return;

    const projectDir = options.projectDir().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";

    try {
      setStateField("mcpStatus", null);
      const serverResult = await listMcpFromOpenworkServer(projectDir);
      if (serverResult) {
        mutateState((current) => ({
          ...current,
          mcpServers: serverResult.next,
          mcpLastUpdatedAt: Date.now(),
          mcpStatuses: serverResult.nextStatuses,
          mcpStatus: serverResult.next.length ? null : "No MCP servers configured yet.",
        }));
        return;
      }
    } catch (error) {
      recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-error", {
        message: error instanceof Error ? error.message : String(error),
      });
      if (isRemoteWorkspace) {
        mutateState((current) => ({
          ...current,
          mcpServers: [],
          mcpStatuses: {},
          mcpStatus: error instanceof Error ? error.message : "Failed to load MCP servers",
        }));
        return;
      }
    }

    if (isRemoteWorkspace) {
      mutateState((current) => ({
        ...current,
        mcpStatus: "OpenWork server unavailable. MCP config is read-only.",
        mcpServers: [],
        mcpStatuses: {},
      }));
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
      recordPerfLog(options.developerMode(), "mcp.refresh", "desktop-project-fallback", {
        projectDir,
      });
      const [globalConfig, projectConfig] = await Promise.all([
        readOpencodeConfig("global", projectDir) as Promise<OpencodeConfigFile>,
        readOpencodeConfig("project", projectDir) as Promise<OpencodeConfigFile>,
      ]);
      const globalServers = globalConfig.exists && globalConfig.content
        ? parseMcpServersFromContent(globalConfig.content).map((entry) => ({
          ...entry,
          source: "config.global" as const,
        }))
        : [];
      const projectServers = projectConfig.exists && projectConfig.content
        ? parseMcpServersFromContent(projectConfig.content)
        : [];
      const projectNames = new Set(projectServers.map((entry) => entry.name));
      const next = [
        ...globalServers.filter((entry) => !projectNames.has(entry.name)),
        ...projectServers,
      ];

      recordPerfLog(options.developerMode(), "mcp.refresh", "desktop-project-fallback-result", {
        globalConfigPath: globalConfig.path,
        projectConfigPath: projectConfig.path,
        count: next.length,
        names: next.map((entry) => entry.name),
        sources: next.map((entry) => entry.source ?? "unknown"),
      });

      if (!globalConfig.exists && !projectConfig.exists) {
        mutateState((current) => ({
          ...current,
          mcpServers: [],
          mcpStatuses: {},
          mcpStatus: "No opencode.json found yet. Create one by connecting an MCP.",
        }));
        return;
      }

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
      setStateField("mcpStatus", t("mcp.desktop_required"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "desktop-required",
      });
      return;
    }

    if (!isRemoteWorkspace && !projectDir) {
      setStateField("mcpStatus", t("mcp.pick_workspace_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace",
      });
      return;
    }

    const activeClient = await ensureActiveClient();
    if (!activeClient) {
      setStateField("mcpStatus", t("mcp.connect_server_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "no-active-client",
      });
      return;
    }

    const resolvedProjectDir = await resolveProjectDir(activeClient, projectDir);
    if (!resolvedProjectDir) {
      setStateField("mcpStatus", t("mcp.pick_workspace_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace-after-discovery",
      });
      return;
    }

    const slug = entry.id ?? getMcpServerName(entry);
    const action = snapshot.mcpServers.some((server) => server.name === slug) ? "updated" : "added";

    try {
      mutateState((current) => ({ ...current, mcpStatus: null, mcpConnectingName: entry.name }));

      // Resolve dynamic URLs for built-in MCPs
      let resolvedUrl = entry.url;
      let resolvedHeaders: Record<string, string> | undefined;
      if (!resolvedUrl && entry.serverName === "openwork-ui") {
        try {
          const bridgeInfo = await (window as any).__OPENWORK_ELECTRON__?.invokeDesktop?.("getUiControlBridgeInfo");
          if (bridgeInfo?.baseUrl) {
            resolvedUrl = `${bridgeInfo.baseUrl}/mcp`;
            if (bridgeInfo.token) {
              resolvedHeaders = { Authorization: `Bearer ${bridgeInfo.token}` };
            }
          }
        } catch {
          // Bridge not available
        }
      }

      const mcpEntryConfig: Record<string, unknown> = {
        type: entryType,
        enabled: true,
      };

      if (entryType === "remote") {
        if (!resolvedUrl) {
          throw new Error("Missing MCP URL. Is the OpenWork desktop app running?");
        }
        mcpEntryConfig["url"] = resolvedUrl;
        if (resolvedHeaders) {
          mcpEntryConfig["headers"] = resolvedHeaders;
        }
        if (entry.oauth && !resolvedHeaders) {
          mcpEntryConfig["oauth"] = {};
        }
      }

      if (entryType === "local") {
        if (!entry.command?.length) {
          throw new Error("Missing MCP command.");
        }
        mcpEntryConfig["command"] = await resolveLocalMcpCommand(entry);
        const environment = await resolveLocalMcpEnvironment(entry);
        if (environment) {
          mcpEntryConfig["environment"] = environment;
        }
      }

      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        await openworkClient.addMcp(openworkWorkspaceId, {
          name: slug,
          config: mcpEntryConfig,
        });
      } else {
        const configFile = await readOpencodeConfig("project", resolvedProjectDir) as OpencodeConfigFile;

        const raw = configFile.exists && configFile.content?.trim()
          ? configFile.content
          : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';

        const parseErrors: Array<{ error: number; offset: number; length: number }> = [];
        parse(raw, parseErrors, { allowTrailingComma: true });
        if (parseErrors.length > 0) {
          const details = parseErrors
            .map((entry) => printParseErrorCode(entry.error))
            .join(", ");
          throw new Error(`Failed to parse opencode config: ${details}`);
        }

        let updated = raw;
        const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
        updated = applyEdits(
          updated,
          modify(updated, ["$schema"], "https://opencode.ai/config.json", { formattingOptions }),
        );
        updated = applyEdits(
          updated,
          modify(updated, ["mcp", slug], mcpEntryConfig, { formattingOptions }),
        );

        const writeResult = await writeOpencodeConfig(
          "project",
          resolvedProjectDir,
          updated.endsWith("\n") ? updated : `${updated}\n`,
        ) as { ok: boolean; stderr?: string; stdout?: string };
        if (!writeResult.ok) {
          throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
        }
      }

      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        // The OpenWork server is the source of truth for workspace-scoped MCP
        // config in the React port. Avoid also calling the OpenCode SDK's MCP
        // hot-add endpoint here: when the SDK client is rooted at the aggregate
        // `/opencode` route it can resolve to an internal `local_*` workspace
        // id that the OpenWork server does not expose, producing a confusing
        // `workspace_not_found` after the config write already succeeded.
        setStateField("mcpStatuses", filterConfiguredStatuses(snapshot.mcpStatuses, snapshot.mcpServers));
      } else {
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
                command: (mcpEntryConfig["command"] as string[]) ?? entry.command!,
                enabled: true,
              };

        const status = unwrap(
          await activeClient.mcp.add({
            directory: resolvedProjectDir,
            name: slug,
            config: mcpAddConfig,
          }),
        );

        setStateField("mcpStatuses", status as McpStatusMap);
      }
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
        setStateField("mcpStatus", t("mcp.connected"));
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
        error instanceof Error ? error.message : t("mcp.connect_failed"),
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
      setStateField("mcpStatus", t("mcp.login_unavailable"));
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
      setStateField("mcpStatus", t("mcp.desktop_required"));
      return;
    }

    const activeClient = await ensureActiveClient();
    if (!activeClient) {
      setStateField("mcpStatus", t("mcp.connect_server_first"));
      return;
    }

    const resolvedProjectDir = await resolveProjectDir(activeClient, projectDir);
    if (!resolvedProjectDir) {
      setStateField("mcpStatus", t("mcp.pick_workspace_first"));
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
      setStateField("mcpStatus", t("mcp.logout_success").replace("{server}", safeName));
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.logout_failed"),
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
          setStateField("mcpStatus", t("mcp.pick_workspace_first"));
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
        error instanceof Error ? error.message : t("mcp.remove_failed"),
      );
    }
  }

  function notifyMcpReloading() {
    setStateField("mcpStatus", t("mcp.reloading_status"));
  }

  // OpenCode reconnects MCP servers asynchronously after /instance/dispose,
  // so an immediate mcp.status query returns stale "disconnected". Poll on
  // a backoff until every enabled MCP reaches a terminal status, with the
  // banner up the whole time so users see continuous feedback.
  async function pollMcpServersAfterReload(): Promise<void> {
    if (disposed) return;
    notifyMcpReloading();
    await refreshMcpServers();

    const settled = (statuses: McpStatusMap, servers: McpServerEntry[]) => {
      const expected = servers.filter((s) => s.config.enabled !== false);
      if (expected.length === 0) return true;
      return expected.every((server) => {
        const status = statuses[server.name]?.status;
        return status === "connected" || status === "needs_auth" || status === "failed";
      });
    };

    const delays = [400, 800, 1500, 2500, 4000];
    for (const delay of delays) {
      if (disposed) return;
      if (settled(snapshot.mcpStatuses, snapshot.mcpServers)) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await refreshMcpServers();
    }

    if (disposed) return;
    // Only clear the reloading banner if it's still ours. refreshMcpServers
    // may have already replaced it with a real message (e.g. "No MCP servers").
    if (snapshot.mcpStatus === t("mcp.reloading_status")) {
      setStateField("mcpStatus", null);
    }
  }

  // Server-only path. Local fallback would rewrite opencode.jsonc whole and
  // clobber inline comments — settings-route.tsx already gates the prop so
  // this never gets called when the server is unavailable. Reload UX comes
  // from the existing reload-required popup; no extra banner here.
  async function setMcpEnabled(name: string, enabled: boolean) {
    try {
      const openworkSnapshot = getOpenworkSnapshot();
      const openworkClient = openworkSnapshot.openworkServerClient;
      const openworkWorkspaceId = options.runtimeWorkspaceId();
      const canUseOpenworkServer =
        openworkSnapshot.openworkServerStatus === "connected" &&
        openworkClient &&
        openworkWorkspaceId &&
        openworkSnapshot.openworkServerCapabilities?.mcp?.write;

      if (!canUseOpenworkServer || !openworkClient || !openworkWorkspaceId) {
        setStateField("mcpStatus", t("mcp.toggle_requires_server"));
        return;
      }

      await openworkClient.setMcpEnabled(openworkWorkspaceId, name, enabled);
      options.markReloadRequired?.("mcp", { type: "mcp", name, action: "updated" });
      await refreshMcpServers();
    } catch (error) {
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.toggle_failed"),
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
    setMcpEnabled,
    notifyMcpReloading,
    pollMcpServersAfterReload,
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
