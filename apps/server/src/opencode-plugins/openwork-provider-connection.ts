/**
 * OpenWork Provider Connection Plugin
 *
 * When the computer sleeps or loses its network mid-turn, the engine's model
 * request does not fail — the socket just goes quiet — so a thread shows
 * "Working" until the engine's own multi-minute stream timeout fires, and the
 * engine's retry budget is then spent on requests made while still offline.
 *
 * The engine already retries provider failures with backoff and reports each
 * attempt as a `retry` status. This plugin only improves the signal it gets,
 * through the supported `provider.options.fetch` seam:
 *
 * - a new request waits (bounded) for the machine to have a network route
 *   instead of failing immediately while offline;
 * - after a suspend/resume or network change, an in-flight request that
 *   receives nothing within a short grace window fails with a retryable
 *   "connection lost" error, so the engine retries right away.
 *
 * Applied only to OpenWork-managed provider IDs (openwork and lpr_*). The
 * engine loads provider auth handlers, then reapplies config options: setting
 * fetch on a user's provider here would overwrite its OAuth/signing transport.
 * Existing custom fetch functions are also left intact. Other providers keep
 * the engine's native timeout and retry behavior.
 */
import {
  guardProviderFetch,
  sharedConnectionMonitor,
  type FetchLike,
} from "./provider-connection-guard.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFetchLike(value: unknown): value is FetchLike {
  return typeof value === "function";
}

// Single export: the OpenCode plugin loader treats every export of a plugin
// module as a plugin factory, so helpers must stay module-private.
export const OpenWorkProviderConnection = async () => {
  const monitor = sharedConnectionMonitor();
  return {
    config: async (config: { provider?: Record<string, unknown> }) => {
      for (const [id, provider] of Object.entries(config.provider ?? {})) {
        if (id !== "openwork" && !/^lpr_/i.test(id)) continue;
        if (!isRecord(provider)) continue;
        const options = isRecord(provider.options) ? provider.options : {};
        if (isFetchLike(options.fetch)) continue;
        options.fetch = guardProviderFetch(fetch, monitor);
        provider.options = options;
      }
    },
  };
};
