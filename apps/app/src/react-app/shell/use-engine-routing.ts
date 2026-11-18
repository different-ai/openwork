import { useEffect } from "react";
import { createOpenworkServerClient, type EngineV2PreviewStatus } from "../../app/lib/openwork-server";
import { selectedChatEngine } from "./engine-switch";
import { resolveOpenworkConnection } from "./openwork-connection";

/** Follow host-owned engine changes without exposing or controlling history migration. */
export function startEngineRoutingPolling(options: {
  read: () => Promise<{ baseUrl: string; status: EngineV2PreviewStatus } | null>;
  changed: () => void;
  schedule?: (callback: () => void, ms: number) => () => void;
}): () => void {
  const engines = new Map<string, "v1" | "v2">();
  let stopped = false;
  let cancelPending: (() => void) | undefined;
  const schedule = options.schedule ?? ((callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  });
  const poll = async () => {
    try {
      const result = await options.read();
      if (!stopped && result) {
        const instance = result.baseUrl.replace(/\/+$/, "");
        const engine = selectedChatEngine(result.status);
        const previous = engines.get(instance);
        engines.set(instance, engine);
        if (previous && previous !== engine) options.changed();
      }
    } catch { /* Startup and offline periods retry without changing routing. */ }
    if (!stopped) cancelPending = schedule(() => { void poll(); }, 3_000);
  };
  void poll();
  return () => { stopped = true; cancelPending?.(); };
}

export function useEngineRouting(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    return startEngineRoutingPolling({
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
      changed: () => window.dispatchEvent(new CustomEvent("openwork-engine-changed")),
    });
  }, [enabled]);
}
