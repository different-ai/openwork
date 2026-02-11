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

export type TuiOwpenbotHealth = {
  ok: boolean;
  opencode: {
    url: string;
    healthy: boolean;
    version?: string;
  };
  channels: {
    telegram: boolean;
    whatsapp: boolean;
    slack: boolean;
  };
  config: {
    groupsEnabled: boolean;
  };
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
  setOwpenbotHealth: (health: TuiOwpenbotHealth | null) => void;
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
  onOwpenbotHealth: () => Promise<TuiOwpenbotHealth>;
  onOwpenbotQr: () => Promise<string>;
  onOwpenbotSetTelegramToken: (token: string) => Promise<{ ok: boolean; error?: string }>;
};

type ViewName = "overview" | "logs" | "help" | "owpenbot";

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

const serviceCycle = ["all", "openwrk", "opencode", "openwork-server", "owpenbot"];

const viewTabs: Array<{ name: string; description: string; value: ViewName }> = [
  { name: "Overview", description: "Overview", value: "overview" },
  { name: "Logs", description: "Logs", value: "logs" },
  { name: "Owpenbot", description: "Owpenbot", value: "owpenbot" },
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

export function startOpenwrkTui(options: TuiOptions): TuiHandle {
  let stop: (() => void) | undefined;
  const api: TuiHandle = {
    updateService: () => undefined,
    setConnectInfo: () => undefined,
    setOwpenbotHealth: () => undefined,
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
        owpenbotHealth: null as TuiOwpenbotHealth | null,
        owpenbotQr: "",
        owpenbotQrError: "",
        owpenbotToken: "",
        owpenbotEditing: false,
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

      api.setOwpenbotHealth = (health) => {
        setState("owpenbotHealth", health);
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
        if (view !== "owpenbot") {
          setState("owpenbotEditing", false);
        }
      };

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

      let tokenInput: InputRenderable | undefined;

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

      const owpenbotStatus = createMemo(() => {
        if (!state.owpenbotHealth) return "Pending";
        return state.owpenbotHealth.ok ? "Healthy" : "Needs attention";
      });

      const actions = (view: ViewName) => {
        if (view === "logs") {
          return "[B] Back  [F] Follow  [S] Service  [E] Level  [D] Detach  [Q] Quit";
        }
        if (view === "help") {
          return "[B] Back  [D] Detach  [Q] Quit";
        }
        if (view === "owpenbot") {
          return "[B] Back  [G] QR  [T] Telegram token  [R] Refresh  [D] Detach  [Q] Quit";
        }
        return "[L] Logs  [W] Owpenbot  [C] Copy attach command  [D] Detach  [Q] Quit";
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
        if (state.owpenbotEditing) {
          if (evt.name === "escape") {
            evt.preventDefault();
            setState("owpenbotEditing", false);
            tokenInput?.blur();
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
          setView("owpenbot");
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
        if (state.view === "owpenbot") {
          if (evt.name === "b" || evt.name === "o") {
            evt.preventDefault();
            setView("overview");
            return;
          }
          if (evt.name === "g") {
            evt.preventDefault();
            setState("owpenbotQr", "");
            setState("owpenbotQrError", "");
            options
              .onOwpenbotQr()
              .then((qr) => {
                setState("owpenbotQr", qr.trim());
                showToast("WhatsApp QR loaded");
              })
              .catch((error) => {
                setState("owpenbotQrError", String(error));
                showToast("WhatsApp QR failed");
              });
            return;
          }
          if (evt.name === "r") {
            evt.preventDefault();
            options
              .onOwpenbotHealth()
              .then((health) => {
                api.setOwpenbotHealth(health);
                showToast("Owpenbot health refreshed");
              })
              .catch((error) => {
                showToast(`Owpenbot health error: ${String(error)}`);
              });
            return;
          }
          if (evt.name === "t") {
            evt.preventDefault();
            setState("owpenbotEditing", true);
            setTimeout(() => tokenInput?.focus(), 1);
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
              openwrk · {state.view}
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

          <Show when={state.view === "owpenbot"}>
            <box flexDirection="column" paddingTop={1} gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Owpenbot
              </text>
              <text fg={theme.textMuted}>Health: {owpenbotStatus()}</text>
              <Show when={state.owpenbotHealth}>
                <text fg={theme.textMuted}>
                  OpenCode: {state.owpenbotHealth?.opencode.healthy ? "healthy" : "down"}
                </text>
                <text fg={theme.textMuted}>
                  WhatsApp: {state.owpenbotHealth?.channels.whatsapp ? "connected" : "not connected"}
                </text>
                <text fg={theme.textMuted}>
                  Telegram: {state.owpenbotHealth?.channels.telegram ? "enabled" : "not configured"}
                </text>
                <text fg={theme.textMuted}>
                  Slack: {state.owpenbotHealth?.channels.slack ? "enabled" : "not configured"}
                </text>
                <text fg={theme.textMuted}>
                  Groups enabled: {state.owpenbotHealth?.config.groupsEnabled ? "yes" : "no"}
                </text>
              </Show>
              <Show when={!state.owpenbotHealth}>
                <text fg={theme.textMuted}>Press [R] to refresh owpenbot health.</text>
              </Show>

              <box paddingTop={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  WhatsApp QR
                </text>
              </box>
              <Show when={state.owpenbotQr}>
                <box flexDirection="column" gap={0}>
                  <For each={state.owpenbotQr.split(/\r?\n/)}>
                    {(line) => <text fg={theme.textMuted}>{line}</text>}
                  </For>
                </box>
              </Show>
              <Show when={!state.owpenbotQr && !state.owpenbotQrError}>
                <text fg={theme.textMuted}>Press [G] to fetch a QR code.</text>
              </Show>
              <Show when={state.owpenbotQrError}>
                <text fg={theme.error}>{state.owpenbotQrError}</text>
              </Show>

              <box paddingTop={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Telegram token
                </text>
              </box>
              <input
                value={state.owpenbotToken}
                placeholder="Paste token and press enter"
                focused={state.owpenbotEditing}
                onInput={(value) => setState("owpenbotToken", value)}
                onSubmit={(value) => {
                  const token = typeof value === "string" ? value.trim() : "";
                  if (!token) {
                    showToast("Telegram token required");
                    return;
                  }
                  options
                    .onOwpenbotSetTelegramToken(token)
                    .then((result) => {
                      if (!result.ok) {
                        showToast(result.error ? `Telegram error: ${result.error}` : "Telegram token failed");
                        return;
                      }
                      setState("owpenbotToken", "");
                      setState("owpenbotEditing", false);
                      tokenInput?.blur();
                      showToast("Telegram token saved");
                    })
                    .catch((error) => {
                      showToast(`Telegram error: ${String(error)}`);
                    });
                }}
                ref={(node) => {
                  tokenInput = node;
                  if (state.owpenbotEditing) {
                    setTimeout(() => tokenInput?.focus(), 1);
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
              <text fg={theme.textMuted}>W: Owpenbot</text>
              <text fg={theme.textMuted}>C: Copy attach command</text>
              <text fg={theme.textMuted}>G: WhatsApp QR (owpenbot)</text>
              <text fg={theme.textMuted}>T: Telegram token (owpenbot)</text>
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
