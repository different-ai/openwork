import { guardProviderFetch } from "./provider-connection-guard.js";
import { resumeMonitor } from "./provider-resume-monitor.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The loader invokes every export as a plugin factory: keep helpers private.
export const OpenWorkProviderConnection = async () => ({
  config: async (config: { provider?: Record<string, unknown> }) => {
    for (const [id, provider] of Object.entries(config.provider ?? {})) {
      // OpenCode reapplies config after auth.loader, so a generic fetch here
      // would overwrite OAuth/signing transports on user-configured providers.
      // These reserved IDs belong to OpenWork's managed API-key configuration.
      if (id !== "openwork" && !/^lpr_/i.test(id)) continue;
      if (!isRecord(provider)) continue;
      const options = isRecord(provider.options) ? provider.options : {};
      if (options.fetch !== undefined) continue;
      options.fetch = guardProviderFetch(fetch, resumeMonitor);
      provider.options = options;
    }
  },
});
