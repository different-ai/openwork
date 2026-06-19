import { useSyncExternalStore } from "react";

import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

import { t } from "../../../i18n";
import {
  getMcpServerName,
  MCP_QUICK_CONNECT,
  type McpDirectoryInfo,
} from "../../../app/constants";
import { extensionResource } from "../../../app/extensions";
import {
  isLegacyWebAppMcpUrl,
  mintCloudControlMcpToken,
  readDenSettings,
  resolveCloudMcpResourceUrl,
} from "../../../app/lib/den";
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

const CLOUD_MCP_SYNC_MARKER_KEY = "openwork.den.mcp.sync";
const CLOUD_MCP_REFRESH_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

type CloudMcpSyncMarker = { orgId: string; expiresAt: string };

function readCloudMcpSyncMarker(): CloudMcpSyncMarker | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CLOUD_MCP_SYNC_MARKER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { orgId?: unknown }).orgId === "string" &&
      typeof (parsed as { expiresAt?: unknown }).expiresAt === "string"
    ) {
      return parsed as CloudMcpSyncMarker;
    }
  } catch {
    // Corrupt marker — treat as absent.
  }
  return null;
}

function writeCloudMcpSyncMarker(marker: CloudMcpSyncMarker) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CLOUD_MCP_SYNC_MARKER_KEY, JSON.stringify(marker));
  } catch {
    // Storage unavailable — sync will simply re-run next time.
  }
}

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

  const resolveOpenworkWorkspaceId = async () => {
    const current = options.runtimeWorkspaceId()?.trim();
    if (current) return current;
    const openworkSnapshot = getOpenworkSnapshot();
    if (openworkSnapshot.openworkServerStatus !== "connected" || !openworkSnapshot.openworkServerClient) {
      return null;
    }
    const ensured = (await options.ensureRuntimeWorkspaceId?.())?.trim();
    if (ensured) return ensured;
    return options.workspaceType() === "local" ? options.selectedWorkspaceId().trim() || null : null;
  };

  const resolveConfigOpenworkTarget = async (mode: "read" | "write") => {
    const openworkSnapshot = getOpenworkSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = await resolveOpenworkWorkspaceId();
    const hasOpenworkTarget =
      openworkSnapshot.openworkServerStatus === "connected" &&
      Boolean(openworkClient && openworkWorkspaceId);
    const canUseOpenworkServer =
      hasOpenworkTarget &&
      openworkSnapshot.openworkServerCapabilities?.config?.[mode] !== false;
    return {
      openworkClient,
      openworkWorkspaceId,
      hasOpenworkTarget,
      canUseOpenworkServer,
    };
  };

  const resolveMcpOpenworkTarget = async (mode: "read" | "write") => {
    const openworkSnapshot = getOpenworkSnapshot();
    const openworkClient = openworkSnapshot.openworkServerClient;
    const openworkWorkspaceId = await resolveOpenworkWorkspaceId();
    const hasOpenworkTarget =
      openworkSnapshot.openworkServerStatus === "connected" &&
      Boolean(openworkClient && openworkWorkspaceId);
    const canUseOpenworkServer =
      hasOpenworkTarget &&
      openworkSnapshot.openworkServerCapabilities?.mcp?.[mode] !== false;
    return {
      openworkClient,
      openworkWorkspaceId,
      hasOpenworkTarget,
      canUseOpenworkServer,
    };
  };

  const filterConfiguredStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
    const configured = new Set(entries.map((entry) => entry.name));
    return Object.fromEntries(
      Object.entries(status).filter(([name]) => configured.has(name)),
    ) as McpStatusMap;
  };

  const readMcpConfigFile = async (scope: "project" | "global"): Promise<OpencodeConfigFile | null> => {
    const projectDir = options.projectDir().trim();
    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveConfigOpenworkTarget("read");

    if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
      return openworkClient.readOpencodeConfigFile(openworkWorkspaceId, scope);
    }

    if (hasOpenworkTarget) {
      return null;
    }

    if (options.workspaceType() !== "local" || !isDesktopRuntime()) {
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
      buildOpenworkWorkspaceBaseUrl(openworkBaseUrl, await resolveOpenworkWorkspaceId()) ?? openworkBaseUrl;
    activeClient = createClient(`${mountedBaseUrl.replace(/\/+$/, "")}/opencode`, undefined, {
      token,
      mode: "openwork",
    });
    options.setClient(activeClient);
    return activeClient;
  };

  const resolveWritableOpenworkTarget = async () => {
    return resolveMcpOpenworkTarget("write");
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
    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveMcpOpenworkTarget("read");
    const canTryOpenworkServer = canUseOpenworkServer;

    recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-check", {
      workspaceType: options.workspaceType(),
      projectDir: projectDir || null,
      openworkStatus: openworkSnapshot.openworkServerStatus,
      hasOpenworkClient: Boolean(openworkClient),
      openworkWorkspaceId: openworkWorkspaceId ?? null,
      canReadMcp: openworkSnapshot.openworkServerCapabilities?.mcp?.read ?? null,
      canTryOpenworkServer,
    });

    if (hasOpenworkTarget && !canTryOpenworkServer) {
      throw new Error("OpenWork server cannot read MCP config for this workspace.");
    }

    if (!canTryOpenworkServer || !openworkClient || !openworkWorkspaceId) return null;

    const response = await openworkClient.listMcp(openworkWorkspaceId);
    const next = response.items.map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
      source: entry.source,
    }));
    const engineSync = response.engineSync ?? null;

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
      engineSyncStatus: engineSync?.status ?? null,
    });

    return { next, nextStatuses, engineSync };
  };

  const resolveDesktopCommand = async (commandName: "getComputerUseMcpCommand" | "getOpenworkUiMcpCommand", fallbackOnError = true) => {
    try {
      const command = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.(commandName);
      if (Array.isArray(command) && command.every((part) => typeof part === "string") && command.length > 0) {
        return command;
      }
    } catch (error) {
      if (!fallbackOnError) {
        throw error instanceof Error
          ? error
          : new Error("Computer Use helper app is unavailable. Restart OpenWork or reinstall the app.");
      }
      // Fall through to the published package command in the manifest/catalog.
    }
    return null;
  };

  const resolveLocalMcpCommand = async (entry: McpDirectoryInfo) => {
    const mcpResource = extensionResource(entry.extensionManifest, "mcp");
    if (mcpResource?.localCommandRef === "openwork.computerUseMcp") {
      const command = await resolveDesktopCommand("getComputerUseMcpCommand", false);
      return command ?? entry.command;
    }
    if (mcpResource?.localCommandRef === "openwork.uiMcp" || entry.serverName === "openwork-ui") {
      const command = await resolveDesktopCommand("getOpenworkUiMcpCommand");
      return command ?? entry.command;
    }
    return entry.command;
  };

  const resolveLocalMcpEnvironment = async (entry: McpDirectoryInfo) => {
    if (entry.serverName !== "openwork-ui") return undefined;
    try {
      const environment = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("getOpenworkUiMcpEnvironment");
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
        // Surface engine registration failures instead of leaving users
        // staring at an MCP that silently shows as disconnected.
        const failedNames = serverResult.engineSync?.status === "failed"
          ? serverResult.engineSync.failures.map((failure) => failure.name).join(", ")
          : "";
        mutateState((current) => ({
          ...current,
          mcpServers: serverResult.next,
          mcpLastUpdatedAt: Date.now(),
          mcpStatuses: serverResult.nextStatuses,
          mcpStatus: failedNames
            ? `Some MCPs could not be registered with the engine: ${failedNames}. They may appear disconnected — try reloading the engine.`
            : serverResult.next.length ? null : "No MCP servers configured yet.",
        }));
        return;
      }
    } catch (error) {
      recordPerfLog(options.developerMode(), "mcp.refresh", "server-path-error", {
        message: error instanceof Error ? error.message : String(error),
      });
      const serverTarget = await resolveMcpOpenworkTarget("read").catch(() => null);
      if (isRemoteWorkspace || serverTarget?.hasOpenworkTarget) {
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
      const fileServers = [
        ...globalServers.filter((entry) => !projectNames.has(entry.name)),
        ...projectServers,
      ];
      // Runtime-DB MCPs (source "config.remote") only exist on the OpenWork
      // server. Keep the last-known entries instead of silently dropping them
      // while the server is briefly unreachable (startup race) — otherwise
      // enabled MCPs like openwork-ui render as "off".
      const fileNames = new Set(fileServers.map((entry) => entry.name));
      const runtimeServers = state.mcpServers.filter(
        (entry) => entry.source === "config.remote" && !fileNames.has(entry.name),
      );
      const next = [...fileServers, ...runtimeServers];

      recordPerfLog(options.developerMode(), "mcp.refresh", "desktop-project-fallback-result", {
        globalConfigPath: globalConfig.path,
        projectConfigPath: projectConfig.path,
        count: next.length,
        names: next.map((entry) => entry.name),
        sources: next.map((entry) => entry.source ?? "unknown"),
      });

      if (!globalConfig.exists && !projectConfig.exists && runtimeServers.length === 0) {
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

  async function connectMcp(entry: McpDirectoryInfo): Promise<boolean> {
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

    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveWritableOpenworkTarget();

    if (isRemoteWorkspace && !canUseOpenworkServer) {
      setStateField("mcpStatus", "OpenWork server unavailable. MCP config is read-only.");
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "openwork-server-unavailable",
      });
      return false;
    }

    if (hasOpenworkTarget && !canUseOpenworkServer) {
      setStateField("mcpStatus", "OpenWork server MCP config is read-only.");
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "openwork-server-read-only",
      });
      return false;
    }

    if (!canUseOpenworkServer && !isDesktopRuntime()) {
      setStateField("mcpStatus", t("mcp.desktop_required"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "desktop-required",
      });
      return false;
    }

    if (!isRemoteWorkspace && !projectDir && !canUseOpenworkServer) {
      setStateField("mcpStatus", t("mcp.pick_workspace_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace",
      });
      return false;
    }

    const activeClient = canUseOpenworkServer ? options.client() ?? await ensureActiveClient().catch(() => null) : await ensureActiveClient();
    if (!activeClient && !canUseOpenworkServer) {
      setStateField("mcpStatus", t("mcp.connect_server_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "no-active-client",
      });
      return false;
    }

    const resolvedProjectDir = activeClient ? await resolveProjectDir(activeClient, projectDir) : projectDir;
    if (!resolvedProjectDir && !canUseOpenworkServer) {
      setStateField("mcpStatus", t("mcp.pick_workspace_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace-after-discovery",
      });
      return false;
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
          const bridgeInfo = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("getUiControlBridgeInfo");
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

      // Signed-in cloud users connect the Den MCPs with a first-party token —
      // no browser OAuth round-trip. Signed-out users fall back to OAuth.
      // The same minted token works for both /mcp (openwork-cloud) and
      // /mcp/admin (openwork-admin); den-api enforces the platform-admin
      // allowlist on the admin endpoint server-side.
      if (entry.serverName === "openwork-cloud" || entry.serverName === "openwork-admin") {
        try {
          const minted = await mintCloudControlMcpToken();
          if (minted) {
            if (entry.serverName === "openwork-cloud") {
              // Never trust `minted.resource` verbatim: older den-api builds
              // mint the bare web-app origin (https://app.openworklabs.com/mcp)
              // where MCP 404s. Heal it, falling back to the entry's
              // bootstrap-derived URL.
              resolvedUrl = resolveCloudMcpResourceUrl(minted.resource) ?? resolvedUrl;
            }
            resolvedHeaders = { Authorization: `Bearer ${minted.token}` };
          }
        } catch {
          // Minting failed (offline, expired session) — fall back to OAuth.
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
          // Header-authed entries must not trigger OAuth auto-detection;
          // otherwise opencode reports "needs_auth" despite valid headers.
          mcpEntryConfig["oauth"] = false;
        }
        if (!resolvedHeaders) {
          if (entry.oauthConfig) {
            mcpEntryConfig["oauth"] = entry.oauthConfig;
          } else if (entry.oauth) {
            mcpEntryConfig["oauth"] = {};
          }
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
        if (!activeClient || !resolvedProjectDir) {
          throw new Error(t("mcp.connect_server_first"));
        }
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
        if (!activeClient || !resolvedProjectDir) {
          throw new Error(t("mcp.connect_server_first"));
        }
        const mcpAddConfig =
          entryType === "remote"
            ? {
                type: "remote" as const,
                url: resolvedUrl ?? entry.url!,
                enabled: true,
                ...(resolvedHeaders ? { headers: resolvedHeaders, oauth: false as const } : {}),
                ...(!resolvedHeaders && entry.oauthConfig ? { oauth: entry.oauthConfig } : {}),
                ...(!resolvedHeaders && !entry.oauthConfig && entry.oauth ? { oauth: {} } : {}),
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

      // OAuth is auto-detected: open the sign-in modal when the directory
      // entry declares OAuth up front, or when the engine reports the fresh
      // remote entry as needing auth. Custom apps no longer ask the user to
      // know whether their server uses OAuth.
      let needsAuth = Boolean(entry.oauth) && !resolvedHeaders;
      if (!needsAuth && entryType === "remote" && !resolvedHeaders) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const detected = snapshot.mcpStatuses[slug]?.status;
          if (detected === "needs_auth" || detected === "needs_client_registration") {
            needsAuth = true;
            break;
          }
          if (detected === "connected" || detected === "failed" || detected === "disabled") break;
          await new Promise((resolve) => setTimeout(resolve, 500));
          await refreshMcpServers();
        }
      }

      if (needsAuth) {
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
      return true;
    } catch (error) {
      console.error("[mcp.connect] failed", entry.name, error);
      setStateField(
        "mcpStatus",
        error instanceof Error ? error.message : t("mcp.connect_failed"),
      );
      finishPerf(options.developerMode(), "mcp.connect", "error", startedAt, {
        name: entry.name,
        type: entryType,
        error: error instanceof Error ? error.message : safeStringify(error),
      });
      return false;
    } finally {
      setStateField("mcpConnectingName", null);
    }
  }

  // Guards the unhealthy-status self-heal in syncCloudControlMcp: each
  // re-mint writes a new token to config, which marks an engine reload as
  // required. Until that reload happens the status stays needs_auth, so
  // retrying on every sync tick produced an endless "MCP 'openwork-cloud'
  // was updated. Reload to connect." nag. One attempt per unhealthy episode;
  // reset when the entry reports connected again.
  let cloudMcpUnhealthyRemintAttempted = false;

  /**
   * Background reconciliation for the Den cloud MCP: when the desktop is
   * signed in to OpenWork Cloud with an active org, keep the
   * `openwork-cloud` MCP entry configured with a fresh first-party token.
   * Quiet by design — a failed mint never opens the OAuth modal.
   */
  async function syncCloudControlMcp(): Promise<"synced" | "unchanged" | "skipped"> {
    const settings = readDenSettings();
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!orgId || !settings.authToken?.trim()) return "skipped";

    const entry = MCP_QUICK_CONNECT.find((candidate) => candidate.serverName === "openwork-cloud");
    if (!entry) return "skipped";
    const slug = entry.id ?? getMcpServerName(entry);

    const marker = readCloudMcpSyncMarker();
    const markerFresh =
      marker !== null &&
      marker.orgId === orgId &&
      new Date(marker.expiresAt).getTime() - Date.now() > CLOUD_MCP_REFRESH_MARGIN_MS;

    // A revoked/expired token surfaces as needs_auth or failed from opencode;
    // while signed in, that means re-mint instead of standing pat — but only
    // once per unhealthy episode (see cloudMcpUnhealthyRemintAttempted).
    const entryStatus = snapshot.mcpStatuses[slug]?.status;
    if (entryStatus === "connected") {
      cloudMcpUnhealthyRemintAttempted = false;
    }
    const entryUnhealthy = entryStatus === "needs_auth" || entryStatus === "failed";
    const shouldRemintForHealth = entryUnhealthy && !cloudMcpUnhealthyRemintAttempted;

    // Builds before #2116's follow-up wrote the MCP URL against the bare
    // web-app origin (https://app.openworklabs.com/mcp), which 404s.
    // Reconfigure those entries even when the marker is still fresh.
    const configuredEntry = snapshot.mcpServers.find((server) => server.name === slug);
    const hasLegacyUrl =
      configuredEntry?.config.type === "remote" && isLegacyWebAppMcpUrl(configuredEntry.config.url);

    // The marker is the source of truth for "configured recently". Do NOT
    // gate this on snapshot.mcpServers: the store is recreated on every
    // settings mount with an empty (or refresh-errored) server list, and
    // treating that as "not configured" re-minted a token and rewrote config
    // on every visit — endless "Reload to connect" toasts. If a user
    // manually removed the entry, we respect that until the marker expires
    // instead of silently re-adding it.
    if (markerFresh && !shouldRemintForHealth && !hasLegacyUrl) {
      return "unchanged";
    }
    if (shouldRemintForHealth) {
      cloudMcpUnhealthyRemintAttempted = true;
    }

    // Validate the session up front so a failed mint never reaches
    // connectMcp's signed-out fallback (which opens the OAuth modal).
    const minted = await mintCloudControlMcpToken().catch(() => null);
    if (!minted) return "skipped";

    // Trust connectMcp's own result. Judging success via snapshot.mcpServers
    // broke whenever the post-connect refresh errored: the marker was never
    // written, so every subsequent tick re-minted and re-wrote config.
    const connected = await connectMcp(entry);
    if (!connected) {
      return "skipped";
    }
    writeCloudMcpSyncMarker({ orgId, expiresAt: minted.expiresAt });
    return "synced";
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

    const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
      await resolveWritableOpenworkTarget();

    if (isRemoteWorkspace && !canUseOpenworkServer) {
      setStateField("mcpStatus", "OpenWork server unavailable. MCP auth is read-only.");
      return;
    }

    if (hasOpenworkTarget && !canUseOpenworkServer) {
      setStateField("mcpStatus", "OpenWork server MCP auth is read-only.");
      return;
    }

    if (!canUseOpenworkServer && !isDesktopRuntime()) {
      setStateField("mcpStatus", t("mcp.desktop_required"));
      return;
    }

    const activeClient = canUseOpenworkServer ? options.client() : await ensureActiveClient();
    if (!activeClient && !canUseOpenworkServer) {
      setStateField("mcpStatus", t("mcp.connect_server_first"));
      return;
    }

    const resolvedProjectDir = activeClient ? await resolveProjectDir(activeClient, projectDir) : projectDir;
    if (!resolvedProjectDir && !canUseOpenworkServer) {
      setStateField("mcpStatus", t("mcp.pick_workspace_first"));
      return;
    }

    const safeName = validateMcpServerName(name);
    setStateField("mcpStatus", null);

    try {
      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        await openworkClient.logoutMcpAuth(openworkWorkspaceId, safeName);
      } else {
        if (!activeClient || !resolvedProjectDir) {
          throw new Error(t("mcp.connect_server_first"));
        }
        try {
          await activeClient.mcp.disconnect({ directory: resolvedProjectDir, name: safeName });
        } catch {
          // ignore
        }
        await activeClient.mcp.auth.remove({ directory: resolvedProjectDir, name: safeName });
      }

      try {
        if (activeClient && resolvedProjectDir) {
          const status = unwrap(await activeClient.mcp.status({ directory: resolvedProjectDir }));
          setStateField("mcpStatuses", status as McpStatusMap);
        }
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

      const { openworkClient, openworkWorkspaceId, hasOpenworkTarget, canUseOpenworkServer } =
        await resolveWritableOpenworkTarget();

      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        await openworkClient.removeMcp(openworkWorkspaceId, name);
      } else {
        if (hasOpenworkTarget) {
          setStateField("mcpStatus", "OpenWork server MCP config is read-only.");
          return;
        }
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
      const { openworkClient, openworkWorkspaceId, canUseOpenworkServer } =
        await resolveWritableOpenworkTarget();

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

    if (!started || disposed || !changed) {
      return;
    }

    if (!isDesktopRuntime() && getOpenworkSnapshot().openworkServerStatus !== "connected") {
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
    syncCloudControlMcp,
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
