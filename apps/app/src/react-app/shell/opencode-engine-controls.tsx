/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import type { EngineV2PreviewStatus, OpenworkServerClient } from "@/app/lib/openwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import type { PaletteItem } from "./command-palette-search";

export type OpencodeEngineClient = Pick<OpenworkServerClient, "getEngineV2PreviewStatus" | "switchOpencodeEngine" | "migrateOpencodeHistory">;

export function useOpencodeEngineControls(client: OpencodeEngineClient | null | undefined, active = true) {
  const migrationRequested = useRef(false);
  const [status, setStatus] = useState<EngineV2PreviewStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [migrationOpen, setMigrationOpen] = useState(false);
  const available = isDesktopRuntime() && Boolean(client);
  useEffect(() => {
    if (!client || !available || (!active && !migrationOpen && !busy && status?.migration?.state !== "running" && !(status?.enabled && !status.running))) return;
    let disposed = false;
    const refresh = async () => {
      try { const next = await client.getEngineV2PreviewStatus(); if (!disposed) { setStatus(next); setError(null); } }
      catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : "Reconnect to check the chat engine."); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [client, available, active, migrationOpen, busy, status?.migration?.state, status?.enabled, status?.running]);
  const blockedReason = !available ? "Available in the desktop app with a local server connection."
    : error ? "Reconnect to check the chat engine."
    : !status ? "Checking chat engine…" : undefined;
  const migrating = status?.migration?.state === "running";
  const disabled = Boolean(blockedReason) || busy || migrating;
  const selected = status?.enabled && status.chatRouting ? "v2" : "v1";
  const run = async (operation: () => Promise<EngineV2PreviewStatus>) => {
    if (disabled) return;
    setBusy(true);
    setError(null);
    try { setStatus(await operation()); }
    catch (cause) { const message = cause instanceof Error ? cause.message : "Could not update the engine. Try again."; setError(message); toast.error(message); }
    finally { setBusy(false); }
  };
  const select = (engine: "v1" | "v2") => client && void run(async () => {
    const next = await client.switchOpencodeEngine(engine);
    window.dispatchEvent(new CustomEvent("openwork-engine-changed"));
    return next;
  });
  const items: PaletteItem[] = (["v1", "v2"] satisfies Array<"v1" | "v2">).map((engine) => ({
    id: `opencode.switch-${engine}`, title: `Switch to OpenCode ${engine}`,
    keywords: ["engine", "toggle", "enable", "opencode", engine], group: "actions",
    meta: selected === engine && status ? "Selected" : engine === "v2" ? "Preview" : undefined,
    detail: blockedReason ?? (migrating ? "Wait for history migration to finish." : undefined),
    disabled: disabled || (Boolean(status) && selected === engine), action: () => select(engine),
  }));
  items.push({ id: "opencode.migrate-v2", title: "Migrate chats to OpenCode v2", keywords: ["migration", "history", "import", "v1", "v2"],
    group: "actions", disabled: disabled || !status?.migration,
    detail: blockedReason ?? (!status?.migration ? "Update OpenWork to migrate chats." : undefined),
    action: () => setMigrationOpen(true) });
  const migration = status?.migration;
  const message = migration?.state === "running" ? `Migrating chats: ${migration.imported + migration.skipped} of ${migration.total}`
    : migration?.state === "completed" ? `Migrated ${migration.imported} ${migration.imported === 1 ? "chat" : "chats"}; ${migration.skipped} already in v2.`
    : migration?.state === "error" ? migration.error : undefined;
  useEffect(() => {
    if (!migrationRequested.current || !migration) return;
    if (migration.state === "completed" || migration.state === "error") {
      migrationRequested.current = false;
      if (migration.state === "completed") toast.success(message ?? "Migrated chats to OpenCode v2.");
      else toast.error(message ?? "Migration failed. Retry migration.");
    }
  }, [migration, message]);
  const dialog = <AlertDialog open={migrationOpen} onOpenChange={setMigrationOpen}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Migrate chats to OpenCode v2?</AlertDialogTitle></AlertDialogHeader>
      <AlertDialogDescription>
        Copy local v1 chat history into v2 on this computer. Your v1 history stays unchanged, and existing v2 chats are skipped.
        Stop active tasks first. Later v1 changes will not sync to chats already copied.
        OpenCode resets chat permissions and revert state; unsupported history or attachments may be omitted.
        Review permissions before continuing migrated chats. V1 plugins need v2-compatible replacements.
        This does not switch your chat engine.
      </AlertDialogDescription>
      <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button disabled={disabled} onClick={() => { setMigrationOpen(false); if (client) { migrationRequested.current = true; void run(() => client.migrateOpencodeHistory()); } }}>Migrate chats</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
  return { status, selected, disabled, blockedReason, busy, error, select, items, dialog, message,
    openMigration: () => setMigrationOpen(true) };
}
