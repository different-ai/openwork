import { createEffect, createSignal } from "solid-js";

import { homeDir } from "@tauri-apps/api/path";
import { parse } from "jsonc-parser";

import { currentLocale, t } from "../../i18n";
import { CHROME_DEVTOOLS_MCP_ID, MCP_QUICK_CONNECT, type McpDirectoryInfo } from "../constants";
import { createClient, unwrap } from "../lib/opencode";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";
import { readOpencodeConfig, writeOpencodeConfig, type OpencodeConfigFile } from "../lib/tauri";
import {
  parseMcpServersFromContent,
  removeMcpFromConfig,
  usesChromeDevtoolsAutoConnect,
  validateMcpServerName,
} from "../mcp";
import type { Client, McpServerEntry, McpStatusMap, ReloadReason, ReloadTrigger } from "../types";
import { toSessionTransportDirectory } from "../lib/session-scope";
import { isTauriRuntime, safeStringify } from "../utils";
import { createWorkspaceContextKey } from "../context/workspace-context";
import type { OpenworkServerStore } from "./openwork-server-store";

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
  const translate = (key: string) => t(key, currentLocale());

  const [mcpServers, setMcpServers] = createSignal<McpServerEntry[]>([]);
  const [mcpStatus, setMcpStatus] = createSignal<string | null>(null);
  const [mcpLastUpdatedAt, setMcpLastUpdatedAt] = createSignal<number | null>(null);
  const [mcpStatuses, setMcpStatuses] = createSignal<McpStatusMap>({});
  const [mcpConnectingName, setMcpConnectingName] = createSignal<string | null>(null);
  const [selectedMcp, setSelectedMcp] = createSignal<string | null>(null);

  const [mcpAuthModalOpen, setMcpAuthModalOpen] = createSignal(false);
  const [mcpAuthEntry, setMcpAuthEntry] = createSignal<McpDirectoryInfo | null>(null);
  const [mcpAuthNeedsReload, setMcpAuthNeedsReload] = createSignal(false);

  const workspaceContextKey = createWorkspaceContextKey({
    selectedWorkspaceId: options.selectedWorkspaceId,
    selectedWorkspaceRoot: options.selectedWorkspaceRoot,
    runtimeWorkspaceId: options.runtimeWorkspaceId,
    workspaceType: options.workspaceType,
  });

  const filterConfiguredStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
    const configured = new Set(entries.map((entry) => entry.name));
    return Object.fromEntries(Object.entries(status).filter(([name]) => configured.has(name))) as McpStatusMap;
  };

  const readMcpConfigFile = async (scope: "project" | "global"): Promise<OpencodeConfigFile | null> => {
    const projectDir = options.projectDir().trim();
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      options.openworkServer.openworkServerCapabilities()?.config?.read;

    if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
      return openworkClient.readOpencodeConfigFile(openworkWorkspaceId, scope);
    }

    if (!isTauriRuntime()) {
      return null;
    }

    return readOpencodeConfig(scope, projectDir);
  };

  const ensureActiveClient = async () => {
    let activeClient = options.client();
    if (activeClient) {
      return activeClient;
    }

    const openworkBaseUrl = options.openworkServer.openworkServerBaseUrl().trim();
    const token = options.openworkServer.openworkServerAuth().token?.trim();
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
    const openworkClient = options.openworkServer.openworkServerClient();
    let openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServer.openworkServerCapabilities();
    if (!openworkWorkspaceId && openworkClient && options.openworkServer.openworkServerStatus() === "connected") {
      openworkWorkspaceId = (await options.ensureRuntimeWorkspaceId?.()) ?? null;
    }

    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
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
    const projectDir = options.projectDir().trim();
    const isRemoteWorkspace = options.workspaceType() === "remote";
    const isLocalWorkspace = !isRemoteWorkspace;
    const openworkClient = options.openworkServer.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canUseOpenworkServer =
      options.openworkServer.openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      options.openworkServer.openworkServerCapabilities()?.mcp?.read;

    if (isRemoteWorkspace) {
      if (!canUseOpenworkServer) {
        setMcpStatus("OpenWork server unavailable. MCP config is read-only.");
        setMcpServers([]);
        setMcpStatuses({});
        return;
      }

      try {
        setMcpStatus(null);
        const response = await openworkClient.listMcp(openworkWorkspaceId);
        const next = response.items.map((entry) => ({
          name: entry.name,
          config: entry.config as McpServerEntry["config"],
        }));
        setMcpServers(next);
        setMcpLastUpdatedAt(Date.now());

        const activeClient = options.client();
        if (activeClient && projectDir) {
          try {
            const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
            setMcpStatuses(filterConfiguredStatuses(status as McpStatusMap, next));
          } catch {
            setMcpStatuses({});
          }
        } else {
          setMcpStatuses({});
        }

        if (!next.length) {
          setMcpStatus("No MCP servers configured yet.");
        }
      } catch (e) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus(e instanceof Error ? e.message : "Failed to load MCP servers");
      }
      return;
    }

    if (isLocalWorkspace && canUseOpenworkServer) {
      try {
        setMcpStatus(null);
        const response = await openworkClient.listMcp(openworkWorkspaceId);
        const next = response.items.map((entry) => ({
          name: entry.name,
          config: entry.config as McpServerEntry["config"],
        }));
        setMcpServers(next);
        setMcpLastUpdatedAt(Date.now());

        const activeClient = options.client();
        if (activeClient && projectDir) {
          try {
            const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
            setMcpStatuses(filterConfiguredStatuses(status as McpStatusMap, next));
          } catch {
            setMcpStatuses({});
          }
        } else {
          setMcpStatuses({});
        }

        if (!next.length) {
          setMcpStatus("No MCP servers configured yet.");
        }
      } catch (e) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus(e instanceof Error ? e.message : "Failed to load MCP servers");
      }
      return;
    }

    if (!isTauriRuntime()) {
      setMcpStatus("MCP configuration is only available for local workspaces.");
      setMcpServers([]);
      setMcpStatuses({});
      return;
    }

    if (!projectDir) {
      setMcpStatus("Pick a workspace folder to load MCP servers.");
      setMcpServers([]);
      setMcpStatuses({});
      return;
    }

    try {
      setMcpStatus(null);
      const config = await readOpencodeConfig("project", projectDir);
      if (!config.exists || !config.content) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus("No opencode.json found yet. Create one by connecting an MCP.");
        return;
      }

      const next = parseMcpServersFromContent(config.content);
      setMcpServers(next);
      setMcpLastUpdatedAt(Date.now());

      const activeClient = options.client();
      if (activeClient) {
        try {
          const status = unwrap(await activeClient.mcp.status({ directory: projectDir }));
          setMcpStatuses(filterConfiguredStatuses(status as McpStatusMap, next));
        } catch {
          setMcpStatuses({});
        }
      }

      if (!next.length) {
        setMcpStatus("No MCP servers configured yet.");
      }
    } catch (e) {
      setMcpServers([]);
      setMcpStatuses({});
      setMcpStatus(e instanceof Error ? e.message : "Failed to load MCP servers");
    }
  }

  async function connectMcp(entry: McpDirectoryInfo) {
    const startedAt = perfNow();
    const isRemoteWorkspace =
      options.workspaceType() === "remote" ||
      (!isTauriRuntime() && options.openworkServer.openworkServerStatus() === "connected");
    const projectDir = options.projectDir().trim();
    const entryType = entry.type ?? "remote";

    recordPerfLog(options.developerMode(), "mcp.connect", "start", {
      name: entry.name,
      type: entryType,
      workspaceType: isRemoteWorkspace ? "remote" : "local",
      projectDir: projectDir || null,
    });

    const { openworkClient, openworkWorkspaceId, canUseOpenworkServer } = await resolveWritableOpenworkTarget();

    if (isRemoteWorkspace && !canUseOpenworkServer) {
      setMcpStatus("OpenWork server unavailable. MCP config is read-only.");
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "openwork-server-unavailable",
      });
      return;
    }

    if (!canUseOpenworkServer && !isTauriRuntime()) {
      setMcpStatus(translate("mcp.desktop_required"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "desktop-required",
      });
      return;
    }

    if (!isRemoteWorkspace && !projectDir) {
      setMcpStatus(translate("mcp.pick_workspace_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace",
      });
      return;
    }

    const activeClient = await ensureActiveClient();
    if (!activeClient) {
      setMcpStatus(translate("mcp.connect_server_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "no-active-client",
      });
      return;
    }

    const resolvedProjectDir = await resolveProjectDir(activeClient, projectDir);
    if (!resolvedProjectDir) {
      setMcpStatus(translate("mcp.pick_workspace_first"));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace-after-discovery",
      });
      return;
    }

    const slug = entry.id ?? entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const action = mcpServers().some((server) => server.name === slug) ? "updated" : "added";

    try {
      setMcpStatus(null);
      setMcpConnectingName(entry.name);

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

        if (slug === CHROME_DEVTOOLS_MCP_ID && usesChromeDevtoolsAutoConnect(entry.command) && isTauriRuntime()) {
          try {
            const hostHome = (await homeDir()).replace(/[\\/]+$/, "");
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

      setMcpStatuses(status as McpStatusMap);
      options.markReloadRequired?.("mcp", { type: "mcp", name: slug, action });
      await refreshMcpServers();

      if (entry.oauth) {
        setMcpAuthEntry(entry);
        setMcpAuthNeedsReload(true);
        setMcpAuthModalOpen(true);
      } else {
        setMcpStatus(translate("mcp.connected"));
      }

      await refreshMcpServers();
      finishPerf(options.developerMode(), "mcp.connect", "done", startedAt, {
        name: entry.name,
        type: entryType,
        slug,
      });
    } catch (e) {
      setMcpStatus(e instanceof Error ? e.message : translate("mcp.connect_failed"));
      finishPerf(options.developerMode(), "mcp.connect", "error", startedAt, {
        name: entry.name,
        type: entryType,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
    } finally {
      setMcpConnectingName(null);
    }
  }

  function authorizeMcp(entry: McpServerEntry) {
    if (entry.config.type !== "remote" || entry.config.oauth === false) {
      setMcpStatus(translate("mcp.login_unavailable"));
      return;
    }

    const matchingQuickConnect = MCP_QUICK_CONNECT.find((candidate) => {
      const candidateSlug = candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return candidateSlug === entry.name || candidate.name === entry.name;
    });

    setMcpAuthEntry(
      matchingQuickConnect ?? {
        name: entry.name,
        description: "",
        type: "remote",
        url: entry.config.url,
        oauth: true,
      },
    );
    setMcpAuthNeedsReload(false);
    setMcpAuthModalOpen(true);
  }

  async function logoutMcpAuth(name: string) {
    const isRemoteWorkspace =
      options.workspaceType() === "remote" ||
      (!isTauriRuntime() && options.openworkServer.openworkServerStatus() === "connected");
    const projectDir = options.projectDir().trim();

    const { openworkClient, openworkWorkspaceId, canUseOpenworkServer } = await resolveWritableOpenworkTarget();

    if (isRemoteWorkspace && !canUseOpenworkServer) {
      setMcpStatus("OpenWork server unavailable. MCP auth is read-only.");
      return;
    }

    if (!canUseOpenworkServer && !isTauriRuntime()) {
      setMcpStatus(translate("mcp.desktop_required"));
      return;
    }

    const activeClient = await ensureActiveClient();
    if (!activeClient) {
      setMcpStatus(translate("mcp.connect_server_first"));
      return;
    }

    const resolvedProjectDir = await resolveProjectDir(activeClient, projectDir);
    if (!resolvedProjectDir) {
      setMcpStatus(translate("mcp.pick_workspace_first"));
      return;
    }

    const safeName = validateMcpServerName(name);
    setMcpStatus(null);

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
        setMcpStatuses(status as McpStatusMap);
      } catch {
        // ignore
      }

      await refreshMcpServers();
      setMcpStatus(translate("mcp.logout_success").replace("{server}", safeName));
    } catch (e) {
      setMcpStatus(e instanceof Error ? e.message : translate("mcp.logout_failed"));
    }
  }

  async function removeMcp(name: string) {
    try {
      setMcpStatus(null);

      const openworkClient = options.openworkServer.openworkServerClient();
      const openworkWorkspaceId = options.runtimeWorkspaceId();
      const canUseOpenworkServer =
        options.openworkServer.openworkServerStatus() === "connected" &&
        openworkClient &&
        openworkWorkspaceId &&
        options.openworkServer.openworkServerCapabilities()?.mcp?.write;

      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        await openworkClient.removeMcp(openworkWorkspaceId, name);
      } else {
        const projectDir = options.projectDir().trim();
        if (!projectDir) {
          setMcpStatus(translate("mcp.pick_workspace_first"));
          return;
        }
        await removeMcpFromConfig(projectDir, name);
      }

      options.markReloadRequired?.("mcp", { type: "mcp", name, action: "removed" });
      await refreshMcpServers();
      if (selectedMcp() === name) {
        setSelectedMcp(null);
      }
      setMcpStatus(null);
    } catch (e) {
      setMcpStatus(e instanceof Error ? e.message : translate("mcp.remove_failed"));
    }
  }

  function closeMcpAuthModal() {
    setMcpAuthModalOpen(false);
    setMcpAuthEntry(null);
    setMcpAuthNeedsReload(false);
  }

  async function completeMcpAuthModal() {
    closeMcpAuthModal();
    await refreshMcpServers();
  }

  createEffect(() => {
    if (!isTauriRuntime()) return;
    workspaceContextKey();
    options.projectDir();
    void refreshMcpServers();
  });

  return {
    mcpServers,
    mcpStatus,
    mcpLastUpdatedAt,
    mcpStatuses,
    mcpConnectingName,
    selectedMcp,
    setSelectedMcp,
    quickConnect: MCP_QUICK_CONNECT,
    readMcpConfigFile,
    refreshMcpServers,
    connectMcp,
    authorizeMcp,
    logoutMcpAuth,
    removeMcp,
    mcpAuthModalOpen,
    mcpAuthEntry,
    mcpAuthNeedsReload,
    closeMcpAuthModal,
    completeMcpAuthModal,
  };
}
