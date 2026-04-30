import {
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
} from "../../app/lib/openwork-server";
import { openworkServerInfo, type OpenworkServerInfo } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";

export type OpenworkConnectionSource = "desktop-runtime" | "stored-settings" | "empty";

export type ResolvedOpenworkConnection = {
  normalizedBaseUrl: string;
  resolvedToken: string;
  hostInfo: OpenworkServerInfo | null;
  source: OpenworkConnectionSource;
};

/**
 * Resolve the OpenWork server connection for routes that consume the server API.
 *
 * Local desktop-hosted servers expose ephemeral loopback ports and freshly
 * minted tokens on every boot, so live runtime info is the source of truth
 * there. Stored settings remain the fallback for remote/manual server
 * connections and for desktop cases where the runtime bridge is unavailable.
 */
export async function resolveOpenworkConnection(): Promise<ResolvedOpenworkConnection> {
  if (isDesktopRuntime()) {
    try {
      const info = await openworkServerInfo();
      const normalizedBaseUrl =
        normalizeOpenworkServerUrl(info.connectUrl ?? info.baseUrl ?? info.lanUrl ?? info.mdnsUrl ?? "") ??
        "";
      const resolvedToken = info.ownerToken?.trim() || info.clientToken?.trim() || "";
      if (normalizedBaseUrl || resolvedToken) {
        return {
          normalizedBaseUrl,
          resolvedToken,
          hostInfo: info,
          source: "desktop-runtime",
        };
      }
    } catch {
      // Fall through to stored settings for remote/manual connections.
    }
  }

  const settings = readOpenworkServerSettings();
  const normalizedBaseUrl = normalizeOpenworkServerUrl(settings.urlOverride ?? "") ?? "";
  const resolvedToken = settings.token?.trim() ?? "";

  return {
    normalizedBaseUrl,
    resolvedToken,
    hostInfo: null,
    source: normalizedBaseUrl || resolvedToken ? "stored-settings" : "empty",
  };
}
