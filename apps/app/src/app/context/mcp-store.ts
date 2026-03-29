import { createSignal, type Accessor } from "solid-js";

import { homeDir } from "@tauri-apps/api/path";
import { parse } from "jsonc-parser";

import { currentLocale, t } from "../../i18n";
import type { McpDirectoryInfo } from "../constants";
import { CHROME_DEVTOOLS_MCP_ID, MCP_QUICK_CONNECT } from "../constants";
import type { OpenworkServerCapabilities, OpenworkServerClient, OpenworkServerStatus } from "../lib/openwork-server";
import { createClient, type OpencodeAuth, unwrap } from "../lib/opencode";
import { finishPerf, perfNow, recordPerfLog } from "../lib/perf-log";
import { readOpencodeConfig, writeOpencodeConfig } from "../lib/tauri";
import { parseMcpServersFromContent, removeMcpFromConfig, usesChromeDevtoolsAutoConnect, validateMcpServerName } from "../mcp";
import type { Client, McpServerEntry, McpStatusMap, ReloadReason, ReloadTrigger } from "../types";
import { isTauriRuntime, normalizeDirectoryQueryPath, safeStringify } from "../utils";

export type McpStore = ReturnType<typeof createMcpStore>;

export function createMcpStore(options: {
  client: Accessor<Client | null>;
  setClient: (value: Client | null) => void;
  developerMode: Accessor<boolean>;
  workspaceProjectDir: Accessor<string>;
  setWorkspaceProjectDir: (value: string) => void;
  selectedWorkspaceType: Accessor<"local" | "remote">;
  runtimeWorkspaceId: Accessor<string | null>;
  ensureRuntimeWorkspaceId: () => Promise<string | null>;
  openworkServerClient: Accessor<OpenworkServerClient | null>;
  openworkServerStatus: Accessor<OpenworkServerStatus>;
  openworkServerCapabilities: Accessor<OpenworkServerCapabilities | null>;
  openworkServerBaseUrl: Accessor<string>;
  openworkServerAuth: Accessor<OpencodeAuth>;
  markReloadRequired: (reason: ReloadReason, trigger?: ReloadTrigger) => void;
}) {
  const [mcpServers, setMcpServers] = createSignal<McpServerEntry[]>([]);
  const [mcpStatus, setMcpStatus] = createSignal<string | null>(null);
  const [mcpLastUpdatedAt, setMcpLastUpdatedAt] = createSignal<number | null>(null);
  const [mcpStatuses, setMcpStatuses] = createSignal<McpStatusMap>({});
  const [mcpConnectingName, setMcpConnectingName] = createSignal<string | null>(null);
  const [selectedMcp, setSelectedMcp] = createSignal<string | null>(null);
  const [mcpAuthModalOpen, setMcpAuthModalOpen] = createSignal(false);
  const [mcpAuthEntry, setMcpAuthEntry] = createSignal<McpDirectoryInfo | null>(null);
  const [mcpAuthNeedsReload, setMcpAuthNeedsReload] = createSignal(false);

  const filterConfiguredStatuses = (status: McpStatusMap, entries: McpServerEntry[]) => {
    const configured = new Set(entries.map((entry) => entry.name));
    return Object.fromEntries(
      Object.entries(status).filter(([name]) => configured.has(name)),
    ) as McpStatusMap;
  };

  const mapOpenworkEntries = (clientEntries: Awaited<ReturnType<OpenworkServerClient["listMcp"]>>["items"]) =>
    clientEntries.map((entry) => ({
      name: entry.name,
      config: entry.config as McpServerEntry["config"],
    }));

  const getOpenworkAccess = (mode: "read" | "write") => {
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    const allowed = mode === "write" ? openworkCapabilities?.mcp?.write : openworkCapabilities?.mcp?.read;
    return {
      openworkClient,
      openworkWorkspaceId,
      canUseOpenworkServer:
        options.openworkServerStatus() === "connected" &&
        Boolean(openworkClient) &&
        Boolean(openworkWorkspaceId) &&
        Boolean(allowed),
    };
  };

  const ensureActiveClient = () => {
    const activeClient = options.client();
    if (activeClient) return activeClient;

    const openworkBaseUrl = options.openworkServerBaseUrl().trim();
    const auth = options.openworkServerAuth();
    if (!openworkBaseUrl || !auth.token) {
      return null;
    }

    const nextClient = createClient(`${openworkBaseUrl.replace(/\/+$/, "")}/opencode`, undefined, {
      token: auth.token,
      mode: "openwork",
    });
    options.setClient(nextClient);
    return nextClient;
  };

  const ensureProjectDirectory = async (activeClient: Client, initialProjectDir: string) => {
    let resolvedProjectDir = initialProjectDir;
    if (!resolvedProjectDir) {
      try {
        const pathInfo = unwrap(await activeClient.path.get());
        const discoveredRaw = normalizeDirectoryQueryPath(pathInfo.directory ?? "");
        const discovered = discoveredRaw.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
        if (discovered) {
          resolvedProjectDir = discovered;
          options.setWorkspaceProjectDir(discovered);
        }
      } catch {
        // ignore
      }
    }
    return resolvedProjectDir;
  };

  async function refreshMcpServers() {
    const projectDir = options.workspaceProjectDir().trim();
    const isRemoteWorkspace = options.selectedWorkspaceType() === "remote";
    const isLocalWorkspace = !isRemoteWorkspace;
    const { openworkClient, openworkWorkspaceId, canUseOpenworkServer } = getOpenworkAccess("read");

    if (isRemoteWorkspace) {
      if (!canUseOpenworkServer || !openworkClient || !openworkWorkspaceId) {
        setMcpStatus("OpenWork server unavailable. MCP config is read-only.");
        setMcpServers([]);
        setMcpStatuses({});
        return;
      }

      try {
        setMcpStatus(null);
        const next = mapOpenworkEntries((await openworkClient.listMcp(openworkWorkspaceId)).items);
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
      } catch (error) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus(error instanceof Error ? error.message : "Failed to load MCP servers");
      }
      return;
    }

    if (isLocalWorkspace && canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
      try {
        setMcpStatus(null);
        const next = mapOpenworkEntries((await openworkClient.listMcp(openworkWorkspaceId)).items);
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
      } catch (error) {
        setMcpServers([]);
        setMcpStatuses({});
        setMcpStatus(error instanceof Error ? error.message : "Failed to load MCP servers");
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
    } catch (error) {
      setMcpServers([]);
      setMcpStatuses({});
      setMcpStatus(error instanceof Error ? error.message : "Failed to load MCP servers");
    }
  }

  async function connectMcp(entry: McpDirectoryInfo) {
    const startedAt = perfNow();
    const isRemoteWorkspace =
      options.selectedWorkspaceType() === "remote" ||
      (!isTauriRuntime() && options.openworkServerStatus() === "connected");
    const projectDir = options.workspaceProjectDir().trim();
    const entryType = entry.type ?? "remote";

    recordPerfLog(options.developerMode(), "mcp.connect", "start", {
      name: entry.name,
      type: entryType,
      workspaceType: isRemoteWorkspace ? "remote" : "local",
      projectDir: projectDir || null,
    });

    const openworkClient = options.openworkServerClient();
    let openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    if (!openworkWorkspaceId && openworkClient && options.openworkServerStatus() === "connected") {
      openworkWorkspaceId = await options.ensureRuntimeWorkspaceId();
    }
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      Boolean(openworkClient) &&
      Boolean(openworkWorkspaceId) &&
      Boolean(openworkCapabilities?.mcp?.write);

    if (isRemoteWorkspace && !canUseOpenworkServer) {
      setMcpStatus("OpenWork server unavailable. MCP config is read-only.");
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "openwork-server-unavailable",
      });
      return;
    }

    if (!canUseOpenworkServer && !isTauriRuntime()) {
      setMcpStatus(t("mcp.desktop_required", currentLocale()));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "desktop-required",
      });
      return;
    }

    if (!isRemoteWorkspace && !projectDir) {
      setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "missing-workspace",
      });
      return;
    }

    const activeClient = ensureActiveClient();
    if (!activeClient) {
      setMcpStatus(t("mcp.connect_server_first", currentLocale()));
      finishPerf(options.developerMode(), "mcp.connect", "blocked", startedAt, {
        reason: "no-active-client",
      });
      return;
    }

    const resolvedProjectDir = await ensureProjectDirectory(activeClient, projectDir);
    if (!resolvedProjectDir) {
      setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
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

        if (
          slug === CHROME_DEVTOOLS_MCP_ID &&
          usesChromeDevtoolsAutoConnect(entry.command) &&
          isTauriRuntime()
        ) {
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
          } catch (error) {
            recordPerfLog(options.developerMode(), "mcp.connect", "config-parse-failed", {
              error: error instanceof Error ? error.message : String(error),
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
      options.markReloadRequired("mcp", { type: "mcp", name: slug, action });
      await refreshMcpServers();

      if (entry.oauth) {
        setMcpAuthEntry(entry);
        setMcpAuthNeedsReload(true);
        setMcpAuthModalOpen(true);
      } else {
        setMcpStatus(t("mcp.connected", currentLocale()));
      }

      await refreshMcpServers();
      finishPerf(options.developerMode(), "mcp.connect", "done", startedAt, {
        name: entry.name,
        type: entryType,
        slug,
      });
    } catch (error) {
      setMcpStatus(error instanceof Error ? error.message : t("mcp.connect_failed", currentLocale()));
      finishPerf(options.developerMode(), "mcp.connect", "error", startedAt, {
        name: entry.name,
        type: entryType,
        error: error instanceof Error ? error.message : safeStringify(error),
      });
    } finally {
      setMcpConnectingName(null);
    }
  }

  function authorizeMcp(entry: McpServerEntry) {
    if (entry.config.type !== "remote" || entry.config.oauth === false) {
      setMcpStatus(t("mcp.login_unavailable", currentLocale()));
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
      options.selectedWorkspaceType() === "remote" ||
      (!isTauriRuntime() && options.openworkServerStatus() === "connected");
    const projectDir = options.workspaceProjectDir().trim();

    const openworkClient = options.openworkServerClient();
    let openworkWorkspaceId = options.runtimeWorkspaceId();
    const openworkCapabilities = options.openworkServerCapabilities();
    if (!openworkWorkspaceId && openworkClient && options.openworkServerStatus() === "connected") {
      openworkWorkspaceId = await options.ensureRuntimeWorkspaceId();
    }
    const canUseOpenworkServer =
      options.openworkServerStatus() === "connected" &&
      Boolean(openworkClient) &&
      Boolean(openworkWorkspaceId) &&
      Boolean(openworkCapabilities?.mcp?.write);

    if (isRemoteWorkspace && !canUseOpenworkServer) {
      setMcpStatus("OpenWork server unavailable. MCP auth is read-only.");
      return;
    }

    if (!canUseOpenworkServer && !isTauriRuntime()) {
      setMcpStatus(t("mcp.desktop_required", currentLocale()));
      return;
    }

    const activeClient = ensureActiveClient();
    if (!activeClient) {
      setMcpStatus(t("mcp.connect_server_first", currentLocale()));
      return;
    }

    const resolvedProjectDir = await ensureProjectDirectory(activeClient, projectDir);
    if (!resolvedProjectDir) {
      setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
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
      setMcpStatus(t("mcp.logout_success", currentLocale()).replace("{server}", safeName));
    } catch (error) {
      setMcpStatus(error instanceof Error ? error.message : t("mcp.logout_failed", currentLocale()));
    }
  }

  async function removeMcp(name: string) {
    try {
      setMcpStatus(null);

      const { openworkClient, openworkWorkspaceId, canUseOpenworkServer } = getOpenworkAccess("write");

      if (canUseOpenworkServer && openworkClient && openworkWorkspaceId) {
        await openworkClient.removeMcp(openworkWorkspaceId, name);
      } else {
        const projectDir = options.workspaceProjectDir().trim();
        if (!projectDir) {
          setMcpStatus(t("mcp.pick_workspace_first", currentLocale()));
          return;
        }
        await removeMcpFromConfig(projectDir, name);
      }

      options.markReloadRequired("mcp", { type: "mcp", name, action: "removed" });
      await refreshMcpServers();
      if (selectedMcp() === name) {
        setSelectedMcp(null);
      }
      setMcpStatus(null);
    } catch (error) {
      setMcpStatus(error instanceof Error ? error.message : t("mcp.remove_failed", currentLocale()));
    }
  }

  const closeMcpAuthModal = () => {
    setMcpAuthModalOpen(false);
    setMcpAuthEntry(null);
    setMcpAuthNeedsReload(false);
  };

  const completeMcpAuthModal = async () => {
    closeMcpAuthModal();
    await refreshMcpServers();
  };

  return {
    mcpServers,
    mcpStatus,
    mcpLastUpdatedAt,
    mcpStatuses,
    mcpConnectingName,
    selectedMcp,
    setSelectedMcp,
    mcpAuthModalOpen,
    mcpAuthEntry,
    mcpAuthNeedsReload,
    refreshMcpServers,
    connectMcp,
    authorizeMcp,
    logoutMcpAuth,
    removeMcp,
    closeMcpAuthModal,
    completeMcpAuthModal,
  };
}
