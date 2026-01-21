import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import type { McpServerEntry, McpStatusMap } from "../types";
import type { McpDirectoryInfo } from "../constants";
import { formatRelativeTime, isTauriRuntime, isWindowsPlatform } from "../utils";
import { readOpencodeConfig, type OpencodeConfigFile } from "../lib/tauri";

import Button from "../components/button";
import {
  CheckCircle2,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
  Loader2,
  PlugZap,
  RefreshCcw,
  Server,
  Settings,
  TriangleAlert,
} from "lucide-solid";
import TextInput from "../components/text-input";
import { currentLocale, t, type Language } from "../../i18n";

export type McpViewProps = {
  mode: "host" | "client" | null;
  busy: boolean;
  activeWorkspaceRoot: string;
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  setSelectedMcp: (name: string | null) => void;
  quickConnect: McpDirectoryInfo[];
  connectMcp: (entry: McpDirectoryInfo) => void;
  showMcpReloadBanner: boolean;
  reloadMcpEngine: () => void;
};

const statusBadge = (status: "connected" | "needs_auth" | "needs_client_registration" | "failed" | "disabled" | "disconnected") => {
  switch (status) {
    case "connected":
      return "bg-green-7/10 text-green-11 border-green-7/20";
    case "needs_auth":
    case "needs_client_registration":
      return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    case "disabled":
      return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    case "disconnected":
      return "bg-gray-2/80 text-gray-12 border-gray-7/50";
    default:
      return "bg-red-7/10 text-red-11 border-red-7/20";
  }
};

const statusLabel = (status: "connected" | "needs_auth" | "needs_client_registration" | "failed" | "disabled" | "disconnected", locale: Language) => {
  switch (status) {
    case "connected":
      return t("mcp.connected_label", locale);
    case "needs_auth":
      return t("mcp.needs_auth", locale);
    case "needs_client_registration":
      return t("mcp.register_client", locale);
    case "disabled":
      return t("mcp.status_disabled", locale);
    case "disconnected":
      return t("mcp.disconnected", locale);
    default:
      return t("mcp.failed", locale);
  }
};

export default function McpView(props: McpViewProps) {
  // Translation helper that uses current language from i18n
  const translate = (key: string) => t(key, currentLocale());
  const [showDangerousContent, setShowDangerousContent] = createSignal(true);

  const [configScope, setConfigScope] = createSignal<"project" | "global">("project");
  const [projectConfig, setProjectConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [globalConfig, setGlobalConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [configError, setConfigError] = createSignal<string | null>(null);
  const [revealBusy, setRevealBusy] = createSignal(false);

  const selectedEntry = createMemo(() =>
    props.mcpServers.find((entry) => entry.name === props.selectedMcp) ?? null,
  );

  const quickConnectList = createMemo(() =>
    props.quickConnect.filter((entry) => entry.oauth),
  );

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
        setConfigError(e instanceof Error ? e.message : translate("mcp.config_load_failed"));
      }
    })();
  });

  const activeConfig = createMemo(() =>
    configScope() === "project" ? projectConfig() : globalConfig(),
  );

  const revealLabel = () => (isWindowsPlatform() ? translate("mcp.open_file") : translate("mcp.reveal_in_finder"));

  const canRevealConfig = () => {
    if (!isTauriRuntime() || revealBusy()) return false;
    if (configScope() === "project" && !props.activeWorkspaceRoot.trim()) return false;
    return Boolean(activeConfig()?.exists);
  };

  const revealConfig = async () => {
    if (!isTauriRuntime()) return;
    if (revealBusy()) return;
    const root = props.activeWorkspaceRoot.trim();

    if (configScope() === "project" && !root) {
      setConfigError(translate("mcp.pick_workspace_error"));
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
      setConfigError(e instanceof Error ? e.message : translate("mcp.reveal_config_failed"));
    } finally {
      setRevealBusy(false);
    }
  };

  // Convert name to slug (same logic used when adding MCPs)
  const toSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Look up status by slug, not display name
  const quickConnectStatus = (name: string) => {
    const slug = toSlug(name);
    return props.mcpStatuses[slug];
  };

  const isQuickConnectConnected = (name: string) => {
    const status = quickConnectStatus(name);
    return status?.status === "connected";
  };

  const canConnect = (entry: McpDirectoryInfo) =>
    props.mode === "host" && isTauriRuntime() && !props.busy && !!props.activeWorkspaceRoot.trim();

  return (
    <section class="space-y-6">
      <div class="space-y-4">
        <div class="space-y-1">
          <h2 class="text-lg font-semibold text-gray-12">{translate("mcp.title")}</h2>
          <p class="text-sm text-gray-11">
            {translate("mcp.description")}
          </p>
        </div>

        <div class="bg-amber-7/10 border border-amber-7/20 rounded-2xl p-5 space-y-4">
          <div class="flex items-start gap-3">
            <TriangleAlert size={20} class="text-amber-11 shrink-0 mt-0.5" />
            <div class="space-y-3">
              <div class="text-sm font-medium text-amber-12">
                {translate("mcp.alpha_banner_title")}
              </div>
              <div class="flex flex-col gap-2">
                <a
                  href="https://github.com/anomalyco/opencode/issues/9510"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1.5 text-xs text-amber-11/80 hover:text-amber-11 underline decoration-amber-5/30 underline-offset-4 transition-colors"
                >
                  <ExternalLink size={12} />
                  {translate("mcp.github_issue")}
                </a>
                <p class="text-xs text-gray-11 leading-relaxed">
                  {translate("mcp.alpha_banner_help")}
                </p>
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowDangerousContent(!showDangerousContent())}
          class="flex items-center gap-2 px-4 py-2 text-xs font-medium text-gray-10 hover:text-gray-11 transition-colors group"
        >
          <Show when={showDangerousContent()} fallback={<ChevronRight size={14} class="group-hover:translate-x-0.5 transition-transform" />}>
            <ChevronDown size={14} />
          </Show>
          {showDangerousContent() ? translate("mcp.hide_advanced") : translate("mcp.show_advanced")}
        </button>
      </div>

      <Show when={showDangerousContent()}>
        <div class="grid gap-6 lg:grid-cols-[1.5fr_1fr] animate-in fade-in slide-in-from-top-11 duration-300">
          <div class="space-y-6">
            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="text-sm font-medium text-gray-12">{translate("mcp.mcps_title")}</div>
                  <div class="text-xs text-gray-10">
                    {translate("mcp.connect_mcp_hint")}
                  </div>
                </div>
                <div class="text-xs text-gray-10 text-right">
                  <div>{props.mcpServers.length} {translate("mcp.configured")}</div>
                  <Show when={props.mcpLastUpdatedAt}>
                    <div>{translate("mcp.updated")} {formatRelativeTime(props.mcpLastUpdatedAt ?? Date.now())}</div>
                  </Show>
                </div>
              </div>
              <Show when={props.mcpStatus}>
                <div class="text-xs text-gray-10">{props.mcpStatus}</div>
              </Show>
            </div>

            <Show when={props.showMcpReloadBanner}>
              <div class="bg-gray-2/60 border border-gray-6/70 rounded-2xl px-4 py-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <div class="text-sm font-medium text-gray-12">{translate("mcp.reload_banner_title")}</div>
                  <div class="text-xs text-gray-10">
                    {translate("mcp.reload_banner_description")}
                  </div>
                </div>
                <Button variant="secondary" onClick={() => props.reloadMcpEngine()}>
                  {translate("mcp.reload_engine")}
                </Button>
              </div>
            </Show>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
              <div class="flex items-center justify-between">
                <div class="text-sm font-medium text-gray-12">{translate("mcp.quick_connect_title")}</div>
                <div class="text-[11px] text-gray-10">{translate("mcp.oauth_only_label")}</div>
              </div>
              <div class="grid gap-3">
                <For each={quickConnectList()}>
                  {(entry) => (
                    <div class="rounded-2xl border border-gray-6/70 bg-gray-1/40 p-4 space-y-3">
                      <div class="flex items-start justify-between gap-4">
                        <div>
                          <div class="text-sm font-medium text-gray-12">{entry.name}</div>
                          <div class="text-xs text-gray-10 mt-1">{entry.description}</div>
                          <div class="text-xs text-gray-7 font-mono mt-1">{entry.url}</div>
                        </div>
                        <div class="flex flex-col items-end gap-2">
                          <Show
                            when={!isQuickConnectConnected(entry.name)}
                            fallback={
                              <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-7/10 border border-green-7/20">
                                <CheckCircle2 size={16} class="text-green-11" />
                                <span class="text-sm text-green-11">{translate("mcp.connected_status")}</span>
                              </div>
                            }
                          >
                            <Button
                              variant="secondary"
                              onClick={() => props.connectMcp(entry)}
                              disabled={!canConnect(entry) || props.mcpConnectingName === entry.name}
                            >
                              {props.mcpConnectingName === entry.name ? (
                                <>
                                  <Loader2 size={16} class="animate-spin" />
                                  {translate("mcp.connecting")}
                                </>
                              ) : (
                                <>
                                  <PlugZap size={16} />
                                  {translate("mcp.connect")}
                                </>
                              )}
                            </Button>
                          </Show>
                          <Show when={quickConnectStatus(entry.name)}>
                            {(status) => (
                              <Show when={status().status !== "connected"}>
                                <div class={`text-[11px] px-2 py-1 rounded-full border ${statusBadge(status().status)}`}>
                                  {statusLabel(status().status, currentLocale())}
                                </div>
                              </Show>
                            )}
                          </Show>
                        </div>
                      </div>
                      <div class="text-[11px] text-gray-10">{translate("mcp.no_env_vars")}</div>
                    </div>
                  )}
                </For>
              </div>
            </div>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
              <div class="flex items-center justify-between">
                <div class="text-sm font-medium text-gray-12">{translate("mcp.connected_title")}</div>
                <div class="text-[11px] text-gray-10">{translate("mcp.from_opencode_json")}</div>
              </div>
              <Show
                when={props.mcpServers.length}
                fallback={
                  <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 text-sm text-gray-10">
                    {translate("mcp.no_servers_yet")}
                  </div>
                }
              >
                <div class="grid gap-3">
                  <For each={props.mcpServers}>
                    {(entry) => {
                      const resolved = props.mcpStatuses[entry.name];
                      const status =
                        entry.config.enabled === false
                          ? "disabled"
                          : resolved?.status
                            ? resolved.status
                            : "disconnected";
                      return (
                        <button
                          type="button"
                          class={`text-left rounded-2xl border px-4 py-3 transition-all ${
                            props.selectedMcp === entry.name
                              ? "border-gray-8 bg-gray-2/70"
                              : "border-gray-6/70 bg-gray-1/40 hover:border-gray-7"
                          }`}
                          onClick={() => props.setSelectedMcp(entry.name)}
                        >
                          <div class="flex items-center justify-between gap-3">
                            <div>
                              <div class="text-sm font-medium text-gray-12">{entry.name}</div>
                              <div class="text-xs text-gray-10 font-mono">
                                {entry.config.type === "remote" ? entry.config.url : entry.config.command?.join(" ")}
                              </div>
                            </div>
                            <div class={`text-[11px] px-2 py-1 rounded-full border ${statusBadge(status)}`}>
                              {statusLabel(status, currentLocale())}
                            </div>
                          </div>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
              <div class="flex items-start justify-between gap-4">
                <div class="space-y-1">
                  <div class="text-sm font-medium text-gray-12">{translate("mcp.edit_config_title")}</div>
                  <div class="text-xs text-gray-10">
                    {translate("mcp.edit_config_description")}
                  </div>
                </div>
                <a
                  href="https://opencode.ai/docs/mcp-servers/"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1.5 text-xs text-gray-10 hover:text-gray-12 underline decoration-gray-6/30 underline-offset-4 transition-colors"
                >
                  <ExternalLink size={12} />
                  {translate("mcp.docs_link")}
                </a>
              </div>

              <div class="flex items-center gap-2">
                <button
                  class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    configScope() === "project"
                      ? "bg-gray-12/10 text-gray-12 border-gray-6/30"
                      : "text-gray-10 border-gray-6 hover:text-gray-12"
                  }`}
                  onClick={() => setConfigScope("project")}
                >
                  {translate("mcp.scope_project")}
                </button>
                <button
                  class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                    configScope() === "global"
                      ? "bg-gray-12/10 text-gray-12 border-gray-6/30"
                      : "text-gray-10 border-gray-6 hover:text-gray-12"
                  }`}
                  onClick={() => setConfigScope("global")}
                >
                  {translate("mcp.scope_global")}
                </button>
              </div>

              <div class="flex flex-col gap-1 text-xs text-gray-10">
                <div>{translate("mcp.config_label")}</div>
                <div class="text-gray-7 font-mono truncate">
                  {activeConfig()?.path ?? translate("mcp.config_not_loaded")}
                </div>
              </div>

              <div class="flex items-center justify-between gap-3">
                <Button
                  variant="secondary"
                  onClick={revealConfig}
                  disabled={!canRevealConfig()}
                >
                  <Show
                    when={revealBusy()}
                    fallback={
                      <>
                        <FolderOpen size={16} />
                        {revealLabel()}
                      </>
                    }
                  >
                    <Loader2 size={16} class="animate-spin" />
                    {translate("mcp.opening_label")}
                  </Show>
                </Button>
                <Show when={activeConfig() && activeConfig()!.exists === false}>
                  <div class="text-[11px] text-zinc-600">{translate("mcp.file_not_found")}</div>
                </Show>
              </div>

              <Show when={configError()}>
                <div class="text-xs text-red-300">{configError()}</div>
              </Show>
            </div>
          </div>

          <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4 lg:sticky lg:top-6 self-start">
            <div class="flex items-center justify-between">
              <div class="text-sm font-medium text-gray-12">{translate("mcp.details_title")}</div>
              <div class="text-xs text-gray-10">{selectedEntry()?.name ?? translate("mcp.select_server_hint").split(" ").slice(0, 3).join(" ")}</div>
            </div>

            <Show
              when={selectedEntry()}
              fallback={
                <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 text-sm text-gray-10">
                  {translate("mcp.select_server_hint")}
                </div>
              }
            >
              {(entry) => (
                <div class="space-y-4">
                  <div class="rounded-xl border border-gray-6/70 bg-gray-1/40 p-4 space-y-2">
                    <div class="flex items-center gap-2 text-sm text-gray-12">
                      <Settings size={16} />
                      {entry().name}
                    </div>
                    <div class="text-xs text-gray-10 font-mono break-all">
                      {entry().config.type === "remote" ? entry().config.url : entry().config.command?.join(" ")}
                    </div>
                    <div class="flex items-center gap-2">
                      {(() => {
                        const resolved = props.mcpStatuses[entry().name];
                        const status =
                          entry().config.enabled === false
                            ? "disabled"
                            : resolved?.status
                              ? resolved.status
                              : "disconnected";
                        return (
                          <span class={`inline-flex items-center gap-2 text-[11px] px-2 py-1 rounded-full border ${statusBadge(status)}`}>
                            {statusLabel(status, currentLocale())}
                          </span>
                        );
                      })()}
                    </div>
                  </div>

                  <div class="rounded-xl border border-gray-6/70 bg-gray-1/40 p-4 space-y-2">
                    <div class="text-xs text-gray-11 uppercase tracking-wider">{translate("mcp.capabilities_label")}</div>
                    <div class="flex flex-wrap gap-2">
                      <span class="text-[10px] uppercase tracking-wide bg-gray-4/70 text-gray-11 px-2 py-0.5 rounded-full">
                        {translate("mcp.tools_enabled_label")}
                      </span>
                      <span class="text-[10px] uppercase tracking-wide bg-gray-4/70 text-gray-11 px-2 py-0.5 rounded-full">
                        {translate("mcp.oauth_ready_label")}
                      </span>
                    </div>
                    <div class="text-xs text-gray-10">
                      {translate("mcp.usage_hint_text")}
                    </div>
                  </div>

                  <div class="rounded-xl border border-gray-6/70 bg-gray-1/40 p-4 space-y-2">
                    <div class="text-xs text-gray-11 uppercase tracking-wider">{translate("mcp.next_steps_label")}</div>
                    <div class="flex items-center gap-2 text-xs text-gray-10">
                      <CheckCircle2 size={14} />
                      {translate("mcp.reload_step")}
                    </div>
                    <div class="flex items-center gap-2 text-xs text-gray-10">
                      <CircleAlert size={14} />
                      {translate("mcp.auth_step")}
                    </div>
                    {(() => {
                      const status = props.mcpStatuses[entry().name];
                      if (!status || status.status !== "failed") return null;
                      return (
                        <div class="text-xs text-red-11">
                          {"error" in status ? status.error : translate("mcp.connection_failed")}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}
            </Show>
          </div>
        </div>
      </Show>
    </section>
  );
}
