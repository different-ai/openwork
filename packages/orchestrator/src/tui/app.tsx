import { RGBA, TextAttributes, type InputRenderable, type KeyEvent, type TabSelectRenderable } from "@opentui/core";
import { render, useKeyboard, useRenderer, useSelectionHandler, useTerminalDimensions } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";

export type TuiLogLevel = "debug" | "info" | "warn" | "error";

export type TuiServiceStatus = "starting" | "running" | "healthy" | "stopped" | "disabled" | "error";

export type TuiService = {
  name: string;
  label: string;
  status: TuiServiceStatus;
  pid?: number;
  port?: number;
  message?: string;
};

export type TuiConnectInfo = {
  runId: string;
  workspace: string;
  openworkUrl: string;
  openworkToken: string;
  hostToken: string;
  opencodeUrl: string;
  opencodePassword?: string;
  opencodeUsername?: string;
  attachCommand: string;
};

export type TuiRouterHealth = {
  ok: boolean;
  opencode: {
    url: string;
    healthy: boolean;
    version?: string;
  };
  channels: {
    telegram: boolean;
    slack: boolean;
    // Legacy field (kept for backward compatibility with older builds).
    whatsapp?: boolean;
  };
  config: {
    groupsEnabled: boolean;
  };
};

// Backward-compatible name (older logs + code paths still say opencodeRouter).
export type TuiOpenCodeRouterHealth = TuiRouterHealth;

export type TuiRouterIdentityItem = {
  id: string;
  enabled: boolean;
  running: boolean;
};

export type TuiRouterIdentityList = {
  items: TuiRouterIdentityItem[];
};

export type TuiLogEntry = {
  time: number;
  level: TuiLogLevel;
  component: string;
  message: string;
};

export type TuiHandle = {
  updateService: (name: string, update: Partial<TuiService>) => void;
  setConnectInfo: (info: Partial<TuiConnectInfo>) => void;
  setRouterHealth: (health: TuiRouterHealth | null) => void;
  pushLog: (entry: TuiLogEntry) => void;
  setUptimeStart: (time: number) => void;
  stop: () => void;
};

type TuiOptions = {
  version: string;
  connect: TuiConnectInfo;
  services: TuiService[];
  onQuit: () => void | Promise<void>;
  onDetach: () => void | Promise<void>;
  onCopyAttach: () => Promise<{ command: string; copied: boolean; error?: string }>;
  onCopySelection?: (text: string) => Promise<{ copied: boolean; error?: string }>;
  onRouterHealth: () => Promise<TuiRouterHealth>;
  onRouterTelegramIdentities: () => Promise<TuiRouterIdentityList>;
  onRouterSlackIdentities: () => Promise<TuiRouterIdentityList>;
  onRouterSetGroupsEnabled: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  onRouterSetTelegramToken: (token: string) => Promise<{ ok: boolean; error?: string }>;
  onRouterSetSlackTokens: (botToken: string, appToken: string) => Promise<{ ok: boolean; error?: string }>;
};

type ViewName = "overview" | "logs" | "help" | "router";

const MAX_LOGS = 800;

const theme = {
  text: RGBA.fromInts(235, 235, 235),
  textMuted: RGBA.fromInts(150, 150, 160),
  border: RGBA.fromInts(70, 70, 80),
  accent: RGBA.fromInts(120, 180, 255),
  success: RGBA.fromInts(90, 210, 140),
  warning: RGBA.fromInts(240, 200, 90),
  error: RGBA.fromInts(240, 120, 120),
  panel: RGBA.fromInts(28, 28, 32),
} as const;

const statusLabel: Record<TuiServiceStatus, string> = {
  starting: "Starting",
  running: "Running",
  healthy: "Healthy",
  stopped: "Stopped",
  disabled: "Disabled",
  error: "Error",
};

const statusColor: Record<TuiServiceStatus, RGBA> = {
  starting: theme.warning,
  running: theme.accent,
  healthy: theme.success,
  stopped: theme.textMuted,
  disabled: theme.textMuted,
  error: theme.error,
};

const levelColor: Record<TuiLogLevel, RGBA> = {
  debug: theme.textMuted,
  info: theme.text,
  warn: theme.warning,
  error: theme.error,
};

const levelCycle: Array<"all" | TuiLogLevel> = ["all", "info", "warn", "error", "debug"];

const serviceCycle = ["all", "openwork-orchestrator", "opencode", "openwork-server", "router"];

const viewTabs: Array<{ name: string; description: string; value: ViewName }> = [
  { name: "Overview", description: "Overview", value: "overview" },
  { name: "Logs", description: "Logs", value: "logs" },
  { name: "Router", description: "opencode-router", value: "router" },
  { name: "Help", description: "Help", value: "help" },
];

const viewIndexByName = new Map(viewTabs.map((entry, index) => [entry.value, index]));

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function formatTime(ms: number) {
  const date = new Date(ms);
  return date.toLocaleTimeString(undefined, { timeStyle: "short" });
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function startOrchestratorTui(options: TuiOptions): TuiHandle {
  let stop: (() => void) | undefined;
  const api: TuiHandle = {
    updateService: () => undefined,
    setConnectInfo: () => undefined,
    setRouterHealth: () => undefined,
    pushLog: () => undefined,
    setUptimeStart: () => undefined,
    stop: () => stop?.(),
  };

  render(
    () => {
      const renderer = useRenderer();
      const dimensions = useTerminalDimensions();
      renderer.disableStdoutInterception();

      const [state, setState] = createStore({
        view: "overview" as ViewName,
        follow: true,
        serviceFilter: "all" as (typeof serviceCycle)[number],
        levelFilter: "all" as (typeof levelCycle)[number],
        scrollOffset: 0,
        logs: [] as TuiLogEntry[],
        services: options.services as TuiService[],
        connect: options.connect,
        routerHealth: null as TuiRouterHealth | null,
        routerTelegramIdentities: null as TuiRouterIdentityList | null,
        routerSlackIdentities: null as TuiRouterIdentityList | null,
        routerTelegramToken: "",
        routerSlackTokens: "",
        routerTelegramEditing: false,
        routerSlackEditing: false,
        routerAutoLoaded: false,
        uptimeStart: Date.now(),
      });

      api.updateService = (name, update) => {
        setState("services", (items) =>
          items.map((item) => (item.name === name ? { ...item, ...update } : item)),
        );
      };

      api.setConnectInfo = (info) => {
        setState("connect", (prev) => ({ ...prev, ...info }));
      };

      api.setRouterHealth = (health) => {
        setState("routerHealth", health);
      };

      api.pushLog = (entry) => {
        setState("logs", (prev) => {
          const next = [...prev, entry];
          return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
        });
        if (state.follow) {
          setState("scrollOffset", 0);
        }
      };

      api.setUptimeStart = (time) => {
        setState("uptimeStart", time);
      };

      stop = () => renderer.destroy();

      const [now, setNow] = createSignal(Date.now());
      const interval = setInterval(() => setNow(Date.now()), 1000);
      onCleanup(() => clearInterval(interval));

      const [toast, setToast] = createSignal<string | null>(null);
      let toastTimer: NodeJS.Timeout | undefined;
      const showToast = (message: string) => {
        if (toastTimer) clearTimeout(toastTimer);
        setToast(message);
        toastTimer = setTimeout(() => setToast(null), 2500);
      };
      onCleanup(() => {
        if (toastTimer) clearTimeout(toastTimer);
      });

      const setView = (view: ViewName) => {
        setState("view", view);
        if (view !== "router") {
          setState("routerTelegramEditing", false);
          setState("routerSlackEditing", false);
        }
      };

      const refreshRouter = async (opts: { toastOnSuccess?: string } = {}) => {
        const [health, telegram, slack] = await Promise.allSettled([
          options.onRouterHealth(),
          options.onRouterTelegramIdentities(),
          options.onRouterSlackIdentities(),
        ]);

        const errors: string[] = [];
        if (health.status === "fulfilled") {
          api.setRouterHealth(health.value);
        } else {
          errors.push(`health: ${String(health.reason)}`);
        }

        if (telegram.status === "fulfilled") {
          setState("routerTelegramIdentities", telegram.value);
        } else {
          setState("routerTelegramIdentities", null);
          errors.push(`telegram: ${String(telegram.reason)}`);
        }

        if (slack.status === "fulfilled") {
          setState("routerSlackIdentities", slack.value);
        } else {
          setState("routerSlackIdentities", null);
          errors.push(`slack: ${String(slack.reason)}`);
        }

        if (errors.length) {
          showToast(`Router refresh error: ${errors[0]}`);
          return;
        }

        if (opts.toastOnSuccess) {
          showToast(opts.toastOnSuccess);
        }
      };

      createEffect(() => {
        if (state.view !== "router") return;
        if (state.routerAutoLoaded) return;
        setState("routerAutoLoaded", true);
        void refreshRouter();
      });

      let tabSelect: TabSelectRenderable | undefined;
      const tabWidth = createMemo(() => {
        const width = Math.max(0, dimensions().width - 4);
        return Math.max(12, Math.floor(width / viewTabs.length));
      });
      createEffect(() => {
        if (!tabSelect) return;
        const index = viewIndexByName.get(state.view) ?? 0;
        if (tabSelect.getSelectedIndex() !== index) {
          tabSelect.setSelectedIndex(index);
        }
      });

      const copySelection = async (text: string) => {
        let copied = false;
        let error: string | undefined;
        if (options.onCopySelection) {
          try {
            const result = await options.onCopySelection(text);
            copied = result.copied;
            error = result.error;
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }
        }
        if (!copied && renderer.isOsc52Supported()) {
          copied = renderer.copyToClipboardOSC52(text);
        }
        if (!copied) {
          if (error) {
            showToast(`Selection copy failed: ${error}`);
          }
          return;
        }
        showToast("Selection copied");
      };

      let lastCopiedSelection = "";
      useSelectionHandler((selection) => {
        if (!selection || !selection.isActive) {
          lastCopiedSelection = "";
          return;
        }
        const text = selection.getSelectedText();
        if (!text) {
          lastCopiedSelection = "";
          return;
        }
        if (selection.isDragging) return;
        if (text === lastCopiedSelection) return;
        lastCopiedSelection = text;
        void copySelection(text);
      });

      let telegramTokenInput: InputRenderable | undefined;
      let slackTokensInput: InputRenderable | undefined;

      const logHeight = createMemo(() => {
        const height = dimensions().height;
        return clamp(height - 9, 4, height);
      });

      const filteredLogs = createMemo(() => {
        return state.logs.filter((entry) => {
          if (state.serviceFilter !== "all" && entry.component !== state.serviceFilter) return false;
          if (state.levelFilter !== "all" && entry.level !== state.levelFilter) return false;
          return true;
        });
      });

      const visibleLogs = createMemo(() => {
        const items = filteredLogs();
        const total = items.length;
        const height = logHeight();
        const offset = clamp(state.scrollOffset, 0, Math.max(0, total - height));
        const start = Math.max(0, total - height - offset);
        return items.slice(start, start + height);
      });

      const uptimeLabel = createMemo(() => formatDuration(now() - state.uptimeStart));

      const healthLabel = createMemo(() => {
        const active = state.services.filter((item) => item.status !== "disabled");
        if (!active.length) return "No services";
        const unhealthy = active.find((item) => item.status === "error" || item.status === "stopped");
        if (unhealthy) return "Degraded";
        const healthy = active.every((item) => item.status === "healthy" || item.status === "running");
        return healthy ? "All green" : "Starting";
      });

      const routerStatus = createMemo(() => {
        if (!state.routerHealth) return "Pending";
        return state.routerHealth.ok ? "Healthy" : "Needs attention";
      });

      const actions = (view: ViewName) => {
        if (view === "logs") {
          return "[B] Back  [F] Follow  [S] Service  [E] Level  [D] Detach  [Q] Quit";
        }
        if (view === "help") {
          return "[B] Back  [D] Detach  [Q] Quit";
        }
        if (view === "router") {
          return "[B] Back  [R] Refresh  [T] Telegram token  [S] Slack tokens  [G] Toggle groups  [D] Detach  [Q] Quit";
        }
        return "[L] Logs  [W] Router  [C] Copy attach command  [D] Detach  [Q] Quit";
      };

      useKeyboard((evt: KeyEvent) => {
        if (evt.ctrl && evt.name === "c") {
          evt.preventDefault();
          void options.onQuit();
          return;
        }
        if (evt.name === "q") {
          evt.preventDefault();
          void options.onQuit();
          return;
        }
        if (evt.name === "d") {
          evt.preventDefault();
          void options.onDetach();
          return;
        }
        if (state.routerTelegramEditing || state.routerSlackEditing) {
          if (evt.name === "escape") {
            evt.preventDefault();
            setState("routerTelegramEditing", false);
            setState("routerSlackEditing", false);
            telegramTokenInput?.blur();
            slackTokensInput?.blur();
          }
          return;
        }
        if (evt.name === "l") {
          evt.preventDefault();
          setView("logs");
          return;
        }
        if (evt.name === "w") {
          evt.preventDefault();
          setView("router");
          return;
        }
        if (evt.name === "h" || evt.name === "?") {
          evt.preventDefault();
          setView("help");
          return;
        }
        if (evt.name === "b" || evt.name === "o") {
          evt.preventDefault();
          setView("overview");
          return;
        }
        if (evt.name === "c") {
          evt.preventDefault();
          options
            .onCopyAttach()
            .then((result) => {
              const label = result.copied
                ? "Attach command copied"
                : `Attach command ready${result.error ? `: ${result.error}` : ""}`;
              showToast(label);
            })
            .catch((error) => {
              showToast(`Attach command error: ${String(error)}`);
            });
          return;
        }
        if (state.view === "router") {
          if (evt.name === "b" || evt.name === "o") {
            evt.preventDefault();
            setView("overview");
            return;
          }
          if (evt.name === "r") {
            evt.preventDefault();
            void refreshRouter({ toastOnSuccess: "Router refreshed" });
            return;
          }
          if (evt.name === "g") {
            evt.preventDefault();
            const current = state.routerHealth?.config?.groupsEnabled;
            if (typeof current !== "boolean") {
              showToast("Refresh router first");
              return;
            }
            const next = !current;
            options
              .onRouterSetGroupsEnabled(next)
              .then((result) => {
                if (!result.ok) {
                  showToast(result.error ? `Groups error: ${result.error}` : "Groups update failed");
                  return;
                }
                showToast(next ? "Groups enabled" : "Groups disabled");
                void refreshRouter();
              })
              .catch((error) => {
                showToast(`Groups error: ${String(error)}`);
              });
            return;
          }
          if (evt.name === "t") {
            evt.preventDefault();
            setState("routerSlackEditing", false);
            setState("routerTelegramEditing", true);
            setTimeout(() => telegramTokenInput?.focus(), 1);
            return;
          }
          if (evt.name === "s") {
            evt.preventDefault();
            setState("routerTelegramEditing", false);
            setState("routerSlackEditing", true);
            setTimeout(() => slackTokensInput?.focus(), 1);
            return;
          }
        }
        if (state.view !== "logs") return;
        if (evt.name === "f") {
          evt.preventDefault();
          setState("follow", !state.follow);
          if (!state.follow) {
            setState("scrollOffset", 0);
          }
          return;
        }
        if (evt.name === "s") {
          evt.preventDefault();
          const next = serviceCycle[(serviceCycle.indexOf(state.serviceFilter) + 1) % serviceCycle.length];
          setState("serviceFilter", next);
          setState("scrollOffset", 0);
          return;
        }
        if (evt.name === "e") {
          evt.preventDefault();
          const next = levelCycle[(levelCycle.indexOf(state.levelFilter) + 1) % levelCycle.length];
          setState("levelFilter", next);
          setState("scrollOffset", 0);
          return;
        }
        if (evt.name === "up" || evt.name === "k") {
          evt.preventDefault();
          setState("follow", false);
          setState("scrollOffset", (value) => value + 1);
          return;
        }
        if (evt.name === "down" || evt.name === "j") {
          evt.preventDefault();
          setState("scrollOffset", (value) => Math.max(0, value - 1));
          return;
        }
        if (evt.name === "pageup") {
          evt.preventDefault();
          setState("follow", false);
          setState("scrollOffset", (value) => value + logHeight());
          return;
        }
        if (evt.name === "pagedown") {
          evt.preventDefault();
          setState("scrollOffset", (value) => Math.max(0, value - logHeight()));
        }
      });

      return (
        <box flexDirection="column" width={dimensions().width} height={dimensions().height} paddingLeft={2} paddingRight={2}>
          <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              openwork · {state.view}
            </text>
            <text fg={theme.textMuted}>v{options.version}</text>
          </box>
          <text fg={theme.textMuted}>run id: {state.connect.runId}</text>

          <box paddingTop={1}>
            <tab_select
              ref={(node) => {
                tabSelect = node;
                if (tabSelect) {
                  const index = viewIndexByName.get(state.view) ?? 0;
                  tabSelect.setSelectedIndex(index);
                }
              }}
              options={viewTabs}
              tabWidth={tabWidth()}
              showDescription={false}
              showUnderline={true}
              wrapSelection={true}
              backgroundColor={theme.panel}
              textColor={theme.textMuted}
              focusedBackgroundColor={theme.border}
              focusedTextColor={theme.text}
              selectedBackgroundColor={theme.accent}
              selectedTextColor={theme.panel}
              selectedDescriptionColor={theme.text}
              onSelect={(_, option) => {
                if (!option?.value) return;
                setView(option.value as ViewName);
              }}
            />
          </box>

          <Show when={state.view === "overview"}>
            <box flexDirection="row" gap={4} paddingTop={1}>
              <box width={Math.floor(dimensions().width / 2) - 4} flexDirection="column" gap={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Services
                </text>
                <For each={state.services}>
                  {(service) => (
                    <box flexDirection="row" gap={1}>
                      <text fg={statusColor[service.status]}>●</text>
                      <text fg={theme.text}>{service.label}</text>
                      <text fg={theme.textMuted}>{statusLabel[service.status]}</text>
                    </box>
                  )}
                </For>
                <box paddingTop={1}>
                  <text fg={theme.textMuted}>Health: {healthLabel()}</text>
                  <text fg={theme.textMuted}>Uptime: {uptimeLabel()}</text>
                </box>
                <box paddingTop={1}>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    Ports
                  </text>
                  <For each={state.services.filter((item) => item.port)}>
                    {(service) => (
                      <text fg={theme.textMuted}>
                        {service.label}: {service.port}
                      </text>
                    )}
                  </For>
                </box>
              </box>
              <box width={Math.floor(dimensions().width / 2) - 4} flexDirection="column" gap={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Connect
                </text>
                <text fg={theme.textMuted}>OpenWork URL (LAN)</text>
                <text fg={theme.text}>{state.connect.openworkUrl}</text>
                <text fg={theme.textMuted}>OpenWork Token</text>
                <text fg={theme.text}>{state.connect.openworkToken}</text>
                <text fg={theme.textMuted}>Host Token</text>
                <text fg={theme.text}>{state.connect.hostToken}</text>
                <text fg={theme.textMuted}>OpenCode URL</text>
                <text fg={theme.text}>{state.connect.opencodeUrl}</text>
                <Show when={state.connect.opencodePassword}>
                  <text fg={theme.textMuted}>OpenCode Password</text>
                  <text fg={theme.text}>{state.connect.opencodePassword}</text>
                </Show>
                <text fg={theme.textMuted}>Attach command</text>
                <text fg={theme.text}>{state.connect.attachCommand}</text>
              </box>
            </box>
          </Show>

          <Show when={state.view === "logs"}>
            <box flexDirection="column" paddingTop={1} gap={1}>
              <text fg={theme.textMuted}>
                Filters: {state.serviceFilter} · level: {state.levelFilter} · follow: {state.follow ? "on" : "off"}
              </text>
              <box flexDirection="column" gap={0}>
                <For each={visibleLogs()}>
                  {(entry) => (
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.textMuted}>{formatTime(entry.time)}</text>
                      <text fg={theme.textMuted}>[{entry.component}]</text>
                      <text fg={levelColor[entry.level]}>{entry.message}</text>
                    </box>
                  )}
                </For>
              </box>
            </box>
          </Show>

          <Show when={state.view === "router"}>
            <box flexDirection="column" paddingTop={1} gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                opencode-router
              </text>

              <text fg={theme.textMuted}>Health: {routerStatus()}</text>
              <Show when={state.routerHealth}>
                <text fg={theme.textMuted}>
                  OpenCode: {state.routerHealth?.opencode.healthy ? "healthy" : "down"}
                  {state.routerHealth?.opencode.version ? ` (${state.routerHealth?.opencode.version})` : ""}
                </text>
                <text fg={theme.textMuted}>
                  Telegram: {state.routerHealth?.channels.telegram ? "enabled" : "not configured"}
                </text>
                <text fg={theme.textMuted}>Slack: {state.routerHealth?.channels.slack ? "enabled" : "not configured"}</text>
                <text fg={theme.textMuted}>
                  Groups enabled: {state.routerHealth?.config.groupsEnabled ? "yes" : "no"} (press [G] to toggle)
                </text>
              </Show>
              <Show when={!state.routerHealth}>
                <text fg={theme.textMuted}>Press [R] to refresh router status.</text>
              </Show>

              <box paddingTop={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Identities
                </text>
              </box>

              <box flexDirection="row" gap={4}>
                <box width={Math.floor(dimensions().width / 2) - 4} flexDirection="column" gap={0}>
                  <text fg={theme.textMuted}>Telegram</text>
                  <Show when={state.routerTelegramIdentities}>
                    <For each={state.routerTelegramIdentities?.items ?? []}>
                      {(item) => (
                        <text fg={item.running ? theme.success : theme.textMuted}>
                          {item.running ? "●" : "○"} {item.id} {item.enabled ? "" : "(disabled)"}
                        </text>
                      )}
                    </For>
                    <Show when={(state.routerTelegramIdentities?.items ?? []).length === 0}>
                      <text fg={theme.textMuted}>(none)</text>
                    </Show>
                  </Show>
                  <Show when={!state.routerTelegramIdentities}>
                    <text fg={theme.textMuted}>Press [R] to load identities.</text>
                  </Show>
                </box>

                <box width={Math.floor(dimensions().width / 2) - 4} flexDirection="column" gap={0}>
                  <text fg={theme.textMuted}>Slack</text>
                  <Show when={state.routerSlackIdentities}>
                    <For each={state.routerSlackIdentities?.items ?? []}>
                      {(item) => (
                        <text fg={item.running ? theme.success : theme.textMuted}>
                          {item.running ? "●" : "○"} {item.id} {item.enabled ? "" : "(disabled)"}
                        </text>
                      )}
                    </For>
                    <Show when={(state.routerSlackIdentities?.items ?? []).length === 0}>
                      <text fg={theme.textMuted}>(none)</text>
                    </Show>
                  </Show>
                  <Show when={!state.routerSlackIdentities}>
                    <text fg={theme.textMuted}>Press [R] to load identities.</text>
                  </Show>
                </box>
              </box>

              <box paddingTop={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Configure
                </text>
              </box>

              <text fg={theme.textMuted}>Telegram token (default identity)</text>
              <input
                value={state.routerTelegramToken}
                placeholder="Paste token and press enter"
                focused={state.routerTelegramEditing}
                onInput={(value) => setState("routerTelegramToken", value)}
                onSubmit={(value) => {
                  const token = typeof value === "string" ? value.trim() : "";
                  if (!token) {
                    showToast("Telegram token required");
                    return;
                  }
                  options
                    .onRouterSetTelegramToken(token)
                    .then((result) => {
                      if (!result.ok) {
                        showToast(result.error ? `Telegram error: ${result.error}` : "Telegram token failed");
                        return;
                      }
                      setState("routerTelegramToken", "");
                      setState("routerTelegramEditing", false);
                      telegramTokenInput?.blur();
                      showToast("Telegram identity saved");
                      void refreshRouter();
                    })
                    .catch((error) => {
                      showToast(`Telegram error: ${String(error)}`);
                    });
                }}
                ref={(node) => {
                  telegramTokenInput = node;
                  if (state.routerTelegramEditing) {
                    setTimeout(() => telegramTokenInput?.focus(), 1);
                  }
                }}
              />

              <text fg={theme.textMuted}>Slack tokens (default identity)</text>
              <input
                value={state.routerSlackTokens}
                placeholder="Paste xoxb-... xapp-... and press enter"
                focused={state.routerSlackEditing}
                onInput={(value) => setState("routerSlackTokens", value)}
                onSubmit={(value) => {
                  const raw = typeof value === "string" ? value.trim() : "";
                  if (!raw) {
                    showToast("Slack tokens required");
                    return;
                  }

                  const parts = raw.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
                  const botToken = parts.find((p) => p.startsWith("xoxb-")) ?? parts[0];
                  const appToken = parts.find((p) => p.startsWith("xapp-")) ?? parts[1];
                  if (!botToken || !appToken) {
                    showToast("Expected: xoxb-... xapp-...");
                    return;
                  }

                  options
                    .onRouterSetSlackTokens(botToken, appToken)
                    .then((result) => {
                      if (!result.ok) {
                        showToast(result.error ? `Slack error: ${result.error}` : "Slack tokens failed");
                        return;
                      }
                      setState("routerSlackTokens", "");
                      setState("routerSlackEditing", false);
                      slackTokensInput?.blur();
                      showToast("Slack identity saved");
                      void refreshRouter();
                    })
                    .catch((error) => {
                      showToast(`Slack error: ${String(error)}`);
                    });
                }}
                ref={(node) => {
                  slackTokensInput = node;
                  if (state.routerSlackEditing) {
                    setTimeout(() => slackTokensInput?.focus(), 1);
                  }
                }}
              />
            </box>
          </Show>

          <Show when={state.view === "help"}>
            <box flexDirection="column" paddingTop={1} gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Shortcuts
              </text>
              <text fg={theme.textMuted}>L: Logs</text>
              <text fg={theme.textMuted}>W: Router</text>
              <text fg={theme.textMuted}>C: Copy attach command</text>
              <text fg={theme.textMuted}>R: Refresh router</text>
              <text fg={theme.textMuted}>G: Toggle groups (router)</text>
              <text fg={theme.textMuted}>T: Telegram token (router)</text>
              <text fg={theme.textMuted}>S: Slack tokens (router)</text>
              <text fg={theme.textMuted}>D: Detach</text>
              <text fg={theme.textMuted}>Q: Quit</text>
              <text fg={theme.textMuted}>Mouse: click tabs</text>
              <text fg={theme.textMuted}>Mouse: select text to copy</text>
            </box>
          </Show>

          <box paddingTop={1}>
            <Show when={toast()}>
              {(val) => <text fg={theme.accent}>{val()}</text>}
            </Show>
          </box>

          <box paddingTop={1}>
            <text fg={theme.textMuted}>Actions: {actions(state.view)}</text>
          </box>
        </box>
      );
    },
    {
      targetFps: 60,
      gatherStats: false,
      exitOnCtrlC: false,
      useMouse: true,
      enableMouseMovement: true,
      useKittyKeyboard: {},
      autoFocus: false,
      consoleOptions: {
        keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
      },
    },
  );

  return api;
}
