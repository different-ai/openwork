import { For, Show, createMemo, createSignal } from "solid-js";

import type { McpServerEntry, McpStatusMap } from "../app/types";
import type { McpDirectoryInfo } from "../app/constants";
import { formatRelativeTime, isTauriRuntime } from "../app/utils";
import { useI18n } from "../i18n";

import Button from "../components/Button";
import TextInput from "../components/TextInput";
import { CheckCircle2, CircleAlert, Copy, Loader2, PlugZap, RefreshCcw, Server, Settings, TriangleAlert, ChevronDown, ChevronRight, ExternalLink } from "lucide-solid";

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
  addAdvancedMcp: () => void;
  testAdvancedMcp: () => void;
  advancedName: string;
  setAdvancedName: (value: string) => void;
  advancedUrl: string;
  setAdvancedUrl: (value: string) => void;
  advancedOAuth: boolean;
  setAdvancedOAuth: (value: boolean) => void;
  advancedEnabled: boolean;
  setAdvancedEnabled: (value: boolean) => void;
  advancedCommand: string;
  advancedAuthCommand: string;
  showMcpReloadBanner: boolean;
  reloadMcpEngine: () => void;
};

const statusBadge = (status: "connected" | "needs_auth" | "needs_client_registration" | "failed" | "disabled" | "disconnected") => {
  switch (status) {
    case "connected":
      return "bg-emerald-500/10 text-emerald-300 border-emerald-500/20";
    case "needs_auth":
    case "needs_client_registration":
      return "bg-amber-500/10 text-amber-300 border-amber-500/20";
    case "disabled":
      return "bg-zinc-800/60 text-zinc-400 border-zinc-700/50";
    case "disconnected":
      return "bg-zinc-900/80 text-zinc-200 border-zinc-700/50";
    default:
      return "bg-red-500/10 text-red-300 border-red-500/20";
  }
};

const statusLabel = (status: "connected" | "needs_auth" | "needs_client_registration" | "failed" | "disabled" | "disconnected", t: any) => {
  switch (status) {
    case "connected":
      return t("mcp.status.connected");
    case "needs_auth":
      return t("mcp.status.needs_auth");
    case "needs_client_registration":
      return t("mcp.status.needs_reg");
    case "disabled":
      return t("mcp.status.disabled");
    case "disconnected":
      return t("mcp.status.disconnected");
    default:
      return t("mcp.status.failed");
  }
};

export default function McpView(props: McpViewProps) {
  const [t] = useI18n();
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const [showDangerousContent, setShowDangerousContent] = createSignal(true);

  const selectedEntry = createMemo(() =>
    props.mcpServers.find((entry) => entry.name === props.selectedMcp) ?? null,
  );

  const quickConnectList = createMemo(() =>
    props.quickConnect.filter((entry) => entry.oauth),
  );

  const advancedCommand = () => props.advancedCommand;
  const advancedAuthCommand = () => props.advancedAuthCommand;

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

  const advancedReady = () => props.advancedName.trim() && props.advancedUrl.trim();

  return (
    <section class="space-y-6">
      <div class="space-y-4">
        <div class="space-y-1">
          <h2 class="text-lg font-semibold text-white">{t("mcp.title")}</h2>
          <p class="text-sm text-zinc-400">
            {t("mcp.desc")}
          </p>
        </div>

        <div class="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-5 space-y-4">
          <div class="flex items-start gap-3">
            <TriangleAlert size={20} class="text-amber-400 shrink-0 mt-0.5" />
            <div class="space-y-3">
              <div class="text-sm font-medium text-amber-200">
                {t("mcp.alpha_warning.title")}
              </div>
              <div class="flex flex-col gap-2">
                <a
                  href="https://github.com/anomalyco/opencode/issues/9510"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1.5 text-xs text-amber-400/80 hover:text-amber-400 underline decoration-amber-400/30 underline-offset-4 transition-colors"
                >
                  <ExternalLink size={12} />
                  {t("mcp.alpha_warning.link_text")}
                </a>
                <p class="text-xs text-zinc-400 leading-relaxed">
                  {t("mcp.alpha_warning.help")}
                </p>
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowDangerousContent(!showDangerousContent())}
          class="flex items-center gap-2 px-4 py-2 text-xs font-medium text-zinc-500 hover:text-zinc-300 transition-colors group"
        >
          <Show when={showDangerousContent()} fallback={<ChevronRight size={14} class="group-hover:translate-x-0.5 transition-transform" />}>
            <ChevronDown size={14} />
          </Show>
          {showDangerousContent() ? t("mcp.toggle_advanced.hide") : t("mcp.toggle_advanced.show")}
        </button>
      </div>

      <Show when={showDangerousContent()}>
        <div class="grid gap-6 lg:grid-cols-[1.5fr_1fr] animate-in fade-in slide-in-from-top-2 duration-300">
          <div class="space-y-6">
            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="text-sm font-medium text-white">{t("mcp.list.title")}</div>
                  <div class="text-xs text-zinc-500">
                    {t("mcp.list.desc")}
                  </div>
                </div>
                <div class="text-xs text-zinc-500 text-right">
                  <div>{props.mcpServers.length} {t("mcp.list.configured")}</div>
                  <Show when={props.mcpLastUpdatedAt}>
                    <div>{t("mcp.list.updated")} {formatRelativeTime(props.mcpLastUpdatedAt ?? Date.now())}</div>
                  </Show>
                </div>
              </div>
              <Show when={props.mcpStatus}>
                <div class="text-xs text-zinc-500">{props.mcpStatus}</div>
              </Show>
            </div>

            <Show when={props.showMcpReloadBanner}>
              <div class="bg-zinc-900/60 border border-zinc-800/70 rounded-2xl px-4 py-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <div class="text-sm font-medium text-white">{t("mcp.reload.title")}</div>
                  <div class="text-xs text-zinc-500">
                    {t("mcp.reload.desc")}
                  </div>
                </div>
                <Button variant="secondary" onClick={() => props.reloadMcpEngine()}>
                  {t("mcp.reload.btn")}
                </Button>
              </div>
            </Show>

            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
              <div class="flex items-center justify-between">
                <div class="text-sm font-medium text-white">{t("mcp.quick.title")}</div>
                <div class="text-[11px] text-zinc-500">{t("mcp.quick.subtitle")}</div>
              </div>
              <div class="grid gap-3">
                <For each={quickConnectList()}>
                  {(entry) => (
                    <div class="rounded-2xl border border-zinc-800/70 bg-zinc-950/40 p-4 space-y-3">
                      <div class="flex items-start justify-between gap-4">
                        <div>
                          <div class="text-sm font-medium text-white">{entry.name}</div>
                          <div class="text-xs text-zinc-500 mt-1">{entry.description}</div>
                          <div class="text-xs text-zinc-600 font-mono mt-1">{entry.url}</div>
                        </div>
                        <div class="flex flex-col items-end gap-2">
                          <Show
                            when={!isQuickConnectConnected(entry.name)}
                            fallback={
                              <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                                <CheckCircle2 size={16} class="text-emerald-400" />
                                <span class="text-sm text-emerald-300">{t("mcp.status.connected")}</span>
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
                                  {t("mcp.quick.connecting")}
                                </>
                              ) : (
                                <>
                                  <PlugZap size={16} />
                                  {t("mcp.quick.connect")}
                                </>
                              )}
                            </Button>
                          </Show>
                          <Show when={quickConnectStatus(entry.name)}>
                            {(status) => (
                              <Show when={status().status !== "connected"}>
                                <div class={`text-[11px] px-2 py-1 rounded-full border ${statusBadge(status().status)}`}>
                                  {statusLabel(status().status, t)}
                                </div>
                              </Show>
                            )}
                          </Show>
                        </div>
                      </div>
                      <div class="text-[11px] text-zinc-500">{t("mcp.quick.no_env")}</div>
                    </div>
                  )}
                </For>
              </div>
            </div>

            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
              <div class="flex items-center justify-between">
                <div class="text-sm font-medium text-white">{t("mcp.connected.title")}</div>
                <div class="text-[11px] text-zinc-500">{t("mcp.connected.subtitle")}</div>
              </div>
              <Show
                when={props.mcpServers.length}
                fallback={
                  <div class="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-4 text-sm text-zinc-500">
                    {t("mcp.connected.empty")}
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
                          class={`text-left rounded-2xl border px-4 py-3 transition-all ${props.selectedMcp === entry.name
                              ? "border-zinc-600 bg-zinc-900/70"
                              : "border-zinc-800/70 bg-zinc-950/40 hover:border-zinc-700"
                            }`}
                          onClick={() => props.setSelectedMcp(entry.name)}
                        >
                          <div class="flex items-center justify-between gap-3">
                            <div>
                              <div class="text-sm font-medium text-white">{entry.name}</div>
                              <div class="text-xs text-zinc-500 font-mono">
                                {entry.config.type === "remote" ? entry.config.url : entry.config.command?.join(" ")}
                              </div>
                            </div>
                            <div class={`text-[11px] px-2 py-1 rounded-full border ${statusBadge(status)}`}>
                              {statusLabel(status, t)}
                            </div>
                          </div>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>

            <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
              <button
                class="w-full flex items-center justify-between text-left"
                onClick={() => setAdvancedOpen((prev) => !prev)}
              >
                <div>
                  <div class="text-sm font-medium text-white">{t("mcp.advanced.title")}</div>
                  <div class="text-xs text-zinc-500">{t("mcp.advanced.desc")}</div>
                </div>
                <div class="text-xs text-zinc-500">{advancedOpen() ? t("mcp.advanced.hide") : t("mcp.advanced.show")}</div>
              </button>

              <Show when={advancedOpen()}>
                <div class="space-y-4">
                  <div class="grid gap-3 md:grid-cols-2">
                    <TextInput
                      label={t("mcp.advanced.name_label")}
                      placeholder="sentry"
                      value={props.advancedName}
                      onInput={(e) => props.setAdvancedName(e.currentTarget.value)}
                    />
                    <TextInput
                      label={t("mcp.advanced.url_label")}
                      placeholder="https://mcp.sentry.dev/mcp"
                      value={props.advancedUrl}
                      onInput={(e) => props.setAdvancedUrl(e.currentTarget.value)}
                    />
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <Button
                      variant={props.advancedOAuth ? "secondary" : "outline"}
                      onClick={() => props.setAdvancedOAuth(true)}
                    >
                      {t("mcp.advanced.oauth")}
                    </Button>
                    <Button
                      variant={!props.advancedOAuth ? "secondary" : "outline"}
                      onClick={() => props.setAdvancedOAuth(false)}
                    >
                      {t("mcp.advanced.api_key")}
                    </Button>
                    <Button
                      variant={props.advancedEnabled ? "secondary" : "outline"}
                      onClick={() => props.setAdvancedEnabled(!props.advancedEnabled)}
                    >
                      {props.advancedEnabled ? t("mcp.advanced.enabled") : t("mcp.advanced.disabled")}
                    </Button>
                  </div>
                  <div class="flex flex-col md:flex-row md:items-end gap-3">
                    <Button
                      variant="secondary"
                      onClick={() => props.addAdvancedMcp()}
                      disabled={!advancedReady() || props.busy}
                    >
                      <Server size={16} />
                      {t("mcp.advanced.add_btn")}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => props.testAdvancedMcp()}
                      disabled={!advancedReady() || props.busy}
                    >
                      <RefreshCcw size={16} />
                      {t("mcp.advanced.verify_btn")}
                    </Button>
                  </div>
                  <div class="space-y-2">
                    <div class="text-xs text-zinc-500">{t("mcp.advanced.cli_guidance")}</div>
                    <div class="rounded-xl bg-zinc-950/70 border border-zinc-800/70 px-3 py-2 text-xs font-mono text-zinc-200 flex items-center justify-between gap-2">
                      <span class="truncate">{advancedCommand()}</span>
                      <button
                        type="button"
                        class="text-zinc-400 hover:text-zinc-200"
                        onClick={() => navigator.clipboard?.writeText(advancedCommand())}
                      >
                        <Copy size={14} />
                      </button>
                    </div>
                    <div class="rounded-xl bg-zinc-950/70 border border-zinc-800/70 px-3 py-2 text-xs font-mono text-zinc-200 flex items-center justify-between gap-2">
                      <span class="truncate">{advancedAuthCommand()}</span>
                      <button
                        type="button"
                        class="text-zinc-400 hover:text-zinc-200"
                        onClick={() => navigator.clipboard?.writeText(advancedAuthCommand())}
                      >
                        <Copy size={14} />
                      </button>
                    </div>
                    <div class="text-[11px] text-zinc-600">
                      {t("mcp.advanced.config_note")}
                    </div>
                  </div>
                </div>
              </Show>
            </div>
          </div>

          <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4 lg:sticky lg:top-6 self-start">
            <div class="flex items-center justify-between">
              <div class="text-sm font-medium text-white">{t("mcp.details.title")}</div>
              <div class="text-xs text-zinc-500">{selectedEntry()?.name ?? t("mcp.details.select")}</div>
            </div>

            <Show
              when={selectedEntry()}
              fallback={
                <div class="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-4 text-sm text-zinc-500">
                  {t("mcp.details.empty")}
                </div>
              }
            >
              {(entry) => (
                <div class="space-y-4">
                  <div class="rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4 space-y-2">
                    <div class="flex items-center gap-2 text-sm text-white">
                      <Settings size={16} />
                      {entry().name}
                    </div>
                    <div class="text-xs text-zinc-500 font-mono break-all">
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
                            {statusLabel(status, t)}
                          </span>
                        );
                      })()}
                    </div>
                  </div>

                  <div class="rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4 space-y-2">
                    <div class="text-xs text-zinc-400 uppercase tracking-wider">{t("mcp.details.capabilities")}</div>
                    <div class="flex flex-wrap gap-2">
                      <span class="text-[10px] uppercase tracking-wide bg-zinc-800/70 text-zinc-400 px-2 py-0.5 rounded-full">
                        {t("mcp.details.tools_enabled")}
                      </span>
                      <span class="text-[10px] uppercase tracking-wide bg-zinc-800/70 text-zinc-400 px-2 py-0.5 rounded-full">
                        {t("mcp.details.oauth_ready")}
                      </span>
                    </div>
                    <div class="text-xs text-zinc-500">
                      {t("mcp.details.tools_desc")}
                    </div>
                  </div>

                  <div class="rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4 space-y-2">
                    <div class="text-xs text-zinc-400 uppercase tracking-wider">{t("mcp.details.next_steps")}</div>
                    <div class="flex items-center gap-2 text-xs text-zinc-500">
                      <CheckCircle2 size={14} />
                      {t("mcp.details.reload_note")}
                    </div>
                    <div class="flex items-center gap-2 text-xs text-zinc-500">
                      <CircleAlert size={14} />
                      {t("mcp.details.auth_note")}
                    </div>
                    {(() => {
                      const status = props.mcpStatuses[entry().name];
                      if (!status || status.status !== "failed") return null;
                      return (
                        <div class="text-xs text-red-300">
                          {"error" in status ? status.error : t("mcp.details.error_label")}
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
