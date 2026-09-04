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
 * Applied to every provider present in the effective config (OpenWork-managed
 * and user-configured providers). Providers that exist only through
 * environment variables or engine auth without a config entry are untouched:
 * adding a config entry for them would enable them without credentials.
 */
import {
  guardProviderFetch,
  isGuardedFetch,
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
      for (const provider of Object.values(config.provider ?? {})) {
        if (!isRecord(provider)) continue;
        const options = isRecord(provider.options) ? provider.options : {};
        if (isGuardedFetch(options.fetch)) continue;
        options.fetch = guardProviderFetch(isFetchLike(options.fetch) ? options.fetch : fetch, monitor);
        provider.options = options;
      }
    },
  };
};
