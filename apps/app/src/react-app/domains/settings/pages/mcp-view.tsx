/** @jsxImportSource react */
import { useEffect, useReducer, useRef, type SetStateAction } from "react";
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  Chrome,
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
  Power,
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
  getMcpIdentityKey,
  normalizeMcpSlug,
} from "../../../../app/mcp";
import type { McpServerEntry, McpStatusMap } from "../../../../app/types";
import { formatRelativeTime, isDesktopRuntime, isWindowsPlatform } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { AddMcpModal } from "../../connections/modals/add-mcp-modal";
import { ChromeConnectionSetupModal } from "../../connections/modals/chrome-connection-setup-modal";
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
  setMcpEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
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
  const showHeader = props.showHeader !== false;

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
    chromeSetupOpen,
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
  const setChromeSetupOpen = (value: SetStateAction<boolean>) => setLocal("chromeSetupOpen", value);
  const configRequestId = useRef(0);

  const quickConnectList = props.quickConnect;

  useEffect(() => {
    const root = props.selectedWorkspaceRoot.trim();
    const nextId = configRequestId.current + 1;
    configRequestId.current = nextId;
    const readConfig = props.readConfigFile;

    if (!readConfig && !isDesktopRuntime()) {
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
              : readOpencodeConfig("project", root)
            : Promise.resolve(null),
          readConfig ? readConfig("global") : readOpencodeConfig("global", root),
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
  }, [props.readConfigFile, props.selectedWorkspaceRoot]);

  const activeConfig = configScope === "project" ? projectConfig : globalConfig;

  const revealLabel = isWindowsPlatform()
    ? t("mcp.open_file")
    : t("mcp.reveal_in_finder");

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
      setConfigError(t("mcp.pick_workspace_error"));
      return;
    }

    setRevealBusy(true);
    setConfigError(null);
    try {
      const resolved = props.readConfigFile
        ? await props.readConfigFile(configScope)
        : await readOpencodeConfig(configScope, root);
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
        <div className="whitespace-pre-wrap break-words rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary">
          {props.mcpStatus}
        </div>
      ) : null}

      {/* Chrome setup card removed -- built-in browser handles this automatically */}

      <McpCustomAppCard onOpen={() => setAddMcpModalOpen(true)} />

      <McpQuickConnectSection
        entries={quickConnectList}
        busy={props.busy}
        connectingName={props.mcpConnectingName}
        isConfigured={isQuickConnectConfigured}
        statusForEntry={quickConnectStatus}
        onConnect={props.connectMcp}
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

      <ChromeConnectionSetupModal
        open={chromeSetupOpen}
        onClose={() => setChromeSetupOpen(false)}
      />
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

function McpChromeSetupCard(props: { onOpen: () => void }) {
  return (
    <div className="rounded-2xl border border-amber-6/30 bg-[linear-gradient(180deg,rgba(245,158,11,0.08),rgba(245,158,11,0.03))] p-5 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="text-base font-semibold text-dls-text">{t("chrome_setup.title")}</div>
          <div className="text-sm text-dls-secondary">{t("chrome_setup.subtitle")}</div>
        </div>
        <Button variant="outline" onClick={props.onOpen}>
          <Chrome size={14} />
          {t("chrome_setup.test_connection")}
        </Button>
      </div>
    </div>
  );
}

function McpCustomAppCard(props: { onOpen: () => void }) {
  return (
    <div className="rounded-2xl border border-blue-6/30 bg-[linear-gradient(180deg,rgba(59,130,246,0.08),rgba(59,130,246,0.03))] p-5 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="text-base font-semibold text-dls-text">{t("mcp.add_modal_title")}</div>
          <div className="text-sm text-dls-secondary">{t("mcp.custom_app_cta_hint")}</div>
        </div>
        <Button variant="secondary" onClick={props.onOpen}>
          <Plus size={14} />
          {t("mcp.add_modal_title")}
        </Button>
      </div>
    </div>
  );
}

function McpQuickConnectSection(props: {
  entries: McpDirectoryInfo[];
  busy: boolean;
  connectingName: string | null;
  isConfigured: (entry: McpDirectoryInfo) => boolean;
  statusForEntry: (entry: McpDirectoryInfo) => { status: ReactMcpStatus } | undefined;
  onConnect: (entry: McpDirectoryInfo) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-dls-secondary">
          {t("mcp.available_apps")}
        </h3>
        <span className="text-[11px] text-dls-secondary">{t("mcp.one_click_connect")}</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {props.entries.map((entry) => {
          const configured = props.isConfigured(entry);
          const connecting = props.connectingName === entry.name;
          const Icon = serviceIcon(entry.name);
          const quickStatus = !configured ? props.statusForEntry(entry) : undefined;

          return (
            <div key={getMcpIdentityKey(entry)} className="relative">
              <button
                type="button"
                disabled={configured || props.busy || connecting}
                onClick={() => {
                  if (!configured) props.onConnect(entry);
                }}
                className={`group w-full rounded-xl border p-4 text-left transition-all ${
                  configured
                    ? "border-green-6 bg-green-2"
                    : "border-dls-border bg-dls-surface hover:bg-dls-hover hover:shadow-[0_4px_16px_rgba(17,24,39,0.06)]"
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`flex size-10 shrink-0 items-center justify-center rounded-lg border ${
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
                          {t("mcp.connected_badge")}
                        </span>
                      ) : null}
                      {!configured && quickStatus ? (
                        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeStyle(quickStatus.status)}`}>
                          {friendlyStatus(quickStatus.status)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-dls-secondary">{entry.description}</p>
                    {!configured && !connecting ? (
                      <div className="mt-2 text-[11px] font-medium text-blue-11 transition-colors group-hover:text-blue-12">
                        {t("mcp.tap_to_connect")}
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
            className="!px-3 !py-1.5 !text-xs"
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
          variant="danger"
          className="!px-3 !py-1.5 !text-xs"
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
          <Button variant="secondary" className="px-3 py-1.5 text-xs" disabled={props.busy} onClick={() => props.onAuthorize(props.entry)}>
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
          variant="danger"
          className="px-3 py-1.5 text-xs"
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
              <Button variant="secondary" onClick={() => void props.onReveal()} disabled={!props.canRevealConfig}>
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
