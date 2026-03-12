import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Settings } from "lucide-solid";

import type { OpenworkServerStatus } from "../lib/openwork-server";
import type { OpenCodeRouterStatus } from "../lib/tauri";
import type { McpStatusMap } from "../types";
import { getOpenCodeRouterStatus } from "../lib/tauri";

import Button from "./button";

type StatusBarProps = {
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  developerMode: boolean;
  settingsOpen: boolean;
  onOpenSettings: () => void;
  onOpenMessaging: () => void;
  onOpenProviders: () => Promise<void> | void;
  onOpenMcp: () => void;
  providerConnectedIds: string[];
  mcpStatuses: McpStatusMap;
};

export default function StatusBar(props: StatusBarProps) {
  const [opencodeRouterStatus, setOpenCodeRouterStatus] = createSignal<OpenCodeRouterStatus | null>(null);
  const [documentVisible, setDocumentVisible] = createSignal(true);

  type ProTip = {
    id: string;
    label: string;
    enabled: () => boolean;
    action: () => void | Promise<void>;
  };

  const providerConnectedCount = createMemo(() => props.providerConnectedIds?.length ?? 0);
  const notionStatus = createMemo(() => props.mcpStatuses?.notion?.status ?? "disconnected");

  const runAction = (action?: () => void | Promise<void>) => {
    if (!action) return;
    const result = action();
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => undefined);
    }
  };

  const proTips = createMemo<ProTip[]>(() => [
    {
      id: "slack",
      label: "Connect Slack",
      enabled: () => {
        const status = opencodeRouterStatus();
        return Boolean(status && (status.slack.items?.length ?? 0) === 0);
      },
      action: () => runAction(props.onOpenMessaging),
    },
    {
      id: "telegram",
      label: "Connect Telegram",
      enabled: () => {
        const status = opencodeRouterStatus();
        return Boolean(status && (status.telegram.items?.length ?? 0) === 0);
      },
      action: () => runAction(props.onOpenMessaging),
    },
    {
      id: "notion",
      label: "Connect Notion MCP",
      enabled: () => notionStatus() !== "connected",
      action: () => runAction(props.onOpenMcp),
    },
    {
      id: "providers",
      label: "Use your own models (OpenRouter, Anthropic, OpenAI)",
      enabled: () => props.clientConnected && providerConnectedCount() === 0,
      action: () => runAction(props.onOpenProviders),
    },
  ]);

  const availableTips = createMemo<ProTip[]>(() => proTips().filter((tip: ProTip) => tip.enabled()));
  const [activeTip, setActiveTip] = createSignal<ProTip | null>(null);
  const [tipVisible, setTipVisible] = createSignal(false);
  const [tipCursor, setTipCursor] = createSignal(0);
  let tipTimer: number | undefined;
  let tipHideTimer: number | undefined;

  const pickNextTip = () => {
    const tips = availableTips();
    if (!tips.length) return null;
    const index = tipCursor() % tips.length;
    const next = tips[index];
    setTipCursor(index + 1);
    setActiveTip(next);
    return next;
  };

  const scheduleTips = (delayMs: number) => {
    if (tipTimer) window.clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => {
      if (!availableTips().length) {
        setTipVisible(false);
        scheduleTips(20_000);
        return;
      }
      if (Math.random() < 0.55) {
        pickNextTip();
        setTipVisible(true);
        if (tipHideTimer) window.clearTimeout(tipHideTimer);
        tipHideTimer = window.setTimeout(() => setTipVisible(false), 9_000);
      } else {
        setTipVisible(false);
      }
      scheduleTips(18_000 + Math.round(Math.random() * 10_000));
    }, delayMs);
  };

  createEffect(() => {
    const tips = availableTips();
    const current = activeTip();
    if (current && tips.some((tip: ProTip) => tip.id === current.id)) return;
    if (!tips.length) {
      setActiveTip(null);
      setTipVisible(false);
      return;
    }
    setActiveTip(tips[0]);
    setTipCursor(1);
  });

  const refreshOpenCodeRouter = async () => {
    const next = await getOpenCodeRouterStatus();
    setOpenCodeRouterStatus(next);
  };

  createEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    onCleanup(() => document.removeEventListener("visibilitychange", update));
  });

  createEffect(() => {
    if (!documentVisible()) return;
    refreshOpenCodeRouter();
    const interval = window.setInterval(refreshOpenCodeRouter, 15_000);
    onCleanup(() => window.clearInterval(interval));
  });

  onMount(() => {
    scheduleTips(6_000);
    onCleanup(() => {
      if (tipTimer) window.clearTimeout(tipTimer);
      if (tipHideTimer) window.clearTimeout(tipHideTimer);
    });
  });

  return (
    <div class="border-t border-gray-6 bg-gray-1/90 backdrop-blur-md">
      <div class="px-4 py-2 flex flex-wrap items-center justify-end gap-2 text-xs">
        <Show when={tipVisible() && activeTip()}>
          <button
            type="button"
            class="flex h-7 items-center gap-2 rounded-full border border-gray-6/70 bg-gray-2/40 px-3 text-xs text-gray-10 transition-colors hover:bg-gray-2/60"
            onClick={() => runAction(activeTip()?.action)}
            title={activeTip()?.label}
            aria-label={activeTip()?.label}
          >
            <span class="uppercase tracking-[0.2em] text-[10px] text-gray-8">Tip</span>
            <span class="text-gray-11 font-medium">{activeTip()?.label}</span>
          </button>
        </Show>
        <Button
          variant="ghost"
          class={`h-7 px-2.5 py-0 text-xs ${props.settingsOpen ? "bg-gray-3 text-gray-12 hover:bg-gray-4" : ""}`}
          onClick={props.onOpenSettings}
          title={props.settingsOpen ? "Back to previous screen" : "Settings"}
        >
          <Settings class="w-4 h-4" />
          <Show when={props.developerMode}>
            <span class="text-gray-11 font-medium">{props.settingsOpen ? "Back" : "Settings"}</span>
          </Show>
        </Button>
      </div>
    </div>
  );
}
