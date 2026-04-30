/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Code2,
  CreditCard,
  ExternalLink,
  FolderOpen,
  Globe,
  Loader2,
  MonitorSmartphone,
  Plug2,
  Plus,
  Settings,
  Settings2,
  Unplug,
  Zap,
} from "lucide-react";

import { type McpDirectoryInfo } from "../../../../app/constants";
import {
  openDesktopPath,
  readOpencodeConfig,
  revealDesktopItemInDir,
  type OpencodeConfigFile,
} from "../../../../app/lib/desktop";
import {
  buildChromeDevtoolsCommand,
  getMcpIdentityKey,
  isChromeDevtoolsMcp,
  normalizeMcpSlug,
  usesChromeDevtoolsAutoConnect,
} from "../../../../app/mcp";
import type { McpServerEntry, McpStatusMap } from "../../../../app/types";
import { formatRelativeTime, isDesktopRuntime, isWindowsPlatform } from "../../../../app/utils";
import { currentLocale, t, type Language } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { AddMcpModal } from "../../connections/modals/add-mcp-modal";
import { ControlChromeSetupModal } from "../../connections/modals/control-chrome-setup-modal";

export type ReactMcpStatus =
  | "connected"
  | "needs_auth"
  | "needs_client_registration"
  | "failed"
  | "disabled"
  | "disconnected";

export type McpViewProps = {
  busy: boolean;
  selectedWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
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
};

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

const friendlyStatus = (status: ReactMcpStatus, locale: Language) => {
  switch (status) {
    case "connected":
      return t("mcp.friendly_status_ready", locale);
    case "needs_auth":
    case "needs_client_registration":
      return t("mcp.friendly_status_needs_signin", locale);
    case "disabled":
      return t("mcp.friendly_status_paused", locale);
    case "disconnected":
      return t("mcp.friendly_status_offline", locale);
    default:
      return t("mcp.friendly_status_issue", locale);
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
  if (lower.includes("chrome") || lower.includes("devtools")) {
    return MonitorSmartphone;
  }
  return Plug2;
};

const serviceColor = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return "text-gray-12";
  if (lower.includes("linear")) return "text-blue-11";
  if (lower.includes("sentry")) return "text-purple-11";
  if (lower.includes("stripe")) return "text-blue-11";
  if (lower.includes("context")) return "text-green-11";
  if (lower.includes("chrome") || lower.includes("devtools")) {
    return "text-amber-11";
  }
  return "text-dls-secondary";
};

const serviceIconBg = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return "bg-gray-3 border-gray-6";
  if (lower.includes("linear")) return "bg-blue-3 border-blue-6";
  if (lower.includes("sentry")) return "bg-purple-3 border-purple-6";
  if (lower.includes("stripe")) return "bg-blue-3 border-blue-6";
  if (lower.includes("context")) return "bg-green-3 border-green-6";
  if (lower.includes("chrome") || lower.includes("devtools")) {
    return "bg-amber-3 border-amber-6";
  }
  return "bg-dls-hover border-dls-border";
};

export function McpView(props: McpViewProps) {
  const locale = currentLocale();
  const tr = (key: string) => t(key, locale);
  const showHeader = props.showHeader !== false;

  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutTarget, setLogoutTarget] = useState<string | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [configScope, setConfigScope] = useState<"project" | "global">("project");
  const [projectConfig, setProjectConfig] = useState<OpencodeConfigFile | null>(null);
  const [globalConfig, setGlobalConfig] = useState<OpencodeConfigFile | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [revealBusy, setRevealBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [addMcpModalOpen, setAddMcpModalOpen] = useState(false);
  const [controlChromeModalOpen, setControlChromeModalOpen] = useState(false);
  const [controlChromeModalMode, setControlChromeModalMode] = useState<"connect" | "edit">("connect");
  const [controlChromeExistingProfile, setControlChromeExistingProfile] = useState(false);
  const configRequestId = useRef(0);

  const quickConnectList = props.quickConnect;

  useEffect(() => {
    const root = props.selectedWorkspaceRoot.trim();
    const nextId = configRequestId.current + 1;
    configRequestId.current = nextId;
    const readConfig = props.readConfigFile;

    if (!readConfig && !isDesktopRuntime()) {
      setProjectConfig(null);
      setGlobalConfig(null);
      setConfigError(null);
      return;
    }

    void (async () => {
      try {
        setConfigError(null);
        const [project, global] = await Promise.all([
          root
            ? readConfig
              ? readConfig("project")
              : readOpencodeConfig("project", root)
            : Promise.resolve(null),
          readConfig ? readConfig("global") : readOpencodeConfig("global", root),
        ]);
        if (nextId !== configRequestId.current) return;
        setProjectConfig(project);
        setGlobalConfig(global);
      } catch (error) {
        if (nextId !== configRequestId.current) return;
        setProjectConfig(null);
        setGlobalConfig(null);
        setConfigError(
          error instanceof Error ? error.message : tr("mcp.config_load_failed"),
        );
      }
    })();
  }, [locale, props.readConfigFile, props.selectedWorkspaceRoot]);

  const activeConfig = configScope === "project" ? projectConfig : globalConfig;

  const revealLabel = isWindowsPlatform()
    ? tr("mcp.open_file")
    : tr("mcp.reveal_in_finder");

  const canRevealConfig =
    isDesktopRuntime() &&
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

  const openControlChromeModal = (
    mode: "connect" | "edit",
    existingEntry?: McpServerEntry | null,
  ) => {
    setControlChromeModalMode(mode);
    setControlChromeExistingProfile(
      usesChromeDevtoolsAutoConnect(existingEntry?.config.command),
    );
    setControlChromeModalOpen(true);
  };

  const saveControlChromeSettings = (useExistingProfile: boolean) => {
    const controlChrome = quickConnectList.find((entry) => isChromeDevtoolsMcp(entry));
    if (!controlChrome) return;
    const existingEntry = props.mcpServers.find((entry) => isChromeDevtoolsMcp(entry.name));

    props.connectMcp({
      ...controlChrome,
      command: buildChromeDevtoolsCommand(
        existingEntry?.config.command ?? controlChrome.command,
        useExistingProfile,
      ),
    });
    setControlChromeModalOpen(false);
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
      setConfigError(tr("mcp.pick_workspace_error"));
      return;
    }

    setRevealBusy(true);
    setConfigError(null);
    try {
      const resolved = props.readConfigFile
        ? await props.readConfigFile(configScope)
        : await readOpencodeConfig(configScope, root);
      if (!resolved) {
        throw new Error(tr("mcp.config_load_failed"));
      }
      if (isWindowsPlatform()) {
        await openDesktopPath(resolved.path);
      } else {
        await revealDesktopItemInDir(resolved.path);
      }
    } catch (error) {
      setConfigError(
        error instanceof Error ? error.message : tr("mcp.reveal_config_failed"),
      );
    } finally {
      setRevealBusy(false);
    }
  };

  return (
    <section className="space-y-8 animate-in fade-in duration-300">
      {showHeader ? (
        <div>
          <h2 className="text-3xl font-bold text-dls-text">{tr("mcp.apps_title")}</h2>
          <p className="mt-1.5 text-sm text-dls-secondary">{tr("mcp.apps_subtitle")}</p>
          {connectedCount > 0 ? (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-green-3 px-3 py-1">
              <div className="h-2 w-2 rounded-full bg-green-9" />
              <span className="text-xs font-medium text-green-11">
                {connectedCount} {connectedCount === 1 ? tr("mcp.app_connected") : tr("mcp.apps_connected")}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {props.mcpStatus ? (
        <div className="whitespace-pre-wrap break-words rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary">
          {props.mcpStatus}
        </div>
      ) : null}

      <div className="rounded-2xl border border-blue-6/30 bg-[linear-gradient(180deg,rgba(59,130,246,0.08),rgba(59,130,246,0.03))] px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="text-base font-semibold text-dls-text">{tr("mcp.add_modal_title")}</div>
            <div className="text-sm text-dls-secondary">{tr("mcp.custom_app_cta_hint")}</div>
          </div>
          <Button variant="secondary" onClick={() => setAddMcpModalOpen(true)}>
            <Plus size={14} />
            {tr("mcp.add_modal_title")}
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-dls-secondary">
            {tr("mcp.available_apps")}
          </h3>
          <span className="text-[11px] text-dls-secondary">{tr("mcp.one_click_connect")}</span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {quickConnectList.map((entry) => {
            const configured = isQuickConnectConfigured(entry);
            const connecting = props.mcpConnectingName === entry.name;
            const Icon = serviceIcon(entry.name);
            const controlChrome = isChromeDevtoolsMcp(entry);
            const quickStatus = !configured ? quickConnectStatus(entry) : undefined;

            return (
              <div key={getMcpIdentityKey(entry)} className="relative">
                {controlChrome && configured ? (
                  <button
                    type="button"
                    className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-green-6 bg-white/90 text-green-11 transition-colors hover:bg-white"
                    aria-label={tr("mcp.control_chrome_edit")}
                    onClick={(event) => {
                      event.stopPropagation();
                      const existingEntry = props.mcpServers.find(
                        (server) => server.name === getMcpIdentityKey(entry),
                      );
                      openControlChromeModal("edit", existingEntry);
                    }}
                  >
                    <Settings size={14} />
                  </button>
                ) : null}

                <button
                  type="button"
                  disabled={configured || props.busy || connecting}
                  onClick={() => {
                    if (configured) return;
                    if (controlChrome) {
                      openControlChromeModal("connect");
                      return;
                    }
                    props.connectMcp(entry);
                  }}
                  className={`group w-full rounded-xl border p-4 text-left transition-all ${
                    configured
                      ? "border-green-6 bg-green-2"
                      : "border-dls-border bg-dls-surface hover:bg-dls-hover hover:shadow-[0_4px_16px_rgba(17,24,39,0.06)]"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${
                        configured ? "border-green-6 bg-green-3" : serviceIconBg(entry.name)
                      }`}
                    >
                      {connecting ? (
                        <Loader2 size={18} className="animate-spin text-dls-secondary" />
                      ) : configured ? (
                        <CheckCircle2 size={18} className="text-green-11" />
                      ) : (
                        <Icon size={18} className={serviceColor(entry.name)} />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 pr-10">
                        <h4 className="text-sm font-semibold text-dls-text">{entry.name}</h4>
                        {configured ? (
                          <span className="rounded-md bg-green-3 px-1.5 py-0.5 text-[10px] font-medium text-green-11">
                            {tr("mcp.connected_badge")}
                          </span>
                        ) : null}
                        {!configured && quickStatus ? (
                          <span
                            className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeStyle(
                              quickStatus.status,
                            )}`}
                          >
                            {friendlyStatus(quickStatus.status, locale)}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs text-dls-secondary">
                        {entry.description}
                      </p>
                      {!configured && !connecting ? (
                        <div className="mt-2 text-[11px] font-medium text-blue-11 transition-colors group-hover:text-blue-12">
                          {tr("mcp.tap_to_connect")}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-dls-secondary">
            {tr("mcp.your_apps")}
          </h3>
          {props.mcpLastUpdatedAt ? (
            <span className="tabular-nums text-[11px] text-dls-secondary">
              {tr("mcp.last_synced")} {formatRelativeTime(props.mcpLastUpdatedAt ?? Date.now())}
            </span>
          ) : null}
        </div>

        {props.mcpServers.length ? (
          <div className="space-y-2">
            {props.mcpServers.map((entry) => {
              const status = resolveStatus(entry);
              const Icon = serviceIcon(entry.name);
              const isSelected = props.selectedMcp === entry.name;
              const resolvedStatus = props.mcpStatuses[entry.name];
              const errorInfo =
                resolvedStatus && resolvedStatus.status === "failed"
                  ? "error" in resolvedStatus
                    ? resolvedStatus.error
                    : tr("mcp.connection_failed")
                  : null;

              return (
                <div
                  key={entry.name}
                  className={`rounded-xl border transition-all ${
                    isSelected
                      ? "border-blue-7 bg-blue-2 shadow-sm"
                      : "border-dls-border bg-dls-surface hover:bg-dls-hover"
                  }`}
                >
                  <button
                    type="button"
                    className="w-full px-4 py-3.5 text-left"
                    onClick={() => props.setSelectedMcp(isSelected ? null : entry.name)}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                          status === "connected"
                            ? "border-green-6 bg-green-3"
                            : serviceIconBg(entry.name)
                        }`}
                      >
                        <Icon
                          size={15}
                          className={
                            status === "connected" ? "text-green-11" : serviceColor(entry.name)
                          }
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-dls-text">
                          {displayName(entry.name)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <div className={`h-2 w-2 rounded-full ${statusDot(status)}`} />
                        <span className="text-[11px] text-dls-secondary">
                          {friendlyStatus(status, locale)}
                        </span>
                      </div>
                      <div className={`transition-transform ${isSelected ? "rotate-180" : ""}`}>
                        <ChevronDown size={14} className="text-dls-secondary/40" />
                      </div>
                    </div>
                  </button>

                  {isSelected ? (
                    <div className="animate-in fade-in slide-in-from-top-1 space-y-3 border-t border-blue-6/20 px-4 py-3 duration-200">
                      <div className="flex items-center gap-4 text-xs">
                        <span className="text-dls-secondary">{tr("mcp.connection_type")}</span>
                        <span className="text-dls-text">
                          {entry.config.type === "remote" ? tr("mcp.type_cloud") : tr("mcp.type_local")}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="rounded-md border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-dls-text">
                          {tr("mcp.cap_tools")}
                        </span>
                        {entry.config.type === "remote" ? (
                          <span className="rounded-md border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-dls-text">
                            {tr("mcp.cap_signin")}
                          </span>
                        ) : null}
                      </div>

                      {errorInfo ? (
                        <div className="rounded-lg border border-red-6 bg-red-2 px-3 py-2 text-xs text-red-11">
                          {errorInfo}
                        </div>
                      ) : null}

                      <details className="group">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-dls-secondary transition-colors hover:text-dls-text">
                          <Code2 size={11} />
                          {tr("mcp.technical_details")}
                          <ChevronDown size={10} className="transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="mt-1.5 break-all rounded-lg bg-dls-hover px-3 py-2 font-mono text-[11px] text-dls-secondary">
                          {entry.config.type === "remote"
                            ? entry.config.url
                            : entry.config.command?.join(" ")}
                        </div>
                      </details>

                      {supportsOauth(entry) && status !== "connected" ? (
                        <>
                          <div className="flex items-center justify-between gap-3 pt-1">
                            <div className="text-xs text-dls-secondary">{tr("mcp.logout_label")}</div>
                            <Button
                              variant="secondary"
                              className="px-3 py-1.5 text-xs"
                              disabled={props.busy}
                              onClick={() => props.authorizeMcp(entry)}
                            >
                              {tr("mcp.login_action")}
                            </Button>
                          </div>
                          <div className="text-[11px] text-dls-secondary/70">{tr("mcp.login_hint")}</div>
                        </>
                      ) : null}

                      {supportsOauth(entry) && status === "connected" ? (
                        <>
                          <div className="flex items-center justify-between gap-3 pt-1">
                            <div className="text-xs text-dls-secondary">{tr("mcp.logout_label")}</div>
                            <Button
                              variant="danger"
                              className="px-3 py-1.5 text-xs"
                              disabled={props.busy || logoutBusy}
                              onClick={() => requestLogout(entry.name)}
                            >
                              {logoutBusy && logoutTarget === entry.name
                                ? tr("mcp.logout_working")
                                : tr("mcp.logout_action")}
                            </Button>
                          </div>
                          <div className="text-[11px] text-dls-secondary/70">{tr("mcp.logout_hint")}</div>
                        </>
                      ) : null}

                      <div className="flex justify-end gap-2 pt-1">
                        {isChromeDevtoolsMcp(entry.name) ? (
                          <Button
                            variant="outline"
                            className="!px-3 !py-1.5 !text-xs"
                            onClick={() => openControlChromeModal("edit", entry)}
                          >
                            <Settings size={13} />
                            {tr("mcp.control_chrome_edit")}
                          </Button>
                        ) : null}
                        <Button
                          variant="danger"
                          className="!px-3 !py-1.5 !text-xs"
                          onClick={(event) => {
                            event.stopPropagation();
                            setRemoveTarget(entry.name);
                            setRemoveOpen(true);
                          }}
                        >
                          {tr("mcp.remove_app")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-dls-border px-5 py-10 text-center">
            <Unplug size={24} className="mx-auto mb-3 text-dls-secondary/30" />
            <div className="text-sm font-medium text-dls-secondary">{tr("mcp.no_apps_yet")}</div>
            <div className="mt-1 text-xs text-dls-secondary/60">{tr("mcp.no_apps_hint")}</div>
          </div>
        )}
      </div>

      <ConfirmModal
        open={logoutOpen}
        title={tr("mcp.logout_modal_title")}
        message={tr("mcp.logout_modal_message").replace("{server}", displayName(logoutTarget ?? ""))}
        confirmLabel={logoutBusy ? tr("mcp.logout_working") : tr("mcp.logout_action")}
        cancelLabel={tr("common.cancel")}
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
        title={tr("mcp.remove_modal_title")}
        message={tr("mcp.remove_modal_message").replace("{server}", displayName(removeTarget ?? ""))}
        confirmLabel={tr("mcp.remove_app")}
        cancelLabel={tr("common.cancel")}
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

      <div className="overflow-hidden rounded-xl border border-dls-border bg-dls-surface">
        <button
          type="button"
          className="flex w-full items-center justify-between px-5 py-4 transition-colors hover:bg-dls-hover"
          onClick={() => setShowAdvanced((current) => !current)}
        >
          <div className="flex items-center gap-3">
            <Settings2 size={16} className="text-dls-secondary" />
            <div className="text-left">
              <div className="text-sm font-medium text-dls-text">{tr("mcp.advanced_settings")}</div>
              <div className="text-xs text-dls-secondary">{tr("mcp.advanced_settings_hint")}</div>
            </div>
          </div>
          <div className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`}>
            <ChevronDown size={16} className="text-dls-secondary" />
          </div>
        </button>

        {showAdvanced ? (
          <div className="animate-in fade-in slide-in-from-top-1 space-y-4 border-t border-dls-border px-5 py-4 duration-200">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  configScope === "project"
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                }`}
                onClick={() => setConfigScope("project")}
              >
                {tr("mcp.scope_project")}
              </button>
              <button
                type="button"
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  configScope === "global"
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                }`}
                onClick={() => setConfigScope("global")}
              >
                {tr("mcp.scope_global")}
              </button>
            </div>

            <div className="flex flex-col gap-1 text-xs">
              <div className="text-dls-secondary">{tr("mcp.config_file")}</div>
              <div className="truncate font-mono text-[11px] text-dls-secondary/80">
                {activeConfig?.path ?? tr("mcp.config_not_loaded")}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => void revealConfig()} disabled={!canRevealConfig}>
                  {revealBusy ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      {tr("mcp.opening_label")}
                    </>
                  ) : (
                    <>
                      <FolderOpen size={14} />
                      {revealLabel}
                    </>
                  )}
                </Button>
                <a
                  href="https://opencode.ai/docs/mcp-servers/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-dls-secondary transition-colors hover:text-dls-text"
                >
                  {tr("mcp.docs_link")}
                  <ExternalLink size={11} />
                </a>
              </div>
              {activeConfig && activeConfig.exists === false ? (
                <div className="text-[11px] text-dls-secondary">{tr("mcp.file_not_found")}</div>
              ) : null}
            </div>

            {configError ? <div className="text-xs text-red-11">{configError}</div> : null}
          </div>
        ) : null}
      </div>

      <AddMcpModal
        open={addMcpModalOpen}
        onClose={() => setAddMcpModalOpen(false)}
        onAdd={(entry) => props.connectMcp(entry)}
        busy={props.busy}
        isRemoteWorkspace={props.isRemoteWorkspace}
        language={locale}
      />

      <ControlChromeSetupModal
        open={controlChromeModalOpen}
        busy={props.busy || props.mcpConnectingName === "Control Chrome"}
        language={locale}
        mode={controlChromeModalMode}
        initialUseExistingProfile={controlChromeExistingProfile}
        onClose={() => setControlChromeModalOpen(false)}
        onSave={saveControlChromeSettings}
      />
    </section>
  );
}

export default McpView;
