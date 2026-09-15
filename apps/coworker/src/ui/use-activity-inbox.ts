import { useCallback, useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerActivityItem } from "@/lib/bridge";

const POLL_MS = 4_000;

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** The native inbox owns both notifications and read state. Observing never acknowledges. */
export function useActivityInbox(enabled: boolean): {
  items: CoworkerActivityItem[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  markRead: (ids: string[], read?: boolean) => Promise<void>;
  busy: boolean;
} {
  const [items, setItems] = useState<CoworkerActivityItem[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const active = useRef(false);
  const listFlight = useRef<Promise<void> | null>(null);
  const writeTail = useRef<Promise<void>>(Promise.resolve());
  const pendingWrites = useRef(0);
  const writeRevision = useRef(0);

  const refresh = useCallback((): Promise<void> => {
    if (!active.current || document.hidden || pendingWrites.current > 0) return Promise.resolve();
    if (listFlight.current) return listFlight.current;

    const revision = writeRevision.current;
    setLoading(true);
    // Start on a microtask so even a synchronous bridge failure releases the flight.
    const flight = Promise.resolve()
      .then(() => {
        if (!active.current || document.hidden || pendingWrites.current > 0 || revision !== writeRevision.current) return null;
        return coworkerBridge.activity.list();
      })
      .then((next) => {
        if (!next || !mounted.current || !active.current || revision !== writeRevision.current) return;
        setItems(next);
        setError("");
      })
      .catch((cause: unknown) => {
        if (!mounted.current || !active.current || revision !== writeRevision.current) return;
        setError(errorMessage(cause, "Activity could not be refreshed. Try again."));
      })
      .finally(() => {
        listFlight.current = null;
        if (mounted.current) setLoading(false);
      });
    listFlight.current = flight;
    return flight;
  }, []);

  const markRead = useCallback((ids: string[], read = true): Promise<void> => {
    // Copy the caller's snapshot before queueing; later arrivals cannot join this write.
    const snapshotIds = [...new Set(ids)].filter(Boolean);
    if (snapshotIds.length === 0) return Promise.resolve();
    if (!mounted.current || !active.current) return Promise.reject(new Error("Activity is not available right now."));

    // Invalidate any older list immediately, including while the write is still queued.
    writeRevision.current += 1;
    pendingWrites.current += 1;
    setBusy(true);
    setError("");
    // Serialize acknowledgements as well as reads: a slow earlier response must not
    // replace a later mark-unread result. Rejected writes never retry automatically.
    const operation = writeTail.current
      .then(async () => {
        const next = await coworkerBridge.activity.markRead(snapshotIds, read);
        if (mounted.current) {
          setItems(next);
          setError("");
        }
      })
      .catch((cause: unknown) => {
        const message = errorMessage(cause, "Read status could not be saved. Try again.");
        if (mounted.current) setError(message);
        throw new Error(message);
      })
      .finally(() => {
        pendingWrites.current -= 1;
        if (mounted.current) setBusy(pendingWrites.current > 0);
      });
    writeTail.current = operation.catch(() => undefined);
    return operation;
  }, []);

  useEffect(() => {
    mounted.current = true;
    active.current = enabled;
    let timer: number | undefined;

    const pause = () => {
      window.clearInterval(timer);
      timer = undefined;
    };
    const resume = () => {
      pause();
      if (!enabled || document.hidden) {
        if (!listFlight.current) setLoading(false);
        return;
      }
      void refresh();
      timer = window.setInterval(() => void refresh(), POLL_MS);
    };
    const focus = () => {
      if (enabled && !document.hidden) void refresh();
    };

    resume();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      active.current = false;
      pause();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", focus);
    };
  }, [enabled, refresh]);

  return { items, loading, error, refresh, markRead, busy };
}
