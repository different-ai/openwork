import { For, Show, createMemo, createSignal } from "solid-js";

import type { McpServerEntry, McpStatusMap } from "../app/types";
import type { McpDirectoryInfo } from "../app/constants";
import { formatRelativeTime, isTauriRuntime } from "../app/utils";

import Button from "../components/Button";
import TextInput from "../components/TextInput";
import { CheckCircle2, CircleAlert, Copy, Loader2, PlugZap, RefreshCcw, Server, Settings } from "lucide-solid";

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

const statusLabel = (status: "connected" | "needs_auth" | "needs_client_registration" | "failed" | "disabled" | "disconnected") => {
  switch (status) {
    case "connected":
      return "Connected";
    case "needs_auth":
      return "Needs auth";
    case "needs_client_registration":
      return "Register client";
    case "disabled":
      return "Disabled";
    case "disconnected":
      return "Disconnected";
    default:
      return "Failed";
  }
};

export default function McpView(props: McpViewProps) {
  const [advancedOpen, setAdvancedOpen] = createSignal(false);

  const selectedEntry = createMemo(() =>
    props.mcpServers.find((entry) => entry.name === props.selectedMcp) ?? null,
  );

  const quickConnectList = createMemo(() =>
    props.quickConnect.filter((entry) => entry.oauth),
  );

  const advancedCommand = () => props.advancedCommand;
  const advancedAuthCommand = () => props.advancedAuthCommand;

  const quickConnectStatus = (name: string) => props.mcpStatuses[name];

  const canConnect = (entry: McpDirectoryInfo) =>
    props.mode === "host" && isTauriRuntime() && !props.busy && !!props.activeWorkspaceRoot.trim();

  const advancedReady = () => props.advancedName.trim() && props.advancedUrl.trim();

  return (
    <section class="space-y-6">
      <div class="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div class="space-y-6">
          <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
            <div class="flex items-start justify-between gap-4">
              <div>
                <div class="text-sm font-medium text-white">MCPs</div>
                <div class="text-xs text-zinc-500">
                  Connect Model Context Protocol servers to expand what OpenWork can do.
                </div>
              </div>
              <div class="text-xs text-zinc-500 text-right">
                <div>{props.mcpServers.length} configured</div>
                <Show when={props.mcpLastUpdatedAt}>
                  <div>Updated {formatRelativeTime(props.mcpLastUpdatedAt ?? Date.now())}</div>
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
                <div class="text-sm font-medium text-white">Reload required</div>
                <div class="text-xs text-zinc-500">
                  Changes need a quick reload to activate MCP tools.
                </div>
              </div>
              <Button variant="secondary" onClick={() => props.reloadMcpEngine()}>
                Reload Engine
              </Button>
            </div>
          </Show>

          <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
            <div class="flex items-center justify-between">
              <div class="text-sm font-medium text-white">Quick connect</div>
              <div class="text-[11px] text-zinc-500">OAuth-only</div>
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
                        <Button
                          variant="secondary"
                          onClick={() => props.connectMcp(entry)}
                          disabled={!canConnect(entry) || props.mcpConnectingName === entry.name}
                        >
                          {props.mcpConnectingName === entry.name ? (
                            <>
                              <Loader2 size={16} class="animate-spin" />
                              Connecting
                            </>
                          ) : (
                            <>
                              <PlugZap size={16} />
                              Connect
                            </>
                          )}
                        </Button>
                        <Show when={quickConnectStatus(entry.name)}>
                          {(status) => (
                            <div class={`text-[11px] px-2 py-1 rounded-full border ${statusBadge(status().status)}`}>
                              {statusLabel(status().status)}
                            </div>
                          )}
                        </Show>
                      </div>
                    </div>
                    <div class="text-[11px] text-zinc-500">No environment variables required.</div>
                  </div>
                )}
              </For>
            </div>
          </div>

          <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
            <div class="flex items-center justify-between">
              <div class="text-sm font-medium text-white">Connected</div>
              <div class="text-[11px] text-zinc-500">From opencode.json</div>
            </div>
            <Show
              when={props.mcpServers.length}
              fallback={
                <div class="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-4 text-sm text-zinc-500">
                  No MCP servers configured yet.
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
                            {statusLabel(status)}
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
                <div class="text-sm font-medium text-white">Advanced</div>
                <div class="text-xs text-zinc-500">Manual setup for custom servers.</div>
              </div>
              <div class="text-xs text-zinc-500">{advancedOpen() ? "Hide" : "Show"}</div>
            </button>

            <Show when={advancedOpen()}>
              <div class="space-y-4">
                <div class="grid gap-3 md:grid-cols-2">
                  <TextInput
                    label="Server name"
                    placeholder="sentry"
                    value={props.advancedName}
                    onInput={(e) => props.setAdvancedName(e.currentTarget.value)}
                  />
                  <TextInput
                    label="Server URL"
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
                    OAuth
                  </Button>
                  <Button
                    variant={!props.advancedOAuth ? "secondary" : "outline"}
                    onClick={() => props.setAdvancedOAuth(false)}
                  >
                    API key
                  </Button>
                  <Button
                    variant={props.advancedEnabled ? "secondary" : "outline"}
                    onClick={() => props.setAdvancedEnabled(!props.advancedEnabled)}
                  >
                    {props.advancedEnabled ? "Enabled" : "Disabled"}
                  </Button>
                </div>
                <div class="flex flex-col md:flex-row md:items-end gap-3">
                  <Button
                    variant="secondary"
                    onClick={() => props.addAdvancedMcp()}
                    disabled={!advancedReady() || props.busy}
                  >
                    <Server size={16} />
                    Add MCP
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => props.testAdvancedMcp()}
                    disabled={!advancedReady() || props.busy}
                  >
                    <RefreshCcw size={16} />
                    Verify connection
                  </Button>
                </div>
                <div class="space-y-2">
                  <div class="text-xs text-zinc-500">CLI guidance (run from your workspace)</div>
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
                    Config can live in opencode.json, opencode.jsonc, or .opencode/opencode.json.
                  </div>
                </div>
              </div>
            </Show>
          </div>
        </div>

        <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4 lg:sticky lg:top-6 self-start">
          <div class="flex items-center justify-between">
            <div class="text-sm font-medium text-white">Details</div>
            <div class="text-xs text-zinc-500">{selectedEntry()?.name ?? "Select a server"}</div>
          </div>

          <Show
            when={selectedEntry()}
            fallback={
              <div class="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-4 text-sm text-zinc-500">
                Select a server to review status and config.
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
                          {statusLabel(status)}
                        </span>
                      );
                    })()}
                  </div>
                </div>

                <div class="rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4 space-y-2">
                  <div class="text-xs text-zinc-400 uppercase tracking-wider">Capabilities</div>
                  <div class="flex flex-wrap gap-2">
                    <span class="text-[10px] uppercase tracking-wide bg-zinc-800/70 text-zinc-400 px-2 py-0.5 rounded-full">
                      Tools enabled
                    </span>
                    <span class="text-[10px] uppercase tracking-wide bg-zinc-800/70 text-zinc-400 px-2 py-0.5 rounded-full">
                      OAuth ready
                    </span>
                  </div>
                  <div class="text-xs text-zinc-500">
                    Use the MCP server name in prompts to target its tools.
                  </div>
                </div>

                <div class="rounded-xl border border-zinc-800/70 bg-zinc-950/40 p-4 space-y-2">
                  <div class="text-xs text-zinc-400 uppercase tracking-wider">Next steps</div>
                  <div class="flex items-center gap-2 text-xs text-zinc-500">
                    <CheckCircle2 size={14} />
                    Reload the engine after adding a server.
                  </div>
                  <div class="flex items-center gap-2 text-xs text-zinc-500">
                    <CircleAlert size={14} />
                    Run opencode mcp auth for OAuth servers if prompted.
                  </div>
                  {(() => {
                    const status = props.mcpStatuses[entry().name];
                    if (!status || status.status !== "failed") return null;
                    return (
                      <div class="text-xs text-red-300">
                        {"error" in status ? status.error : "Connection failed"}
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
