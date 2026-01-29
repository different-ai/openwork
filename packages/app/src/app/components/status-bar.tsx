import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Cpu, MessageCircle, Server, Settings } from "lucide-solid";

import type { OpenworkServerStatus } from "../lib/openwork-server";
import type { OwpenbotStatus } from "../lib/tauri";
import { getOwpenbotStatus } from "../lib/tauri";

import Button from "./button";

type StatusBarProps = {
  mode: "host" | "client" | null;
  busy: boolean;
  clientConnected: boolean;
  openworkServerStatus: OpenworkServerStatus;
  developerMode: boolean;
  stopHost: () => void;
  onOpenSettings: () => void;
  onOpenMessaging: () => void;
};

export default function StatusBar(props: StatusBarProps) {
  const [owpenbotStatus, setOwpenbotStatus] = createSignal<OwpenbotStatus | null>(null);

  const opencodeStatusMeta = createMemo(() => ({
    dot: props.clientConnected ? "bg-green-9" : "bg-gray-6",
    text: props.clientConnected ? "text-green-11" : "text-gray-10",
    label: props.clientConnected ? "Connected" : "Not connected",
  }));

  const openworkStatusMeta = createMemo(() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return { dot: "bg-green-9", text: "text-green-11", label: "Ready" };
      case "limited":
        return { dot: "bg-amber-9", text: "text-amber-11", label: "Limited access" };
      default:
        return { dot: "bg-gray-6", text: "text-gray-10", label: "Unavailable" };
    }
  });

  const messagingMeta = createMemo(() => {
    const status = owpenbotStatus();
    if (!status) {
      return { dot: "bg-gray-6", text: "text-gray-10", label: "Messaging bridge unavailable" };
    }
    const whatsappLinked = status.whatsapp.linked;
    const telegramConfigured = status.telegram.configured;
    if (whatsappLinked && telegramConfigured) {
      return { dot: "bg-green-9", text: "text-green-11", label: "Messaging bridge ready" };
    }
    if (whatsappLinked || telegramConfigured || status.running) {
      return { dot: "bg-amber-9", text: "text-amber-11", label: "Messaging bridge setup" };
    }
    return { dot: "bg-gray-6", text: "text-gray-10", label: "Messaging bridge offline" };
  });

  const messagingHint = createMemo(() => {
    const status = owpenbotStatus();
    if (!status) return "";
    const hints: string[] = [];
    if (!status.telegram.configured) hints.push("Connect Telegram");
    if (!status.whatsapp.linked) hints.push("Connect WhatsApp (Alpha)");
    return hints.join(" / ");
  });

  const refreshOwpenbot = async () => {
    const next = await getOwpenbotStatus();
    setOwpenbotStatus(next);
  };

  onMount(() => {
    refreshOwpenbot();
    const interval = window.setInterval(refreshOwpenbot, 15_000);
    onCleanup(() => window.clearInterval(interval));
  });

  return (
    <div class="border-t border-gray-6 bg-gray-1/90 backdrop-blur-md">
      <div class="mx-auto max-w-5xl px-4 py-2 flex flex-wrap items-center gap-3 text-xs">
        <div
          class="flex items-center gap-2"
          title={`OpenCode Engine: ${opencodeStatusMeta().label}`}
        >
          <span class={`w-2 h-2 rounded-full ${opencodeStatusMeta().dot}`} />
          <Cpu class="w-4 h-4 text-gray-11" />
          <Show when={props.developerMode}>
            <span class="text-gray-11 font-medium">OpenCode</span>
            <span class={opencodeStatusMeta().text}>{opencodeStatusMeta().label}</span>
          </Show>
        </div>
        <div class="w-px h-4 bg-gray-6/70" />
        <div
          class="flex items-center gap-2"
          title={`OpenWork Server: ${openworkStatusMeta().label}`}
        >
          <span class={`w-2 h-2 rounded-full ${openworkStatusMeta().dot}`} />
          <Server class="w-4 h-4 text-gray-11" />
          <Show when={props.developerMode}>
            <span class="text-gray-11 font-medium">OpenWork</span>
            <span class={openworkStatusMeta().text}>{openworkStatusMeta().label}</span>
          </Show>
        </div>
        <div class="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            class="h-7 px-2.5 py-0 text-xs"
            onClick={props.onOpenMessaging}
            title={messagingMeta().label}
          >
            <span class="relative">
              <MessageCircle class={`w-4 h-4 ${messagingMeta().text}`} />
              <span class={`absolute -right-1 -bottom-1 w-2 h-2 rounded-full ${messagingMeta().dot}`} />
            </span>
            <Show when={props.developerMode}>
              <span class="text-gray-11 font-medium">Messaging</span>
            </Show>
            <Show when={messagingHint()}>
              <span class="hidden md:inline text-[10px] uppercase tracking-wide text-gray-9/70 animate-pulse">
                {messagingHint()}
              </span>
            </Show>
          </Button>
          <Button
            variant="ghost"
            class="h-7 px-2.5 py-0 text-xs"
            onClick={props.onOpenSettings}
            title="Settings"
          >
            <Settings class="w-4 h-4" />
            <Show when={props.developerMode}>
              <span class="text-gray-11 font-medium">Settings</span>
            </Show>
          </Button>
          <Show when={props.mode === "host"}>
            <Button
              variant="danger"
              onClick={props.stopHost}
              disabled={props.busy}
              class="text-xs h-7 px-2.5 py-0"
            >
              Stop & Disconnect
            </Button>
          </Show>
          <Show when={props.mode === "client"}>
            <Button
              variant="outline"
              onClick={props.stopHost}
              disabled={props.busy}
              class="text-xs h-7 px-2.5 py-0"
            >
              Disconnect
            </Button>
          </Show>
        </div>
      </div>
    </div>
  );
}
