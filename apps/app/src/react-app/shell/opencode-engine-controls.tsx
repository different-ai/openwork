/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type { EngineV2PreviewStatus } from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import type { PaletteItem } from "./command-palette-search";
import {
  requestEngineSwitch,
  selectedChatEngine,
  useEngineSwitchStore,
  type ChatEngine,
  type EngineSwitchClient,
} from "./engine-switch";

export type OpencodeEngineClient = EngineSwitchClient;

/** Engine selection shared by Advanced settings and the command palette. */
export function useOpencodeEngineControls(client: OpencodeEngineClient | null | undefined, active = true) {
  const [status, setStatus] = useState<EngineV2PreviewStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useEngineSwitchStore((state) => state.switching);
  const desktop = isDesktopRuntime();
  const available = desktop && Boolean(client);
  useEffect(() => {
    if (!client || !available || (!active && !(status?.enabled && !status.running))) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await client.getEngineV2PreviewStatus();
        if (disposed) return;
        setStatus(next);
        setError(null);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Reconnect to check the chat engine.");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [client, available, active, status?.enabled, status?.running]);
  const blockedReason = !available ? "Available in the desktop app with a local server connection."
    : error ? "Reconnect to check the chat engine."
    : !status ? "Checking chat engine…" : undefined;
  const disabled = Boolean(blockedReason) || busy;
  const selected: ChatEngine = status ? selectedChatEngine(status) : "v1";
  // Policy and shared-history safety both keep v1 visible but locked (DESIGN P4).
  const v2Only = status?.v2Only === true;
  const v1Locked = status?.v1UnavailableReason || (v2Only ? V2_ONLY_REASON : undefined);
  const select = (engine: ChatEngine) => {
    if (!client || disabled || engine === selected || (engine === "v1" && Boolean(v1Locked))) return;
    void requestEngineSwitch(client, engine, selected).then((next) => { if (next) setStatus(next); });
  };
  const items: PaletteItem[] = (["v1", "v2"] satisfies ChatEngine[]).map((engine) => ({
    id: `opencode.switch-${engine}`, title: `Switch to OpenCode ${engine}`,
    keywords: ["engine", "toggle", "enable", "opencode", engine], group: "actions",
    meta: selected === engine && status ? "Selected" : engine === "v2" ? "Preview" : undefined,
    detail: blockedReason ?? (engine === "v1" ? v1Locked : undefined),
    disabled: disabled || (Boolean(status) && selected === engine) || (engine === "v1" && Boolean(v1Locked)), action: () => select(engine),
  }));
  return { status, selected, disabled, blockedReason, busy, error, select, v2Only, v1Locked, items: desktop ? items : [] };
}

export const V2_ONLY_REASON = "Your organization runs every chat on OpenCode v2.";
