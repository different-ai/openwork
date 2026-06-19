/** @jsxImportSource react */
import { useEffect, useReducer, useRef, useState, type SetStateAction } from "react";
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Cloud,
  Code2,
  CreditCard,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Loader2,
  MonitorSmartphone,
  Plug2,
  Plus,
  Power,
  Search,
  Settings2,
  Unplug,
  Zap,
} from "lucide-react";

import { isBuiltInOpenWorkExtension, getMcpServerName, type McpDirectoryInfo } from "../../../../app/constants";
import { evaluateEnablement } from "../../../../app/enablement";
import type { EnablementResult } from "../../../../app/extensions";
import type { CloudImportedPlugin } from "../../../../app/cloud/import-state";
import { ExtensionCard } from "../../../design-system/extension-card";
import { ExtensionDetailModal } from "../../../design-system/extension-detail-modal";
import {
  openDesktopPath,
  readOpencodeConfig,
  revealDesktopItemInDir,
  type OpencodeConfigFile,
} from "../../../../app/lib/desktop";
import {
  getMcpIdentityKey,
  normalizeMcpSlug,
} from "../../../../app/mcp";
import type { McpServerEntry, McpStatusMap } from "../../../../app/types";
import { formatRelativeTime, isDesktopRuntime, isWindowsPlatform } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { AddMcpModal } from "../../connections/modals/add-mcp-modal";
import { ClaudePluginImportModal } from "../../connections/modals/claude-plugin-import-modal";
import type { OpenworkClaudePluginPreview } from "../../../../app/lib/openwork-server";
import {
  isOpenWorkExtensionEnabled,
  isOpenWorkExtensionHidden,
  OPENWORK_EXTENSION_STATE_CHANGED,
  setOpenWorkExtensionEnabled,
  setOpenWorkExtensionHidden,
} from "../extension-state";
import {
  initialMcpViewLocalState,
  mcpViewLocalReducer,
  type ConfigScope,
  type McpViewLocalState,
} from "./mcp-view-state";

export type ReactMcpStatus =
  | "connected"
  | "needs_auth"
  | "needs_client_registration"
  | "failed"
  | "disabled"
  | "disconnected";

export type SkillItem = {
  name: string;
  description?: string;
  trigger?: string;
  path: string;
};

const getSkillHiddenId = (skill: SkillItem) => `skill:${skill.name}`;

export type McpViewProps = {
  busy: boolean;
  selectedWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  /** Installed skills to render alongside MCPs in the grid. */
  installedSkills?: SkillItem[];
  /** Installed marketplace packages to render alongside runtime extensions. */
  installedPlugins?: CloudImportedPlugin[];
  /** Uninstall a skill by name. */
  uninstallSkill?: (name: string) => void;
  /** Remove an imported marketplace package by plugin id. */
  removeCloudPlugin?: (pluginId: string) => void | Promise<unknown>;
  /** Read skill content by name. */
  readSkill?: (name: string) => Promise<{ content: string } | null>;
  readConfigFile?: (scope: "project" | "global") => Promise<OpencodeConfigFile | null>;
  showHeader?: boolean;
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  setSelectedMcp: (name: string | null) => void;
  quickConnect: McpDirectoryInfo[];
  connectMcp: (entry: McpDirectoryInfo) => void;
  authorizeMcp: (entry: McpServerEntry) => void;
  logoutMcpAuth: (name: string) => Promise<void> | void;
  removeMcp: (name: string) => void;
  setMcpEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  /** Return extension-specific config UI for the detail modal. */
  configSlotForEntry?: (entry: McpDirectoryInfo) => React.ReactNode | null;
  /** Check if an extension-kind entry is connected/active. */
  isExtensionConnected?: (entry: McpDirectoryInfo) => boolean;
  /** Enablement context for evaluating extension active state. */
  enablementContext?: import("../../../../app/enablement").EnablementContext;
  /** Organization policy restriction for OpenWork-provided built-in extensions. */
  builtInExtensionsDisabled?: boolean;
  /** Preview a Claude Code plugin bundle from a GitHub URL ("Will install" disclosure). */
  previewClaudePlugin?: (url: string) => Promise<OpenworkClaudePluginPreview>;
  /** Install a Claude Code plugin bundle from a GitHub URL. */
  installClaudePlugin?: (url: string) => Promise<{ ok: boolean; message: string }>;
};

const builtInExtensionDisabledReason = "Disabled by organization";

const statusDot = (status: ReactMcpStatus) => {
  switch (status) {
    case "connected":
      return "bg-green-9";
    case "needs_auth":
    case "needs_client_registration":
      return "bg-amber-9";
    case "disabled":
      return "bg-gray-8";
    case "disconnected":
      return "bg-gray-7";
    default:
      return "bg-red-9";
  }
};

const friendlyStatus = (status: ReactMcpStatus) => {
  switch (status) {
    case "connected":
      return t("mcp.friendly_status_ready");
    case "needs_auth":
    case "needs_client_registration":
      return t("mcp.friendly_status_needs_signin");
    case "disabled":
      return t("mcp.friendly_status_paused");
    case "disconnected":
      return t("mcp.friendly_status_offline");
    default:
      return t("mcp.friendly_status_issue");
  }
};

const statusBadgeStyle = (status: ReactMcpStatus) => {
  switch (status) {
    case "connected":
      return "bg-green-3 text-green-11";
    case "needs_auth":
    case "needs_client_registration":
      return "bg-amber-3 text-amber-11";
    case "disabled":
    case "disconnected":
      return "bg-gray-3 text-gray-11";
    default:
      return "bg-red-3 text-red-11";
  }
};

const serviceIcon = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return BookOpen;
  if (lower.includes("linear")) return Zap;
  if (lower.includes("sentry")) return CircleAlert;
  if (lower.includes("stripe")) return CreditCard;
  if (lower.includes("context")) return Globe;
  if (lower.includes("devtools")) {
    return MonitorSmartphone;
  }
  if (lower.includes("openwork") && lower.includes("cloud")) return Cloud;
  if (lower.includes("openwork") && lower.includes("ui")) return MonitorSmartphone;
  return Plug2;
};

const serviceColor = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return "text-gray-12";
  if (lower.includes("linear")) return "text-blue-11";
  if (lower.includes("sentry")) return "text-purple-11";
  if (lower.includes("stripe")) return "text-blue-11";
  if (lower.includes("context")) return "text-green-11";
  if (lower.includes("devtools")) {
    return "text-amber-11";
  }
  if (lower.includes("openwork")) return "text-gray-12";
  return "text-dls-secondary";
};

const serviceIconBg = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return "bg-gray-3 border-gray-6";
  if (lower.includes("linear")) return "bg-blue-3 border-blue-6";
  if (lower.includes("sentry")) return "bg-purple-3 border-purple-6";
  if (lower.includes("stripe")) return "bg-blue-3 border-blue-6";
  if (lower.includes("context")) return "bg-green-3 border-green-6";
  if (lower.includes("devtools")) {
    return "bg-amber-3 border-amber-6";
  }
  if (lower.includes("openwork")) return "bg-gray-3 border-gray-6";
  return "bg-dls-hover border-dls-border";
};

function extensionResourceLabels(entry: McpDirectoryInfo) {
  return entry.extensionManifest?.resources.map((resource) => resource.label ?? resource.id) ?? [];
}

function extensionContributionLabels(entry: McpDirectoryInfo) {
  return entry.extensionManifest?.contributions?.map((contribution) => contribution.label ?? contribution.ref ?? contribution.type) ?? [];
}

function isToggleOnlyExtension(entry: McpDirectoryInfo) {
  if (entry.kind !== "extension") return false;
  return entry.extensionManifest?.contributions?.some((contribution) =>
    contribution.type === "session-side-panel" || contribution.type === "session-rail-item"
  ) === true;
}

type ExtensionFilter = "all" | "mcp" | "skill" | "plugin";

export function McpView(props: McpViewProps) {
  const showHeader = props.showHeader !== false;
  const [detailEntry, setDetailEntry] = useState<McpDirectoryInfo | null>(null);
  const [detailSkill, setDetailSkill] = useState<SkillItem | null>(null);
  const [detailSkillContent, setDetailSkillContent] = useState<string | null>(null);
  const [detailPlugin, setDetailPlugin] = useState<CloudImportedPlugin | null>(null);
  const [openworkUiMcpCommand, setOpenworkUiMcpCommand] = useState<string[] | null>(null);
  const [openworkUiMcpEnvironment, setOpenworkUiMcpEnvironment] = useState<Record<string, string> | null>(null);
  const [computerUseMcpCommand, setComputerUseMcpCommand] = useState<string[] | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ExtensionFilter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [claudeImportOpen, setClaudeImportOpen] = useState(false);
  const [, setExtensionStateVersion] = useState(0);

  const [localState, dispatchLocal] = useReducer(
    mcpViewLocalReducer,
    initialMcpViewLocalState,
  );
  const {
    logoutOpen,
    logoutTarget,
    logoutBusy,
    removeOpen,
    removeTarget,
    configScope,
    projectConfig,
    globalConfig,
    configError,
    revealBusy,
    showAdvanced,
    addMcpModalOpen,
    togglingMcp,
  } = localState;
  const setLocal = <K extends keyof McpViewLocalState>(
    key: K,
    value: SetStateAction<McpViewLocalState[K]>,
  ) => dispatchLocal({ type: "set", key, value });
  const setLogoutOpen = (value: SetStateAction<boolean>) => setLocal("logoutOpen", value);
  const setLogoutTarget = (value: SetStateAction<string | null>) => setLocal("logoutTarget", value);
  const setLogoutBusy = (value: SetStateAction<boolean>) => setLocal("logoutBusy", value);
  const setRemoveOpen = (value: SetStateAction<boolean>) => setLocal("removeOpen", value);
  const setRemoveTarget = (value: SetStateAction<string | null>) => setLocal("removeTarget", value);
  const setConfigScope = (value: SetStateAction<ConfigScope>) => setLocal("configScope", value);
  const setConfigError = (value: SetStateAction<string | null>) => setLocal("configError", value);
  const setRevealBusy = (value: SetStateAction<boolean>) => setLocal("revealBusy", value);
  const setShowAdvanced = (value: SetStateAction<boolean>) => setLocal("showAdvanced", value);
  const setAddMcpModalOpen = (value: SetStateAction<boolean>) => setLocal("addMcpModalOpen", value);
  const setTogglingMcp = (value: SetStateAction<string | null>) => setLocal("togglingMcp", value);
  const configRequestId = useRef(0);

  const quickConnectList = props.quickConnect;

  useEffect(() => {
    const refresh = () => setExtensionStateVersion((value) => value + 1);
    window.addEventListener(OPENWORK_EXTENSION_STATE_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(OPENWORK_EXTENSION_STATE_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void (async () => {
      try {
        const command = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("getOpenworkUiMcpCommand");
        if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
          setOpenworkUiMcpCommand(command);
        }
        const environment = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("getOpenworkUiMcpEnvironment");
        if (environment && typeof environment === "object" && !Array.isArray(environment)) {
          setOpenworkUiMcpEnvironment(Object.fromEntries(
            Object.entries(environment).filter((entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string"
            ),
          ));
        }
        const computerUseCommand = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("getComputerUseMcpCommand");
        if (Array.isArray(computerUseCommand) && computerUseCommand.every((part) => typeof part === "string")) {
          setComputerUseMcpCommand(computerUseCommand);
        }
      } catch {
        setOpenworkUiMcpCommand(null);
        setOpenworkUiMcpEnvironment(null);
        setComputerUseMcpCommand(null);
      }
    })();
  }, []);

  useEffect(() => {
    const root = props.selectedWorkspaceRoot.trim();
    const nextId = configRequestId.current + 1;
    configRequestId.current = nextId;
    const readConfig = props.readConfigFile;
    const canReadDesktopConfig = !props.isRemoteWorkspace && isDesktopRuntime();

    if (!readConfig && !canReadDesktopConfig) {
      dispatchLocal({ type: "configUnavailable" });
      return;
    }

    void (async () => {
      try {
        setConfigError(null);
        const [project, global] = await Promise.all([
          root
            ? readConfig
              ? readConfig("project")
              : canReadDesktopConfig
              ? readOpencodeConfig("project", root)
              : Promise.resolve(null)
            : Promise.resolve(null),
          readConfig
            ? readConfig("global")
            : canReadDesktopConfig
            ? readOpencodeConfig("global", root)
            : Promise.resolve(null),
        ]);
        if (nextId !== configRequestId.current) return;
        dispatchLocal({
          type: "configLoaded",
          project: project as OpencodeConfigFile | null,
          global: global as OpencodeConfigFile | null,
        });
      } catch (error) {
        if (nextId !== configRequestId.current) return;
        dispatchLocal({
          type: "configLoadError",
          error: error instanceof Error ? error.message : t("mcp.config_load_failed"),
        });
      }
    })();
  }, [props.isRemoteWorkspace, props.readConfigFile, props.selectedWorkspaceRoot]);

  const activeConfig = configScope === "project" ? projectConfig : globalConfig;

  const revealLabel = isWindowsPlatform()
    ? t("mcp.open_file")
    : t("mcp.reveal_in_finder");

  const canRevealConfig =
    isDesktopRuntime() &&
    !props.isRemoteWorkspace &&
    !revealBusy &&
    !(configScope === "project" && !props.selectedWorkspaceRoot.trim()) &&
    Boolean(activeConfig?.exists);

  const resolveQuickConnectMatch = (name: string) =>
    quickConnectList.find((candidate) => {
      const candidateKey = getMcpIdentityKey(candidate);
      return (
        candidateKey === name ||
        candidate.name === name ||
        normalizeMcpSlug(candidate.name) === name
      );
    });

  const displayName = (name: string) => resolveQuickConnectMatch(name)?.name ?? name;

  const quickConnectStatus = (entry: McpDirectoryInfo) =>
    props.mcpStatuses[getMcpIdentityKey(entry)];

  const isQuickConnectConfigured = (entry: McpDirectoryInfo) =>
    props.mcpServers.some((server) => server.name === getMcpIdentityKey(entry));

  const isMcpBackedExtension = (entry: McpDirectoryInfo) =>
    entry.kind === "extension" && Boolean(entry.type || entry.command?.length || entry.url);

  const enablementForEntry = (entry: McpDirectoryInfo): { active: boolean; results: EnablementResult[] } | null => {
    const manifest = entry.extensionManifest;
    if (manifest?.enablement && props.enablementContext) {
      return evaluateEnablement(manifest.enablement, props.enablementContext);
    }
    return null;
  };

  const launchCommandForEntry = (entry: McpDirectoryInfo) => {
    if (entry.serverName === "openwork-ui") return openworkUiMcpCommand ?? undefined;
    if (entry.serverName === "computer-use") return computerUseMcpCommand ?? entry.command;
    return entry.command;
  };

  const supportsOauth = (entry: McpServerEntry) =>
    entry.config.type === "remote" && entry.config.oauth !== false;

  const resolveStatus = (entry: McpServerEntry): ReactMcpStatus => {
    if (entry.config.enabled === false) return "disabled";
    const resolved = props.mcpStatuses[entry.name];
    return resolved?.status ?? "disconnected";
  };

  const connectedCount = props.mcpServers.filter(
    (entry) => resolveStatus(entry) === "connected",
  ).length;
  const hiddenCount = quickConnectList.filter((entry) => isOpenWorkExtensionHidden(entry)).length +
    (props.installedSkills ?? []).filter((skill) => isOpenWorkExtensionHidden(getSkillHiddenId(skill))).length +
    (props.installedPlugins ?? []).filter((plugin) => isOpenWorkExtensionHidden(`plugin:${plugin.pluginId}`)).length;
  const policyHiddenBuiltInCount = props.builtInExtensionsDisabled
    ? quickConnectList.filter((entry) => isBuiltInOpenWorkExtension(entry) && !isOpenWorkExtensionHidden(entry)).length
    : 0;
  const hiddenOrPolicyCount = hiddenCount + policyHiddenBuiltInCount;

  const requestLogout = (name: string) => {
    if (!name.trim()) return;
    setLogoutTarget(name);
    setLogoutOpen(true);
  };

  const confirmLogout = async () => {
    const name = logoutTarget;
    if (!name || logoutBusy) return;
    setLogoutBusy(true);
    try {
      await props.logoutMcpAuth(name);
    } finally {
      setLogoutBusy(false);
      setLogoutOpen(false);
      setLogoutTarget(null);
    }
  };

  const revealConfig = async () => {
    if (!isDesktopRuntime() || revealBusy) return;
    const root = props.selectedWorkspaceRoot.trim();

    if (configScope === "project" && !root) {
      setConfigError(t("mcp.pick_workspace_error"));
      return;
    }

    setRevealBusy(true);
    setConfigError(null);
    try {
      const resolved = props.readConfigFile
        ? await props.readConfigFile(configScope)
        : !props.isRemoteWorkspace
        ? await readOpencodeConfig(configScope, root)
        : null;
      const configFile = resolved as OpencodeConfigFile | null;
      if (!configFile) {
        throw new Error(t("mcp.config_load_failed"));
      }
      if (isWindowsPlatform()) {
        await openDesktopPath(configFile.path);
      } else {
        await revealDesktopItemInDir(configFile.path);
      }
    } catch (error) {
      setConfigError(
        error instanceof Error ? error.message : t("mcp.reveal_config_failed"),
      );
    } finally {
      setRevealBusy(false);
    }
  };

  return (
    <section className="space-y-8 max-w-3xl w-full animate-in fade-in duration-300">
      {showHeader ? (
        <McpViewHeader connectedCount={connectedCount} />
      ) : null}

      {props.mcpStatus ? (
        <div className="whitespace-pre-wrap wrap-break-word rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary">
          {props.mcpStatus}
        </div>
      ) : null}

      {props.builtInExtensionsDisabled ? (
        <div className="rounded-xl border border-amber-6 bg-amber-2 px-4 py-3 text-xs text-amber-11">
          Built-in OpenWork extensions are disabled by your organization. Use Show hidden to review blocked built-ins.
        </div>
      ) : null}

      <McpCustomAppCard
        onOpen={() => setAddMcpModalOpen(true)}
        onOpenGithubImport={
          props.previewClaudePlugin && props.installClaudePlugin
            ? () => setClaudeImportOpen(true)
            : undefined
        }
      />

      {/* Search + filter */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary" />
          <input
            className="w-full rounded-lg border border-dls-border bg-dls-surface py-2 pl-9 pr-3 text-xs text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
            placeholder="Search extensions..."
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "mcp", "skill"] as const).map((f) => (
            <Button
              key={f}
              variant={filter === f ? "secondary" : "outline"}
              size="xs"
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "mcp" ? "MCPs" : "Skills"}
            </Button>
          ))}
          <Button
            variant={showHidden ? "secondary" : "outline"}
            size="xs"
            onClick={() => setShowHidden((current) => !current)}
          >
            {showHidden ? "Showing hidden" : hiddenOrPolicyCount > 0 ? `Show hidden (${hiddenOrPolicyCount})` : "Show hidden"}
          </Button>
        </div>
      </div>

      <McpQuickConnectSection
        entries={
          quickConnectList.filter((entry) => {
            if (!showHidden && (isOpenWorkExtensionHidden(entry) || (props.builtInExtensionsDisabled && isBuiltInOpenWorkExtension(entry)))) return false;
            if (filter === "skill") return false;
            if (filter === "mcp" && (entry.kind ?? "mcp") !== "mcp" && entry.kind !== "ui-control") return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q);
          })
        }
        installedSkills={
          (props.installedSkills ?? []).filter((skill) => {
            if (!showHidden && isOpenWorkExtensionHidden(getSkillHiddenId(skill))) return false;
            if (filter === "mcp") return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return skill.name.toLowerCase().includes(q) || (skill.description ?? "").toLowerCase().includes(q);
          })
        }
        installedPlugins={
          (props.installedPlugins ?? []).filter((plugin) => {
            if (!showHidden && isOpenWorkExtensionHidden(`plugin:${plugin.pluginId}`)) return false;
            if (filter === "mcp" || filter === "skill") return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return [plugin.name, plugin.description ?? "", ...plugin.files.map((file) => `${file.title} ${file.objectType} ${file.path}`)]
              .join(" ")
              .toLowerCase()
              .includes(q);
          })
        }
        busy={props.busy}
        connectingName={props.mcpConnectingName}
        isEntryHidden={(entry) => isOpenWorkExtensionHidden(entry)}
        isSkillHidden={(skill) => isOpenWorkExtensionHidden(getSkillHiddenId(skill))}
        isPluginHidden={(plugin) => isOpenWorkExtensionHidden(`plugin:${plugin.pluginId}`)}
        disabledReasonForEntry={(entry) =>
          props.builtInExtensionsDisabled && isBuiltInOpenWorkExtension(entry)
            ? builtInExtensionDisabledReason
            : null
        }
        isConfigured={(entry) => {
          if (props.builtInExtensionsDisabled && isBuiltInOpenWorkExtension(entry)) return false;
          const result = enablementForEntry(entry);
          if (result) return result.active;
          // Fallback for entries without enablement context.
          if (isToggleOnlyExtension(entry)) return isOpenWorkExtensionEnabled(entry);
          if (entry.kind === "extension" && !isMcpBackedExtension(entry)) return props.isExtensionConnected?.(entry) ?? false;
          return isQuickConnectConfigured(entry);
        }}
        enablementForEntry={props.enablementContext ? enablementForEntry : undefined}
        statusForEntry={quickConnectStatus}
        onConnect={props.connectMcp}
        onDetail={setDetailEntry}
        onSkillDetail={(skill) => {
          setDetailSkill(skill);
          setDetailSkillContent(null);
          if (props.readSkill) {
            void props.readSkill(skill.name).then((result) => {
              if (result?.content) {
                setDetailSkillContent(result.content.slice(0, 2000));
              }
            });
          }
        }}
        onPluginDetail={setDetailPlugin}
      />

      <McpConfiguredServersSection
        servers={props.mcpServers}
        statuses={props.mcpStatuses}
        lastUpdatedAt={props.mcpLastUpdatedAt}
        selectedMcp={props.selectedMcp}
        busy={props.busy}
        logoutBusy={logoutBusy}
        logoutTarget={logoutTarget}
        togglingMcp={togglingMcp}
        displayName={displayName}
        resolveStatus={resolveStatus}
        supportsOauth={supportsOauth}
        onSelect={props.setSelectedMcp}
        onAuthorize={props.authorizeMcp}
        onRequestLogout={requestLogout}
        onRemove={(name) => {
          setRemoveTarget(name);
          setRemoveOpen(true);
        }}
        onToggleEnabled={props.setMcpEnabled}
        onToggleBusy={setTogglingMcp}
      />

      <ConfirmModal
        open={logoutOpen}
        title={t("mcp.logout_modal_title")}
        message={t("mcp.logout_modal_message").replace("{server}", displayName(logoutTarget ?? ""))}
        confirmLabel={logoutBusy ? t("mcp.logout_working") : t("mcp.logout_action")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => {
          if (logoutBusy) return;
          setLogoutOpen(false);
          setLogoutTarget(null);
        }}
        onConfirm={() => {
          void confirmLogout();
        }}
      />

      <ConfirmModal
        open={removeOpen}
        title={t("mcp.remove_modal_title")}
        message={t("mcp.remove_modal_message").replace("{server}", displayName(removeTarget ?? ""))}
        confirmLabel={t("mcp.remove_app")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => {
          setRemoveOpen(false);
          setRemoveTarget(null);
        }}
        onConfirm={() => {
          if (removeTarget) props.removeMcp(removeTarget);
          setRemoveOpen(false);
          setRemoveTarget(null);
        }}
      />

      <McpAdvancedConfigSection
        open={showAdvanced}
        configScope={configScope}
        activeConfig={activeConfig}
        canRevealConfig={canRevealConfig}
        revealBusy={revealBusy}
        revealLabel={revealLabel}
        configError={configError}
        onToggle={() => setShowAdvanced((current) => !current)}
        onScopeChange={setConfigScope}
        onReveal={revealConfig}
      />

      <AddMcpModal
        open={addMcpModalOpen}
        onClose={() => setAddMcpModalOpen(false)}
        onAdd={(entry) => props.connectMcp(entry)}
        busy={props.busy}
        isRemoteWorkspace={props.isRemoteWorkspace}
      />

      {props.previewClaudePlugin && props.installClaudePlugin ? (
        <ClaudePluginImportModal
          open={claudeImportOpen}
          onClose={() => setClaudeImportOpen(false)}
          onPreview={props.previewClaudePlugin}
          onInstall={props.installClaudePlugin}
        />
      ) : null}

      {detailEntry ? (() => {
        const extensionConfigSlot = props.configSlotForEntry?.(detailEntry) ?? null;
        const hasConfigSlot = extensionConfigSlot !== null;
        const hidden = isOpenWorkExtensionHidden(detailEntry);
        const disabledReason = props.builtInExtensionsDisabled && isBuiltInOpenWorkExtension(detailEntry)
          ? builtInExtensionDisabledReason
          : null;
        const isConnected = disabledReason
          ? false
          : isToggleOnlyExtension(detailEntry)
          ? isOpenWorkExtensionEnabled(detailEntry)
          : detailEntry.kind === "extension" && !isMcpBackedExtension(detailEntry)
          ? props.isExtensionConnected?.(detailEntry) ?? false
          : isQuickConnectConfigured(detailEntry);
        const isGoogleWorkspace = detailEntry.id === "google-workspace";
        return (
          <ExtensionDetailModal
            open={!!detailEntry}
            onClose={() => setDetailEntry(null)}
            name={detailEntry.name}
            description={detailEntry.description}
            iconSlug={detailEntry.iconSlug}
            iconSrc={detailEntry.iconSrc}
            fallbackIcon={serviceIcon(detailEntry.name)}
            kind={detailEntry.kind ?? "mcp"}
            connected={isConnected}
            connecting={props.mcpConnectingName === detailEntry.name}
            hidden={hidden}
            preview={detailEntry.preview}
            disabledReason={disabledReason}
            setupInstructions={isGoogleWorkspace ? undefined : detailEntry.extensionManifest?.setup?.instructions}
            resourceLabels={isGoogleWorkspace ? [] : extensionResourceLabels(detailEntry)}
            contributionLabels={isGoogleWorkspace ? [] : extensionContributionLabels(detailEntry)}
            launchCommand={launchCommandForEntry(detailEntry)}
            environment={detailEntry.serverName === "openwork-ui" ? openworkUiMcpEnvironment ?? undefined : undefined}
            url={typeof detailEntry.url === "string" ? detailEntry.url : undefined}
            oauth={detailEntry.oauth}
            configSlot={disabledReason ? null : extensionConfigSlot}
            showEnablementCard={!isGoogleWorkspace}
            onConnect={disabledReason ? undefined : isToggleOnlyExtension(detailEntry) ? () => {
              setOpenWorkExtensionEnabled(detailEntry, true);
              setDetailEntry(null);
            } : hasConfigSlot ? undefined : () => {
              props.connectMcp(detailEntry);
              setDetailEntry(null);
            }}
            onUninstall={disabledReason ? undefined : isToggleOnlyExtension(detailEntry) && isConnected ? () => {
              setOpenWorkExtensionEnabled(detailEntry, false);
            } : isQuickConnectConfigured(detailEntry) ? () => {
              const slug = getMcpIdentityKey(detailEntry);
              props.removeMcp(slug);
              setDetailEntry(null);
            } : undefined}
            onHide={() => setOpenWorkExtensionHidden(detailEntry, true)}
            onShow={() => setOpenWorkExtensionHidden(detailEntry, false)}
          />
        );
      })() : null}

      {detailSkill ? (() => {
        const hidden = isOpenWorkExtensionHidden(getSkillHiddenId(detailSkill));
        return (
          <ExtensionDetailModal
            open={!!detailSkill}
            onClose={() => { setDetailSkill(null); setDetailSkillContent(null); }}
            name={detailSkill.name}
            description={detailSkill.description ?? "Installed skill"}
            kind="skill"
            connected={true}
            hidden={hidden}
            path={detailSkill.path}
            trigger={detailSkill.trigger}
            contentPreview={detailSkillContent ?? undefined}
            onReveal={detailSkill.path ? () => {
              void revealDesktopItemInDir(detailSkill.path);
            } : undefined}
            onUninstall={props.uninstallSkill ? () => {
              props.uninstallSkill?.(detailSkill.name);
              setDetailSkill(null);
            } : undefined}
            onHide={() => setOpenWorkExtensionHidden(getSkillHiddenId(detailSkill), true)}
            onShow={() => setOpenWorkExtensionHidden(getSkillHiddenId(detailSkill), false)}
          />
        );
      })() : null}

      {detailPlugin ? (() => {
        const hidden = isOpenWorkExtensionHidden(`plugin:${detailPlugin.pluginId}`);
        return (
          <ExtensionDetailModal
            open={!!detailPlugin}
            onClose={() => setDetailPlugin(null)}
            name={detailPlugin.name}
            description={detailPlugin.description ?? "Marketplace extension installed in this workspace."}
            kind="extension"
            connected={true}
            hidden={hidden}
            onUninstall={props.removeCloudPlugin ? () => {
              void props.removeCloudPlugin?.(detailPlugin.pluginId);
              setDetailPlugin(null);
            } : undefined}
            onHide={() => setOpenWorkExtensionHidden(`plugin:${detailPlugin.pluginId}`, true)}
            onShow={() => setOpenWorkExtensionHidden(`plugin:${detailPlugin.pluginId}`, false)}
          />
        );
      })() : null}
    </section>
  );
}

function McpViewHeader(props: { connectedCount: number }) {
  return (
    <div>
      <h2 className="text-3xl font-semibold text-dls-text">{t("mcp.apps_title")}</h2>
      <p className="mt-1.5 text-sm text-dls-secondary">{t("mcp.apps_subtitle")}</p>
      {props.connectedCount > 0 ? (
        <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-green-3 px-3 py-1">
          <div className="size-2 rounded-full bg-green-9" />
          <span className="text-xs font-medium text-green-11">
            {props.connectedCount} {props.connectedCount === 1 ? t("mcp.app_connected") : t("mcp.apps_connected")}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function McpCustomAppCard(props: { onOpen: () => void; onOpenGithubImport?: () => void }) {
  return (
    <div className="rounded-2xl border border-blue-6/30 bg-[linear-gradient(180deg,rgba(59,130,246,0.08),rgba(59,130,246,0.03))] p-5 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="text-base font-semibold text-dls-text">{t("mcp.add_modal_title")}</div>
          <div className="text-sm text-dls-secondary">{t("mcp.custom_app_cta_hint")}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {props.onOpenGithubImport ? (
            <Button variant="outline" onClick={props.onOpenGithubImport}>
              <Download size={14} />
              From GitHub
            </Button>
          ) : null}
          <Button onClick={props.onOpen}>
            <Plus size={14} />
            {t("mcp.add_modal_title")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function McpQuickConnectSection(props: {
  entries: McpDirectoryInfo[];
  installedSkills?: SkillItem[];
  installedPlugins?: CloudImportedPlugin[];
  busy: boolean;
  connectingName: string | null;
  isEntryHidden: (entry: McpDirectoryInfo) => boolean;
  isSkillHidden: (skill: SkillItem) => boolean;
  isPluginHidden: (plugin: CloudImportedPlugin) => boolean;
  disabledReasonForEntry: (entry: McpDirectoryInfo) => string | null;
  isConfigured: (entry: McpDirectoryInfo) => boolean;
  enablementForEntry?: (entry: McpDirectoryInfo) => { active: boolean; results: EnablementResult[] } | null;
  statusForEntry: (entry: McpDirectoryInfo) => { status: ReactMcpStatus } | undefined;
  onConnect: (entry: McpDirectoryInfo) => void;
  onDetail: (entry: McpDirectoryInfo) => void;
  onSkillDetail?: (skill: SkillItem) => void;
  onPluginDetail?: (plugin: CloudImportedPlugin) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-dls-secondary">
          {t("mcp.available_apps")}
        </h3>
        <span className="text-[11px] text-dls-secondary">{t("mcp.one_click_connect")}</span>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3">
        {/* MCP entries */}
        {props.entries.map((entry) => {
          const configured = props.isConfigured(entry);
          const enablement = props.enablementForEntry?.(entry);
          const connecting = props.connectingName === entry.name;
          const FallbackIcon = serviceIcon(entry.name);
          const hidden = props.isEntryHidden(entry);
          const disabledReason = props.disabledReasonForEntry(entry);

          return (
            <ExtensionCard
              key={getMcpIdentityKey(entry)}
              name={entry.name}
              description={entry.description}
              iconSlug={entry.iconSlug}
              iconSrc={entry.iconSrc}
              fallbackIcon={FallbackIcon}
              kind={entry.kind ?? "mcp"}
              connected={configured}
              enablement={enablement?.results}
              connecting={connecting}
              hidden={hidden}
              preview={entry.preview}
              disabledReason={disabledReason}
              disabled={props.busy}
              actionLabel={configured ? "View details" : t("mcp.tap_to_connect")}
              onClick={() => props.onDetail(entry)}
            />
          );
        })}

        {/* Installed skills */}
        {(props.installedSkills ?? []).map((skill) => {
          const hidden = props.isSkillHidden(skill);
          return (
            <ExtensionCard
              key={`skill:${skill.name}`}
              name={skill.name}
              description={skill.description ?? "Installed skill"}
              kind="skill"
              connected={true}
              hidden={hidden}
              actionLabel="View details"
              onClick={() => props.onSkillDetail?.(skill)}
            />
          );
        })}

        {(props.installedPlugins ?? []).map((plugin) => {
          const hidden = props.isPluginHidden(plugin);
          const fileCount = plugin.files.length;
          return (
            <ExtensionCard
              key={`plugin:${plugin.pluginId}`}
              name={plugin.name}
              description={plugin.description ?? `Marketplace extension with ${fileCount} installed file${fileCount === 1 ? "" : "s"}.`}
              kind="extension"
              connected={true}
              hidden={hidden}
              actionLabel="View details"
              onClick={() => props.onPluginDetail?.(plugin)}
            />
          );
        })}

        {props.entries.length === 0 && (props.installedSkills ?? []).length === 0 && (props.installedPlugins ?? []).length === 0 ? (
          <div className="col-span-full rounded-xl border border-dashed border-dls-border px-5 py-10 text-center">
            <Unplug size={24} className="mx-auto mb-3 text-dls-secondary/30" />
            <div className="text-sm font-medium text-dls-secondary">No extensions found</div>
            <div className="mt-1 text-xs text-dls-secondary/60">Try a different search, filter, or open Marketplace to add one.</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function McpConfiguredServersSection(props: {
  servers: McpServerEntry[];
  statuses: McpStatusMap;
  lastUpdatedAt: number | null;
  selectedMcp: string | null;
  busy: boolean;
  logoutBusy: boolean;
  logoutTarget: string | null;
  togglingMcp: string | null;
  displayName: (name: string) => string;
  resolveStatus: (entry: McpServerEntry) => ReactMcpStatus;
  supportsOauth: (entry: McpServerEntry) => boolean;
  onSelect: (name: string | null) => void;
  onAuthorize: (entry: McpServerEntry) => void;
  onRequestLogout: (name: string) => void;
  onRemove: (name: string) => void;
  onToggleEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  onToggleBusy: (value: SetStateAction<string | null>) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-dls-secondary">
          {t("mcp.your_apps")}
        </h3>
        {props.lastUpdatedAt ? (
          <span className="tabular-nums text-[11px] text-dls-secondary">
            {t("mcp.last_synced")} {formatRelativeTime(props.lastUpdatedAt)}
          </span>
        ) : null}
      </div>

      {props.servers.length ? (
        <div className="space-y-2">
          {props.servers.map((entry) => (
            <McpConfiguredServerRow
              key={entry.name}
              entry={entry}
              status={props.resolveStatus(entry)}
              errorInfo={readMcpErrorInfo(props.statuses[entry.name])}
              selected={props.selectedMcp === entry.name}
              busy={props.busy}
              logoutBusy={props.logoutBusy}
              logoutTarget={props.logoutTarget}
              togglingMcp={props.togglingMcp}
              displayName={props.displayName}
              supportsOauth={props.supportsOauth}
              onSelect={props.onSelect}
              onAuthorize={props.onAuthorize}
              onRequestLogout={props.onRequestLogout}
              onRemove={props.onRemove}
              onToggleEnabled={props.onToggleEnabled}
              onToggleBusy={props.onToggleBusy}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-dls-border px-5 py-10 text-center">
          <Unplug size={24} className="mx-auto mb-3 text-dls-secondary/30" />
          <div className="text-sm font-medium text-dls-secondary">{t("mcp.no_apps_yet")}</div>
          <div className="mt-1 text-xs text-dls-secondary/60">{t("mcp.no_apps_hint")}</div>
        </div>
      )}
    </div>
  );
}

function readMcpErrorInfo(status: McpStatusMap[string] | undefined) {
  if (!status || status.status !== "failed") return null;
  return "error" in status ? status.error : t("mcp.connection_failed");
}

function McpConfiguredServerRow(props: {
  entry: McpServerEntry;
  status: ReactMcpStatus;
  errorInfo: string | null;
  selected: boolean;
  busy: boolean;
  logoutBusy: boolean;
  logoutTarget: string | null;
  togglingMcp: string | null;
  displayName: (name: string) => string;
  supportsOauth: (entry: McpServerEntry) => boolean;
  onSelect: (name: string | null) => void;
  onAuthorize: (entry: McpServerEntry) => void;
  onRequestLogout: (name: string) => void;
  onRemove: (name: string) => void;
  onToggleEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  onToggleBusy: (value: SetStateAction<string | null>) => void;
}) {
  const Icon = serviceIcon(props.entry.name);
  return (
    <div className={`rounded-xl border transition-all ${props.selected ? "border-blue-7 bg-blue-2 shadow-sm" : "border-dls-border bg-dls-surface hover:bg-dls-hover"}`}>
      <button type="button" className="w-full px-4 py-3.5 text-left" onClick={() => props.onSelect(props.selected ? null : props.entry.name)}>
        <div className="flex items-center gap-3">
          <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg border ${props.status === "connected" ? "border-green-6 bg-green-3" : serviceIconBg(props.entry.name)}`}>
            <Icon size={15} className={props.status === "connected" ? "text-green-11" : serviceColor(props.entry.name)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-dls-text">{props.displayName(props.entry.name)}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className={`size-2 rounded-full ${statusDot(props.status)}`} />
            <span className="text-[11px] text-dls-secondary">{friendlyStatus(props.status)}</span>
          </div>
          <div className={`transition-transform ${props.selected ? "rotate-180" : ""}`}>
            <ChevronDown size={14} className="text-dls-secondary/40" />
          </div>
        </div>
      </button>

      {props.selected ? <McpConfiguredServerDetails {...props} /> : null}
    </div>
  );
}

function McpConfiguredServerDetails(props: Parameters<typeof McpConfiguredServerRow>[0]) {
  return (
    <div className="animate-in fade-in slide-in-from-top-1 space-y-3 border-t border-blue-6/20 px-4 py-3 duration-200">
      <div className="flex items-center gap-4 text-xs">
        <span className="text-dls-secondary">{t("mcp.connection_type")}</span>
        <span className="text-dls-text">{props.entry.config.type === "remote" ? t("mcp.type_cloud") : t("mcp.type_local")}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-dls-text">
          {t("mcp.cap_tools")}
        </span>
        {props.entry.config.type === "remote" ? (
          <span className="rounded-md border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-dls-text">
            {t("mcp.cap_signin")}
          </span>
        ) : null}
      </div>
      {props.errorInfo ? <div className="rounded-lg border border-red-6 bg-red-2 px-3 py-2 text-xs text-red-11">{props.errorInfo}</div> : null}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-dls-secondary transition-colors hover:text-dls-text">
          <Code2 size={11} />
          {t("mcp.technical_details")}
          <ChevronDown size={10} className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-1.5 break-all rounded-lg bg-dls-hover px-3 py-2 font-mono text-[11px] text-dls-secondary">
          {props.entry.config.type === "remote" ? props.entry.config.url : props.entry.config.command?.join(" ")}
        </div>
      </details>
      <McpConfiguredServerAuthActions {...props} />
      <div className="flex justify-end gap-2 pt-1">
        {props.onToggleEnabled && props.entry.source !== "config.global" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={props.busy || props.togglingMcp === props.entry.name}
            onClick={(event) => {
              event.stopPropagation();
              if (props.togglingMcp) return;
              const next = props.entry.config.enabled !== false ? false : true;
              props.onToggleBusy(props.entry.name);
              void Promise.resolve(props.onToggleEnabled?.(props.entry.name, next)).finally(() => props.onToggleBusy(null));
            }}
          >
            <Power size={13} />
            {props.entry.config.enabled === false ? t("mcp.enable_app") : t("mcp.disable_app")}
          </Button>
        ) : null}
        <Button
          variant="destructive"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove(props.entry.name);
          }}
        >
          {t("mcp.remove_app")}
        </Button>
      </div>
    </div>
  );
}

function McpConfiguredServerAuthActions(props: Parameters<typeof McpConfiguredServerRow>[0]) {
  if (!props.supportsOauth(props.entry)) return null;
  if (props.status !== "connected") {
    return (
      <>
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="text-xs text-dls-secondary">{t("mcp.logout_label")}</div>
          <Button size="sm" disabled={props.busy} onClick={() => props.onAuthorize(props.entry)}>
            {t("mcp.login_action")}
          </Button>
        </div>
        <div className="text-[11px] text-dls-secondary/70">{t("mcp.login_hint")}</div>
      </>
    );
  }
  return (
    <>
      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-xs text-dls-secondary">{t("mcp.logout_label")}</div>
        <Button
          variant="destructive"
          size="sm"
          disabled={props.busy || props.logoutBusy}
          onClick={() => props.onRequestLogout(props.entry.name)}
        >
          {props.logoutBusy && props.logoutTarget === props.entry.name ? t("mcp.logout_working") : t("mcp.logout_action")}
        </Button>
      </div>
      <div className="text-[11px] text-dls-secondary/70">{t("mcp.logout_hint")}</div>
    </>
  );
}

function McpAdvancedConfigSection(props: {
  open: boolean;
  configScope: ConfigScope;
  activeConfig: OpencodeConfigFile | null;
  canRevealConfig: boolean;
  revealBusy: boolean;
  revealLabel: string;
  configError: string | null;
  onToggle: () => void;
  onScopeChange: (scope: ConfigScope) => void;
  onReveal: () => Promise<void>;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-dls-border bg-dls-surface">
      <button type="button" className="flex w-full items-center justify-between px-5 py-4 transition-colors hover:bg-dls-hover" onClick={props.onToggle}>
        <div className="flex items-center gap-3">
          <Settings2 size={16} className="text-dls-secondary" />
          <div className="text-left">
            <div className="text-sm font-medium text-dls-text">{t("mcp.advanced_settings")}</div>
            <div className="text-xs text-dls-secondary">{t("mcp.advanced_settings_hint")}</div>
          </div>
        </div>
        <div className={`transition-transform ${props.open ? "rotate-180" : ""}`}>
          <ChevronDown size={16} className="text-dls-secondary" />
        </div>
      </button>
      {props.open ? (
        <div className="animate-in fade-in slide-in-from-top-1 space-y-4 border-t border-dls-border px-5 py-4 duration-200">
          <div className="flex items-center gap-1.5">
            <McpConfigScopeButton scope="project" activeScope={props.configScope} onScopeChange={props.onScopeChange} />
            <McpConfigScopeButton scope="global" activeScope={props.configScope} onScopeChange={props.onScopeChange} />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <div className="text-dls-secondary">{t("mcp.config_file")}</div>
            <div className="truncate font-mono text-[11px] text-dls-secondary/80">
              {props.activeConfig?.path ?? t("mcp.config_not_loaded")}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => void props.onReveal()} disabled={!props.canRevealConfig}>
                {props.revealBusy ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {t("mcp.opening_label")}
                  </>
                ) : (
                  <>
                    <FolderOpen size={14} />
                    {props.revealLabel}
                  </>
                )}
              </Button>
              <a href="https://opencode.ai/docs/mcp-servers/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-dls-secondary transition-colors hover:text-dls-text">
                {t("mcp.docs_link")}
                <ExternalLink size={11} />
              </a>
            </div>
            {props.activeConfig && props.activeConfig.exists === false ? <div className="text-[11px] text-dls-secondary">{t("mcp.file_not_found")}</div> : null}
          </div>
          {props.configError ? <div className="text-xs text-red-11">{props.configError}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function McpConfigScopeButton(props: {
  scope: ConfigScope;
  activeScope: ConfigScope;
  onScopeChange: (scope: ConfigScope) => void;
}) {
  return (
    <button
      type="button"
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        props.activeScope === props.scope
          ? "bg-dls-active text-dls-text"
          : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
      }`}
      onClick={() => props.onScopeChange(props.scope)}
    >
      {props.scope === "project" ? t("mcp.scope_project") : t("mcp.scope_global")}
    </button>
  );
}

export default McpView;
