import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import type { McpServerEntry, McpStatusMap } from "../types";
import type { McpDirectoryInfo } from "../constants";
import { formatRelativeTime, isTauriRuntime, isWindowsPlatform } from "../utils";
import { readOpencodeConfig, type OpencodeConfigFile } from "../lib/tauri";

import Button from "../components/button";
import AddMcpModal from "../components/add-mcp-modal";
import ConfirmModal from "../components/confirm-modal";
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
  RefreshCw,
  Settings2,
  Unplug,
  Users,
  Zap,
} from "lucide-solid";
import { currentLocale, t, type Language } from "../../i18n";

export type McpViewProps = {
  busy: boolean;
  activeWorkspaceRoot: string;
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
  logoutMcpAuth: (name: string) => Promise<void> | void;
  removeMcp: (name: string) => void;
  showMcpReloadBanner: boolean;
  reloadBlocked: boolean;
  reloadMcpEngine: () => void;
};

/* ── Status helpers ─────────────────────────────────── */

type McpStatus = "connected" | "needs_auth" | "needs_client_registration" | "failed" | "disabled" | "disconnected";

const statusDot = (status: McpStatus) => {
  switch (status) {
    case "connected": return "bg-green-9";
    case "needs_auth":
    case "needs_client_registration": return "bg-amber-9";
    case "disabled": return "bg-gray-8";
    case "disconnected": return "bg-gray-7";
    default: return "bg-red-9";
  }
};

const friendlyStatus = (status: McpStatus, locale: Language) => {
  switch (status) {
    case "connected": return t("mcp.friendly_status_ready", locale);
    case "needs_auth":
    case "needs_client_registration": return t("mcp.friendly_status_needs_signin", locale);
    case "disabled": return t("mcp.friendly_status_paused", locale);
    case "disconnected": return t("mcp.friendly_status_offline", locale);
    default: return t("mcp.friendly_status_issue", locale);
  }
};

const statusBadgeStyle = (status: McpStatus) => {
  switch (status) {
    case "connected": return "bg-green-3 text-green-11";
    case "needs_auth":
    case "needs_client_registration": return "bg-amber-3 text-amber-11";
    case "disabled":
    case "disconnected": return "bg-gray-3 text-gray-11";
    default: return "bg-red-3 text-red-11";
  }
};

/* ── Icon mapping for known services ────────────────── */

const serviceIcon = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return BookOpen;
  if (lower.includes("linear")) return Zap;
  if (lower.includes("sentry")) return CircleAlert;
  if (lower.includes("stripe")) return CreditCard;
  if (lower.includes("hubspot")) return Users;
  if (lower.includes("context")) return Globe;
  if (lower.includes("chrome") || lower.includes("devtools")) return MonitorSmartphone;
  return Plug2;
};

const serviceColor = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return "text-gray-12";
  if (lower.includes("linear")) return "text-blue-11";
  if (lower.includes("sentry")) return "text-purple-11";
  if (lower.includes("stripe")) return "text-blue-11";
  if (lower.includes("hubspot")) return "text-orange-11";
  if (lower.includes("context")) return "text-green-11";
  if (lower.includes("chrome") || lower.includes("devtools")) return "text-amber-11";
  return "text-dls-secondary";
};

const serviceIconBg = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return "bg-gray-3 border-gray-6";
  if (lower.includes("linear")) return "bg-blue-3 border-blue-6";
  if (lower.includes("sentry")) return "bg-purple-3 border-purple-6";
  if (lower.includes("stripe")) return "bg-blue-3 border-blue-6";
  if (lower.includes("hubspot")) return "bg-orange-3 border-orange-6";
  if (lower.includes("context")) return "bg-green-3 border-green-6";
  if (lower.includes("chrome") || lower.includes("devtools")) return "bg-amber-3 border-amber-6";
  return "bg-dls-hover border-dls-border";
};

/* ── Component ──────────────────────────────────────── */

export default function McpView(props: McpViewProps) {
  const locale = () => currentLocale();
  const tr = (key: string) => t(key, locale());
  const showHeader = () => props.showHeader !== false;

  const [logoutOpen, setLogoutOpen] = createSignal(false);
  const [logoutTarget, setLogoutTarget] = createSignal<string | null>(null);
  const [logoutBusy, setLogoutBusy] = createSignal(false);

  const [removeOpen, setRemoveOpen] = createSignal(false);
  const [removeTarget, setRemoveTarget] = createSignal<string | null>(null);

  const [configScope, setConfigScope] = createSignal<"project" | "global">("project");
  const [projectConfig, setProjectConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [globalConfig, setGlobalConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [configError, setConfigError] = createSignal<string | null>(null);
  const [revealBusy, setRevealBusy] = createSignal(false);
  const [showAdvanced, setShowAdvanced] = createSignal(false);
  const [addMcpModalOpen, setAddMcpModalOpen] = createSignal(false);

  const selectedEntry = createMemo(() =>
    props.mcpServers.find((entry) => entry.name === props.selectedMcp) ?? null,
  );

  const quickConnectList = createMemo(() => props.quickConnect);

  let configRequestId = 0;
  createEffect(() => {
    const root = props.activeWorkspaceRoot.trim();
    const nextId = (configRequestId += 1);

    if (!isTauriRuntime()) {
      setProjectConfig(null);
      setGlobalConfig(null);
      setConfigError(null);
      return;
    }

    void (async () => {
      try {
        setConfigError(null);
        const [project, global] = await Promise.all([
          root ? readOpencodeConfig("project", root) : Promise.resolve(null),
          readOpencodeConfig("global", root),
        ]);
        if (nextId !== configRequestId) return;
        setProjectConfig(project);
        setGlobalConfig(global);
      } catch (e) {
        if (nextId !== configRequestId) return;
        setProjectConfig(null);
        setGlobalConfig(null);
        setConfigError(e instanceof Error ? e.message : tr("mcp.config_load_failed"));
      }
    })();
  });

  const activeConfig = createMemo(() =>
    configScope() === "project" ? projectConfig() : globalConfig(),
  );

  const revealLabel = () =>
    isWindowsPlatform() ? tr("mcp.open_file") : tr("mcp.reveal_in_finder");

  const canRevealConfig = () => {
    if (!isTauriRuntime() || revealBusy()) return false;
    if (configScope() === "project" && !props.activeWorkspaceRoot.trim()) return false;
    return Boolean(activeConfig()?.exists);
  };

  const revealConfig = async () => {
    if (!isTauriRuntime() || revealBusy()) return;
    const root = props.activeWorkspaceRoot.trim();

    if (configScope() === "project" && !root) {
      setConfigError(tr("mcp.pick_workspace_error"));
      return;
    }

    setRevealBusy(true);
    setConfigError(null);
    try {
      const resolved = await readOpencodeConfig(configScope(), root);
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      if (isWindowsPlatform()) {
        await openPath(resolved.path);
      } else {
        await revealItemInDir(resolved.path);
      }
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : tr("mcp.reveal_config_failed"));
    } finally {
      setRevealBusy(false);
    }
  };

  const toSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  const quickConnectStatus = (name: string) => {
    const slug = toSlug(name);
    return props.mcpStatuses[slug];
  };

  const isQuickConnectConnected = (name: string) => {
    const status = quickConnectStatus(name);
    return status?.status === "connected";
  };

  const canConnect = () => !props.busy;

  const resolveStatus = (entry: McpServerEntry): McpStatus => {
    if (entry.config.enabled === false) return "disabled";
    const resolved = props.mcpStatuses[entry.name];
    return resolved?.status ? resolved.status : "disconnected";
  };

  const connectedCount = createMemo(() =>
    props.mcpServers.filter((e) => resolveStatus(e) === "connected").length,
  );

  const requestLogout = (name: string) => {
    if (!name.trim()) return;
    setLogoutTarget(name);
    setLogoutOpen(true);
  };

  const confirmLogout = async () => {
    const name = logoutTarget();
    if (!name || logoutBusy()) return;
    setLogoutBusy(true);
    try {
      await props.logoutMcpAuth(name);
    } finally {
      setLogoutBusy(false);
      setLogoutOpen(false);
      setLogoutTarget(null);
    }
  };

  return (
    <section class="space-y-8 animate-in fade-in duration-300">
      {/* ── Header ───────────────────────────────────── */}
      <Show when={showHeader()}>
        <div>
          <h2 class="text-3xl font-bold text-dls-text">{tr("mcp.apps_title")}</h2>
          <p class="text-sm text-dls-secondary mt-1.5">
            {tr("mcp.apps_subtitle")}
          </p>
          <Show when={connectedCount() > 0}>
            <div class="mt-3 inline-flex items-center gap-2 rounded-full bg-green-3 px-3 py-1">
              <div class="w-2 h-2 rounded-full bg-green-9" />
              <span class="text-xs font-medium text-green-11">
                {connectedCount()} {connectedCount() === 1 ? tr("mcp.app_connected") : tr("mcp.apps_connected")}
              </span>
            </div>
          </Show>
        </div>
      </Show>

      {/* ── Reload banner ────────────────────────────── */}
      <Show when={props.showMcpReloadBanner}>
        <div class="bg-amber-2 border border-amber-6 rounded-xl px-5 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div class="text-sm font-medium text-amber-11">{tr("mcp.finish_setup")}</div>
            <div class="text-xs text-amber-11/70 mt-0.5">
              {props.reloadBlocked
                ? tr("mcp.reload_banner_description_blocked")
                : tr("mcp.finish_setup_hint")}
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={() => props.reloadMcpEngine()}
            disabled={props.reloadBlocked}
            title={props.reloadBlocked ? tr("mcp.reload_banner_blocked_hint") : undefined}
          >
            <RefreshCw size={14} />
            {tr("mcp.activate_button")}
          </Button>
        </div>
      </Show>

      {/* ── Status message ───────────────────────────── */}
      <Show when={props.mcpStatus}>
        <div class="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary whitespace-pre-wrap break-words">
          {props.mcpStatus}
        </div>
      </Show>

      {/* ── Available apps (Quick Connect) ───────────── */}
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <h3 class="text-[11px] font-bold text-dls-secondary uppercase tracking-widest">
            {tr("mcp.available_apps")}
          </h3>
          <span class="text-[11px] text-dls-secondary">{tr("mcp.one_click_connect")}</span>
        </div>

        <div class="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
          <For each={quickConnectList()}>
            {(entry) => {
              const connected = () => isQuickConnectConnected(entry.name);
              const connecting = () => props.mcpConnectingName === entry.name;
              const Icon = serviceIcon(entry.name);

              return (
                <button
                  type="button"
                  disabled={connected() || !canConnect() || connecting()}
                  onClick={() => { if (!connected()) props.connectMcp(entry); }}
                  class={`group text-left rounded-xl border p-4 transition-all ${
                    connected()
                      ? "border-green-6 bg-green-2"
                      : "border-dls-border bg-dls-surface hover:bg-dls-hover hover:shadow-[0_4px_16px_rgba(17,24,39,0.06)]"
                  }`}
                >
                  <div class="flex items-start gap-3">
                    {/* Icon */}
                    <div class={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border ${
                      connected() ? "bg-green-3 border-green-6" : serviceIconBg(entry.name)
                    }`}>
                      <Show
                        when={!connecting()}
                        fallback={<Loader2 size={18} class="animate-spin text-dls-secondary" />}
                      >
                        <Show
                          when={!connected()}
                          fallback={<CheckCircle2 size={18} class="text-green-11" />}
                        >
                          <Icon size={18} class={serviceColor(entry.name)} />
                        </Show>
                      </Show>
                    </div>

                    {/* Text */}
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <h4 class="text-sm font-semibold text-dls-text">{entry.name}</h4>
                        <Show when={connected()}>
                          <span class="text-[10px] font-medium text-green-11 bg-green-3 px-1.5 py-0.5 rounded-md">
                            {tr("mcp.connected_badge")}
                          </span>
                        </Show>
                        <Show when={!connected() && quickConnectStatus(entry.name)}>
                          {(status) => (
                            <span class={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${statusBadgeStyle(status().status)}`}>
                              {friendlyStatus(status().status, locale())}
                            </span>
                          )}
                        </Show>
                      </div>
                      <p class="text-xs text-dls-secondary mt-0.5 line-clamp-2">
                        {entry.description}
                      </p>
                      <Show when={!connected() && !connecting()}>
                        <div class="mt-2 text-[11px] font-medium text-blue-11 group-hover:text-blue-12 transition-colors">
                          {tr("mcp.tap_to_connect")}
                        </div>
                      </Show>
                    </div>
                  </div>
                </button>
              );
            }}
          </For>
        </div>
      </div>

      {/* ── Your connected apps ──────────────────────── */}
      <div class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h3 class="text-[11px] font-bold text-dls-secondary uppercase tracking-widest">
            {tr("mcp.your_apps")}
          </h3>
          <Show when={props.mcpLastUpdatedAt}>
            <span class="text-[11px] text-dls-secondary tabular-nums">
              {tr("mcp.last_synced")} {formatRelativeTime(props.mcpLastUpdatedAt ?? Date.now())}
            </span>
          </Show>
        </div>

        <Show
          when={props.mcpServers.length}
          fallback={
            <div class="rounded-xl border border-dashed border-dls-border px-5 py-10 text-center">
              <Unplug size={24} class="mx-auto text-dls-secondary/30 mb-3" />
              <div class="text-sm font-medium text-dls-secondary">{tr("mcp.no_apps_yet")}</div>
              <div class="text-xs text-dls-secondary/60 mt-1">{tr("mcp.no_apps_hint")}</div>
            </div>
          }
        >
          <div class="space-y-2">
            <For each={props.mcpServers}>
              {(entry) => {
                const status = () => resolveStatus(entry);
                const Icon = serviceIcon(entry.name);
                const isSelected = () => props.selectedMcp === entry.name;
                const errorInfo = () => {
                  const resolved = props.mcpStatuses[entry.name];
                  if (!resolved || resolved.status !== "failed") return null;
                  return "error" in resolved ? resolved.error : tr("mcp.connection_failed");
                };

                return (
                  <div class={`rounded-xl border transition-all ${
                    isSelected()
                      ? "border-blue-7 bg-blue-2 shadow-sm"
                      : "border-dls-border bg-dls-surface hover:bg-dls-hover"
                  }`}>
                    {/* Clickable row */}
                    <button
                      type="button"
                      class="w-full text-left px-4 py-3.5"
                      onClick={() => props.setSelectedMcp(isSelected() ? null : entry.name)}
                    >
                      <div class="flex items-center gap-3">
                        <div class={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                          status() === "connected" ? "bg-green-3 border-green-6" : serviceIconBg(entry.name)
                        }`}>
                          <Icon size={15} class={status() === "connected" ? "text-green-11" : serviceColor(entry.name)} />
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="text-sm font-medium text-dls-text truncate">{entry.name}</div>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                          <div class={`w-2 h-2 rounded-full ${statusDot(status())}`} />
                          <span class="text-[11px] text-dls-secondary">
                            {friendlyStatus(status(), locale())}
                          </span>
                        </div>
                        <div class={`transition-transform ${isSelected() ? "rotate-180" : ""}`}>
                          <ChevronDown size={14} class="text-dls-secondary/40" />
                        </div>
                      </div>
                    </button>

                    {/* Expandable details */}
                    <Show when={isSelected()}>
                      <div class="border-t border-blue-6/20 px-4 py-3 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                        {/* Connection type */}
                        <div class="flex items-center gap-4 text-xs">
                          <span class="text-dls-secondary">{tr("mcp.connection_type")}</span>
                          <span class="text-dls-text">
                            {entry.config.type === "remote" ? tr("mcp.type_cloud") : tr("mcp.type_local")}
                          </span>
                        </div>

                        {/* Capabilities */}
                        <div class="flex items-center gap-2">
                          <span class="text-[10px] font-medium bg-dls-surface text-dls-text border border-dls-border px-2 py-0.5 rounded-md">
                            {tr("mcp.cap_tools")}
                          </span>
                          <Show when={entry.config.type === "remote"}>
                            <span class="text-[10px] font-medium bg-dls-surface text-dls-text border border-dls-border px-2 py-0.5 rounded-md">
                              {tr("mcp.cap_signin")}
                            </span>
                          </Show>
                        </div>

                        {/* Error */}
                        <Show when={errorInfo()}>
                          {(err) => (
                            <div class="rounded-lg bg-red-2 border border-red-6 px-3 py-2 text-xs text-red-11">
                              {err()}
                            </div>
                          )}
                        </Show>

                        {/* Technical details */}
                        <details class="group">
                          <summary class="flex items-center gap-1.5 text-[11px] text-dls-secondary cursor-pointer hover:text-dls-text transition-colors list-none">
                            <Code2 size={11} />
                            {tr("mcp.technical_details")}
                            <ChevronDown size={10} class="group-open:rotate-180 transition-transform" />
                          </summary>
                          <div class="mt-1.5 rounded-lg bg-dls-hover px-3 py-2 text-[11px] font-mono text-dls-secondary break-all">
                            {entry.config.type === "remote"
                              ? entry.config.url
                              : entry.config.command?.join(" ")}
                          </div>
                        </details>

                        <Show when={entry.config.type === "remote"}>
                          <div class="pt-1 flex items-center justify-between gap-3">
                            <div class="text-xs text-dls-secondary">
                              {tr("mcp.logout_label")}
                            </div>
                            <Button
                              variant="danger"
                              class="px-3 py-1.5 text-xs"
                              disabled={props.busy || logoutBusy()}
                              onClick={() => requestLogout(entry.name)}
                            >
                              {logoutBusy() && logoutTarget() === entry.name ? tr("mcp.logout_working") : tr("mcp.logout_action")}
                            </Button>
                          </div>
                          <div class="text-[11px] text-dls-secondary/70">
                            {tr("mcp.logout_hint")}
                          </div>
                        </Show>

                        <div class="flex justify-end pt-1">
                          <Button
                            variant="danger"
                            class="!px-3 !py-1.5 !text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRemoveTarget(entry.name);
                              setRemoveOpen(true);
                            }}
                          >
                            {tr("mcp.remove_app")}
                          </Button>
                        </div>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <ConfirmModal
        open={logoutOpen()}
        title={tr("mcp.logout_modal_title")}
        message={tr("mcp.logout_modal_message").replace("{server}", logoutTarget() ?? "")}
        confirmLabel={logoutBusy() ? tr("mcp.logout_working") : tr("mcp.logout_action")}
        cancelLabel={tr("common.cancel")}
        variant="danger"
        onCancel={() => {
          if (logoutBusy()) return;
          setLogoutOpen(false);
          setLogoutTarget(null);
        }}
        onConfirm={() => {
          void confirmLogout();
        }}
      />

      <ConfirmModal
        open={removeOpen()}
        title={tr("mcp.remove_modal_title")}
        message={tr("mcp.remove_modal_message").replace("{server}", removeTarget() ?? "")}
        confirmLabel={tr("mcp.remove_app")}
        cancelLabel={tr("common.cancel")}
        variant="danger"
        onCancel={() => {
          setRemoveOpen(false);
          setRemoveTarget(null);
        }}
        onConfirm={() => {
          const target = removeTarget();
          if (target) props.removeMcp(target);
          setRemoveOpen(false);
          setRemoveTarget(null);
        }}
      />

      {/* ── Advanced: Config editor ───────────────────── */}
      <div class="rounded-xl border border-dls-border bg-dls-surface overflow-hidden">
        <button
          type="button"
          class="w-full flex items-center justify-between px-5 py-4 hover:bg-dls-hover transition-colors"
          onClick={() => setShowAdvanced(!showAdvanced())}
        >
          <div class="flex items-center gap-3">
            <Settings2 size={16} class="text-dls-secondary" />
            <div class="text-left">
              <div class="text-sm font-medium text-dls-text">{tr("mcp.advanced_settings")}</div>
              <div class="text-xs text-dls-secondary">{tr("mcp.advanced_settings_hint")}</div>
            </div>
          </div>
          <div class={`transition-transform ${showAdvanced() ? "rotate-180" : ""}`}>
            <ChevronDown size={16} class="text-dls-secondary" />
          </div>
        </button>

        <Show when={showAdvanced()}>
          <div class="border-t border-dls-border px-5 py-4 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
            {/* Scope toggle */}
            <div class="flex items-center gap-1.5">
              <button
                class={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  configScope() === "project"
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                }`}
                onClick={() => setConfigScope("project")}
              >
                {tr("mcp.scope_project")}
              </button>
              <button
                class={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  configScope() === "global"
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                }`}
                onClick={() => setConfigScope("global")}
              >
                {tr("mcp.scope_global")}
              </button>
            </div>

            {/* Config path */}
            <div class="flex flex-col gap-1 text-xs">
              <div class="text-dls-secondary">{tr("mcp.config_file")}</div>
              <div class="text-dls-secondary/80 font-mono text-[11px] truncate">
                {activeConfig()?.path ?? tr("mcp.config_not_loaded")}
              </div>
            </div>

            {/* Actions */}
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2">
                <Button variant="secondary" onClick={revealConfig} disabled={!canRevealConfig()}>
                  <Show
                    when={revealBusy()}
                    fallback={<><FolderOpen size={14} /> {revealLabel()}</>}
                  >
                    <Loader2 size={14} class="animate-spin" />
                    {tr("mcp.opening_label")}
                  </Show>
                </Button>
                <a
                  href="https://opencode.ai/docs/mcp-servers/"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 text-xs text-dls-secondary hover:text-dls-text transition-colors"
                >
                  {tr("mcp.docs_link")}
                  <ExternalLink size={11} />
                </a>
              </div>
              <Show when={activeConfig() && activeConfig()!.exists === false}>
                <div class="text-[11px] text-dls-secondary">{tr("mcp.file_not_found")}</div>
              </Show>
            </div>

            <Show when={configError()}>
              <div class="text-xs text-red-11">{configError()}</div>
            </Show>

            <div class="border-t border-dls-border pt-4">
              <Button variant="secondary" onClick={() => setAddMcpModalOpen(true)}>
                <Plus size={14} />
                {tr("mcp.add_modal_title")}
              </Button>
            </div>
          </div>
        </Show>
      </div>

      <AddMcpModal
        open={addMcpModalOpen()}
        onClose={() => setAddMcpModalOpen(false)}
        onAdd={(entry) => props.connectMcp(entry)}
        busy={props.busy}
        language={locale()}
      />
    </section>
  );
}
