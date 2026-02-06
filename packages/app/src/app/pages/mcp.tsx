import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import type { McpServerEntry, McpStatusMap } from "../types";
import type { McpDirectoryInfo } from "../constants";
import { formatRelativeTime, isTauriRuntime, isWindowsPlatform } from "../utils";
import { readOpencodeConfig, type OpencodeConfigFile } from "../lib/tauri";

import Button from "../components/button";
import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FolderOpen,
  Loader2,
  PlugZap,
  Plus,
  Settings,
} from "lucide-solid";
import { currentLocale, t, type Language } from "../../i18n";

export type McpViewProps = {
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
  reloadBlocked: boolean;
  reloadMcpEngine: () => void;
};

const statusBadge = (status: "connected" | "needs_auth" | "needs_client_registration" | "failed" | "disabled" | "disconnected") => {
  switch (status) {
    case "connected":
      return "bg-green-3 text-green-11 border-green-6";
    case "needs_auth":
    case "needs_client_registration":
      return "bg-amber-3 text-amber-11 border-amber-6";
    case "disabled":
      return "bg-gray-3 text-gray-11 border-gray-6";
    case "disconnected":
      return "bg-gray-2 text-gray-11 border-gray-6";
    default:
      return "bg-red-3 text-red-11 border-red-6";
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

  const [configScope, setConfigScope] = createSignal<"project" | "global">("project");
  const [projectConfig, setProjectConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [globalConfig, setGlobalConfig] = createSignal<OpencodeConfigFile | null>(null);
  const [configError, setConfigError] = createSignal<string | null>(null);
  const [revealBusy, setRevealBusy] = createSignal(false);

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

  const canConnect = () => !props.busy;

  let editConfigRef: HTMLDivElement | undefined;
  const scrollToEditConfig = () => {
    editConfigRef?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section class="space-y-10">
      <div class="space-y-2">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="space-y-2">
            <h2 class="text-3xl font-bold text-dls-text">{translate("mcp.title")}</h2>
            <p class="text-sm text-dls-secondary">
              {translate("mcp.description")} {" "}
              <a
                href="https://opencode.ai/docs/mcp-servers/"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1.5 text-dls-secondary hover:text-dls-text underline decoration-dls-border underline-offset-4 transition-colors"
              >
                <ExternalLink size={12} />
                {translate("mcp.docs_link")}
              </a>
            </p>
          </div>
          <div class="text-xs text-dls-secondary text-right">
            <div>
              {props.mcpServers.length} {translate("mcp.configured")}
            </div>
            <Show when={props.mcpLastUpdatedAt}>
              <div>
                {translate("mcp.updated")} {formatRelativeTime(props.mcpLastUpdatedAt ?? Date.now())}
              </div>
            </Show>
          </div>
        </div>

        <Show when={props.mcpStatus}>
          <div class="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary whitespace-pre-wrap break-words">
            {props.mcpStatus}
          </div>
        </Show>
      </div>

      <div class="grid gap-8 lg:grid-cols-[1.5fr_1fr] animate-in fade-in slide-in-from-top-11 duration-300">
        <div class="space-y-8">
          <Show when={props.showMcpReloadBanner}>
            <div class="bg-dls-hover border border-dls-border rounded-xl px-4 py-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div class="text-sm font-semibold text-dls-text">{translate("mcp.reload_banner_title")}</div>
                <div class="text-xs text-dls-secondary">
                  {props.reloadBlocked
                    ? translate("mcp.reload_banner_description_blocked")
                    : translate("mcp.reload_banner_description")}
                </div>
              </div>
              <Button
                variant="secondary"
                onClick={() => props.reloadMcpEngine()}
                disabled={props.reloadBlocked}
                title={props.reloadBlocked ? translate("mcp.reload_banner_blocked_hint") : undefined}
              >
                {translate("mcp.reload_engine")}
              </Button>
            </div>
          </Show>

          <div class="space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <h3 class="text-[11px] font-bold text-dls-secondary uppercase tracking-widest">
                {translate("mcp.connected_title")}
              </h3>
              <div class="flex items-center gap-3">
                <div class="text-[11px] text-dls-secondary">{translate("mcp.from_opencode_json")}</div>
                <button
                  type="button"
                  onClick={scrollToEditConfig}
                  class="flex items-center gap-1.5 text-xs font-medium text-dls-secondary hover:text-dls-text transition-colors"
                >
                  <Plus size={14} />
                  {translate("mcp.add_mcp")}
                </button>
              </div>
            </div>

            <Show
              when={props.mcpServers.length}
              fallback={
                <div class="rounded-xl border border-dls-border bg-dls-surface px-5 py-6 text-sm text-dls-secondary">
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
                        class={`text-left rounded-xl border px-4 py-3 transition-colors ${
                          props.selectedMcp === entry.name
                            ? "border-dls-border bg-dls-active"
                            : "border-dls-border bg-dls-surface hover:bg-dls-hover"
                        }`}
                        onClick={() => props.setSelectedMcp(entry.name)}
                      >
                        <div class="flex items-center justify-between gap-3">
                          <div class="min-w-0">
                            <div class="text-sm font-semibold text-dls-text truncate">{entry.name}</div>
                            <div class="text-xs text-dls-secondary font-mono truncate">
                              {entry.config.type === "remote"
                                ? entry.config.url
                                : entry.config.command?.join(" ")}
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

          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <h3 class="text-[11px] font-bold text-dls-secondary uppercase tracking-widest">
                {translate("mcp.quick_connect_title")}
              </h3>
              <div class="text-[11px] text-dls-secondary">{translate("mcp.oauth_only_label")}</div>
            </div>

            <div class="grid gap-3">
              <For each={quickConnectList()}>
                {(entry) => {
                  const connectionHint =
                    entry.type === "local" ? entry.command?.join(" ") : entry.url;

                  return (
                    <div class="bg-dls-surface border border-dls-border rounded-xl p-4 flex items-start justify-between gap-4 hover:bg-dls-hover transition-colors">
                      <div class="flex items-start gap-4 min-w-0">
                        <div class="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm border border-dls-border bg-dls-hover shrink-0">
                          <PlugZap size={18} class="text-dls-secondary" />
                        </div>
                        <div class="min-w-0">
                          <div class="flex flex-wrap items-center gap-2">
                            <h4 class="text-sm font-semibold text-dls-text">{entry.name}</h4>
                            <Show when={quickConnectStatus(entry.name)}>
                              {(status) => (
                                <Show when={status().status !== "connected"}>
                                  <span
                                    class={`text-[11px] px-2 py-1 rounded-full border ${statusBadge(status().status)}`}
                                  >
                                    {statusLabel(status().status, currentLocale())}
                                  </span>
                                </Show>
                              )}
                            </Show>
                          </div>
                          <p class="text-xs text-dls-secondary mt-1 line-clamp-2">{entry.description}</p>
                          <Show when={connectionHint}>
                            <div class="text-xs text-dls-secondary font-mono mt-1 truncate">
                              {connectionHint}
                            </div>
                          </Show>
                          <div class="text-[11px] text-dls-secondary mt-2">{translate("mcp.no_env_vars")}</div>
                        </div>
                      </div>

                      <div class="flex flex-col items-end gap-2 shrink-0">
                        <Show
                          when={!isQuickConnectConnected(entry.name)}
                          fallback={
                            <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-3 border border-green-6">
                              <CheckCircle2 size={16} class="text-green-11" />
                              <span class="text-sm text-green-11">{translate("mcp.connected_status")}</span>
                            </div>
                          }
                        >
                          <Button
                            variant="secondary"
                            onClick={() => props.connectMcp(entry)}
                            disabled={!canConnect() || props.mcpConnectingName === entry.name}
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
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>

          <div
            class="bg-dls-surface border border-dls-border rounded-2xl p-5 space-y-4"
            ref={(el) => (editConfigRef = el)}
          >
            <div class="flex items-start justify-between gap-4">
              <div class="space-y-1">
                <div class="text-sm font-medium text-dls-text">{translate("mcp.edit_config_title")}</div>
                <div class="text-xs text-dls-secondary">{translate("mcp.edit_config_description")}</div>
              </div>
              <a
                href="https://opencode.ai/docs/mcp-servers/"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1.5 text-xs text-dls-secondary hover:text-dls-text underline decoration-dls-border underline-offset-4 transition-colors"
              >
                <ExternalLink size={12} />
                {translate("mcp.docs_link")}
              </a>
            </div>

            <div class="flex items-center gap-2">
              <button
                class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  configScope() === "project"
                    ? "bg-dls-active text-dls-text border-dls-border"
                    : "text-dls-secondary border-dls-border hover:text-dls-text hover:bg-dls-hover"
                }`}
                onClick={() => setConfigScope("project")}
              >
                {translate("mcp.scope_project")}
              </button>
              <button
                class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  configScope() === "global"
                    ? "bg-dls-active text-dls-text border-dls-border"
                    : "text-dls-secondary border-dls-border hover:text-dls-text hover:bg-dls-hover"
                }`}
                onClick={() => setConfigScope("global")}
              >
                {translate("mcp.scope_global")}
              </button>
            </div>

            <div class="flex flex-col gap-1 text-xs text-dls-secondary">
              <div>{translate("mcp.config_label")}</div>
              <div class="text-dls-secondary font-mono truncate">
                {activeConfig()?.path ?? translate("mcp.config_not_loaded")}
              </div>
            </div>

            <div class="flex items-center justify-between gap-3">
              <Button variant="secondary" onClick={revealConfig} disabled={!canRevealConfig()}>
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
                <div class="text-[11px] text-dls-secondary">{translate("mcp.file_not_found")}</div>
              </Show>
            </div>

            <Show when={configError()}>
              <div class="text-xs text-red-11">{configError()}</div>
            </Show>
          </div>
        </div>

        <div class="bg-dls-surface border border-dls-border rounded-2xl p-5 space-y-4 lg:sticky lg:top-6 self-start">
          <div class="flex items-center justify-between">
            <div class="text-sm font-medium text-dls-text">{translate("mcp.details_title")}</div>
            <div class="text-xs text-dls-secondary">
              {selectedEntry()?.name ?? translate("mcp.select_server_hint").split(" ").slice(0, 3).join(" ")}
            </div>
          </div>

          <Show
            when={selectedEntry()}
            fallback={
              <div class="rounded-xl border border-dls-border bg-dls-hover p-4 text-sm text-dls-secondary">
                {translate("mcp.select_server_hint")}
              </div>
            }
          >
            {(entry) => (
              <div class="space-y-4">
                <div class="rounded-xl border border-dls-border bg-dls-hover p-4 space-y-2">
                  <div class="flex items-center gap-2 text-sm text-dls-text">
                    <Settings size={16} />
                    {entry().name}
                  </div>
                  <div class="text-xs text-dls-secondary font-mono break-all">
                    {entry().config.type === "remote"
                      ? entry().config.url
                      : entry().config.command?.join(" ")}
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
                        <span
                          class={`inline-flex items-center gap-2 text-[11px] px-2 py-1 rounded-full border ${statusBadge(status)}`}
                        >
                          {statusLabel(status, currentLocale())}
                        </span>
                      );
                    })()}
                  </div>
                </div>

                <div class="rounded-xl border border-dls-border bg-dls-hover p-4 space-y-2">
                  <div class="text-xs text-dls-secondary uppercase tracking-wider">
                    {translate("mcp.capabilities_label")}
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <span class="text-[10px] uppercase tracking-wide bg-dls-active text-dls-secondary px-2 py-0.5 rounded-full">
                      {translate("mcp.tools_enabled_label")}
                    </span>
                    <span class="text-[10px] uppercase tracking-wide bg-dls-active text-dls-secondary px-2 py-0.5 rounded-full">
                      {translate("mcp.oauth_ready_label")}
                    </span>
                  </div>
                  <div class="text-xs text-dls-secondary">{translate("mcp.usage_hint_text")}</div>
                </div>

                <div class="rounded-xl border border-dls-border bg-dls-hover p-4 space-y-2">
                  <div class="text-xs text-dls-secondary uppercase tracking-wider">
                    {translate("mcp.next_steps_label")}
                  </div>
                  <div class="flex items-center gap-2 text-xs text-dls-secondary">
                    <CheckCircle2 size={14} />
                    {translate("mcp.reload_step")}
                  </div>
                  <div class="flex items-center gap-2 text-xs text-dls-secondary">
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
    </section>
  );
}
