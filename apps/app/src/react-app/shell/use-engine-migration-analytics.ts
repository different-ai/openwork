import { useEffect } from "react";
import { observeEngineMigrationAnalytics, type EngineMigrationAnalyticsStatus } from "../../app/lib/engine-migration-analytics";
import { createOpenworkServerClient } from "../../app/lib/openwork-server";
import { resolveOpenworkConnection } from "./openwork-connection";

/** Non-overlapping polling with injectable timers; never mutates engine policy or UI. */
export function startEngineMigrationAnalyticsPolling(options: {
  read: () => Promise<{ baseUrl: string; status: EngineMigrationAnalyticsStatus } | null>;
  observe: typeof observeEngineMigrationAnalytics;
  schedule?: (callback: () => void, ms: number) => () => void;
}): () => void {
  let stopped = false;
  let cancelPending: (() => void) | undefined;
  const schedule = options.schedule ?? ((callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  });
  const poll = async () => {
    try {
      const result = await options.read();
      if (!stopped && result) options.observe(result.baseUrl, result.status);
    } catch { /* Runtime startup, sign-out, and offline periods retry without telemetry or UI errors. */ }
    if (!stopped) cancelPending = schedule(() => { void poll(); }, 3_000);
  };
  void poll();
  return () => {
    stopped = true;
    cancelPending?.();
  };
}

/** Both surfaces observe automatic migrations even when no migration UI is open. */
export function useEngineMigrationAnalytics(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    return startEngineMigrationAnalyticsPolling({
      read: async () => {
        const connection = await resolveOpenworkConnection();
        if (!connection.normalizedBaseUrl || !connection.resolvedToken) return null;
        const client = createOpenworkServerClient({
          baseUrl: connection.normalizedBaseUrl,
          token: connection.resolvedToken,
          hostToken: connection.resolvedHostToken,
        });
        return { baseUrl: connection.normalizedBaseUrl, status: await client.getEngineV2PreviewStatus() };
      },
      observe: observeEngineMigrationAnalytics,
    });
  }, [enabled]);
}
