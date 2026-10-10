/** @jsxImportSource react */
import { useEffect, useState } from "react";
import type { EngineV2PreviewStatus } from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import type { PaletteItem } from "./command-palette-search";
import {
  engineMigrationMessage,
  observeEngineMigration,
  requestEngineMigration,
  requestEngineSwitch,
  selectedChatEngine,
  useEngineMigrationStore,
  type ChatEngine,
  type EngineMigrationClient,
} from "./engine-migration";

export type OpencodeEngineClient = EngineMigrationClient;

/**
 * Engine selection and migration commands for a surface (Advanced settings,
 * the command palette). Dialogs and progress live in the app-wide
 * EngineMigrationOverlay so a migration stays visible after this surface closes.
 */
export function useOpencodeEngineControls(client: OpencodeEngineClient | null | undefined, active = true) {
  const [status, setStatus] = useState<EngineV2PreviewStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const switching = useEngineMigrationStore((state) => state.switching);
  const consentOpen = useEngineMigrationStore((state) => state.consent !== null);
  const trackedMigration = useEngineMigrationStore((state) => state.progress?.migration);
  const available = isDesktopRuntime() && Boolean(client);
  useEffect(() => {
    if (!client || !available || (!active && status?.migration?.state !== "running" && !(status?.enabled && !status.running))) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await client.getEngineV2PreviewStatus();
        if (disposed) return;
        setStatus(next);
        setError(null);
        observeEngineMigration(client, next);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Reconnect to check the chat engine.");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [client, available, active, status?.migration?.state, status?.enabled, status?.running]);
  const blockedReason = !available ? "Available in the desktop app with a local server connection."
    : error ? "Reconnect to check the chat engine."
    : !status ? "Checking chat engine…" : undefined;
  // The overlay polls a migration it tracks faster than this surface does.
  const migration = trackedMigration ?? status?.migration;
  const migrating = migration?.state === "running";
  const busy = switching || consentOpen;
  const disabled = Boolean(blockedReason) || busy || migrating;
  const selected: ChatEngine = status ? selectedChatEngine(status) : "v1";
  const select = (engine: ChatEngine) => {
    if (!client || disabled || engine === selected) return;
    void requestEngineSwitch(client, engine, selected).then((next) => { if (next) setStatus(next); });
  };
  const openMigration = () => {
    if (!client || disabled) return;
    requestEngineMigration(client);
  };
  const items: PaletteItem[] = (["v1", "v2"] satisfies ChatEngine[]).map((engine) => ({
    id: `opencode.switch-${engine}`, title: `Switch to OpenCode ${engine}`,
    keywords: ["engine", "toggle", "enable", "opencode", engine], group: "actions",
    meta: selected === engine && status ? "Selected" : engine === "v2" ? "Preview" : undefined,
    detail: blockedReason ?? (migrating ? "Wait for chat migration to finish." : undefined),
    disabled: disabled || (Boolean(status) && selected === engine), action: () => select(engine),
  }));
  items.push({ id: "opencode.migrate-v2", title: "Migrate chats to OpenCode v2", keywords: ["migration", "history", "import", "v1", "v2"],
    group: "actions", disabled: disabled || !status?.migration,
    detail: blockedReason ?? (!status?.migration ? "Update OpenWork to migrate chats." : undefined),
    action: openMigration });
  return { status, selected, disabled, blockedReason, busy, migrating, error, select, items, message: engineMigrationMessage(migration), openMigration };
}
