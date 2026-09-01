import { useCallback, useEffect, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type RetiredCoworker } from "@/lib/bridge";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { Button, ErrorNote } from "@/ui/kit";

function retiredWhen(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Retired coworkers stay on disk under `.retired/` until removed here. This
 * is the only place a coworker home is permanently deleted, and it needs a
 * second, separately armed click.
 */
export function RetiredCoworkers({ onRestored }: { onRestored: (coworker: CoworkerSummary) => void }) {
  const [items, setItems] = useState<RetiredCoworker[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");

  const refresh = useCallback(async () => {
    try {
      setItems(await coworkerBridge.coworkers.listRetired());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const timer = window.setTimeout(() => setConfirmDeleteId(""), 8_000);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteId]);

  async function restore(archiveId: string) {
    setBusyId(archiveId);
    setError("");
    try {
      onRestored(await coworkerBridge.coworkers.restore(archiveId));
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId("");
    }
  }

  async function deletePermanently(archiveId: string) {
    setBusyId(archiveId);
    setError("");
    try {
      await coworkerBridge.coworkers.deleteRetired(archiveId);
      setConfirmDeleteId("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId("");
    }
  }

  if (items.length === 0 && !error) return null;

  return (
    <section aria-label="Retired coworkers" className="mx-auto mt-4 w-full max-w-3xl rounded-2xl border border-line bg-ink/70 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-mist">Retired coworkers</h2>
        <p className="text-[11px] text-mist">Kept on disk until you delete them</p>
      </div>
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
      <ul className="mt-3 space-y-2">
        {items.map((item) => {
          const busy = busyId === item.archiveId;
          const confirming = confirmDeleteId === item.archiveId;
          return (
            <li key={item.archiveId} className="flex items-center gap-3 rounded-xl border border-line bg-panel/50 px-3 py-2.5">
              <CoworkerAvatar animated={false} color={item.avatarColor} glasses={item.avatarGlasses} name={item.name} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-snow">{item.name}</span>
                <span className="block truncate text-[11px] text-mist">
                  {[item.role, retiredWhen(item.retiredAt) ? `retired ${retiredWhen(item.retiredAt)}` : "", `${item.fileCount} file${item.fileCount === 1 ? "" : "s"}`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <Button
                  variant="primary"
                  className="text-xs"
                  disabled={busy || !item.canRestore}
                  title={item.canRestore ? undefined : `A live coworker already uses the name "${item.slug}"`}
                  onClick={() => void restore(item.archiveId)}
                >
                  {busy ? "Restoring…" : "Restore"}
                </Button>
                {confirming ? (
                  <Button variant="danger" className="text-xs" disabled={busy} onClick={() => void deletePermanently(item.archiveId)}>
                    {busy ? "Deleting…" : "Delete forever"}
                  </Button>
                ) : (
                  <Button variant="ghost" className="text-xs text-rose" disabled={busy} onClick={() => setConfirmDeleteId(item.archiveId)}>
                    Delete…
                  </Button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
