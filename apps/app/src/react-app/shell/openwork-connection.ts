import {
  getOpenworkGatewayOrigin,
  readOpenworkGatewayDenToken,
} from "../../app/lib/gateway-runtime";
import {
  isLoopbackOpenworkServerUrl,
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
} from "../../app/lib/openwork-server";
import { isWebDeployment } from "../../app/lib/openwork-deployment";
import { openworkServerInfo, type OpenworkServerInfo } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";

export type OpenworkConnectionSource = "desktop-runtime" | "stored-settings" | "same-origin" | "gateway" | "empty";

export type ResolvedOpenworkConnection = {
  normalizedBaseUrl: string;
  resolvedToken: string;
  resolvedHostToken: string;
  hostInfo: OpenworkServerInfo | null;
  source: OpenworkConnectionSource;
};

function hasUsableConnection(url: string, token: string) {
  return url.trim().length > 0 && token.trim().length > 0;
}

/**
 * Stored settings for a desktop-managed local server are snapshots of
 * ephemeral state: the server mints a fresh loopback port and tokens on every
 * (re)start. When the live desktop runtime definitively reports that the
 * server is not ready, any stored loopback connection is from a previous
 * server lifetime — resolving it would point the route at a dead port and
 * make a restart look like a broken connection instead of a transient gap.
 * Stored non-loopback URLs (remote/manual servers) stay usable as fallbacks,
 * and a failing desktop bridge (no definitive answer) keeps today's fallback
 * behavior.
 */
export function isStaleStoredDesktopConnection(input: {
  desktopRuntime: boolean;
  desktopServerReportedNotReady: boolean;
  storedBaseUrl: string;
  runtimeReportedBaseUrl: string;
}): boolean {
  if (!input.desktopRuntime || !input.desktopServerReportedNotReady) return false;
  if (!input.storedBaseUrl) return false;
  return (
    isLoopbackOpenworkServerUrl(input.storedBaseUrl) ||
    input.storedBaseUrl === input.runtimeReportedBaseUrl
  );
}

/**
 * Resolve the OpenWork server connection for routes that consume the server API.
 *
 * Local desktop-hosted servers expose ephemeral loopback ports and freshly
 * minted tokens on every boot, so live runtime info is the source of truth
 * there. Stored settings remain the fallback for remote/manual server
 * connections and for desktop cases where the runtime bridge is unavailable.
 */
export async function resolveOpenworkConnection(): Promise<ResolvedOpenworkConnection> {
  const gatewayOrigin = getOpenworkGatewayOrigin();
  if (gatewayOrigin) {
    return {
      normalizedBaseUrl: normalizeOpenworkServerUrl(gatewayOrigin) ?? "",
      resolvedToken: readOpenworkGatewayDenToken(),
      resolvedHostToken: "",
      hostInfo: null,
      source: "gateway",
    };
  }

  let staleDesktopRuntimeBaseUrl = "";
  let desktopServerReportedNotReady = false;

  if (isDesktopRuntime()) {
    try {
      const info = await openworkServerInfo() as OpenworkServerInfo;
      const normalizedBaseUrl =
        normalizeOpenworkServerUrl(info.baseUrl ?? "") ??
        "";
      const resolvedToken = info.ownerToken?.trim() || info.clientToken?.trim() || "";
      if (info.running === true && hasUsableConnection(normalizedBaseUrl, resolvedToken)) {
        return {
          normalizedBaseUrl,
          resolvedToken,
          resolvedHostToken: info.hostToken?.trim() || "",
          hostInfo: info,
          source: "desktop-runtime",
        };
      }
      // Definitive live answer: the local server is booting/restarting and
      // has not republished a usable connection yet.
      desktopServerReportedNotReady = true;
      staleDesktopRuntimeBaseUrl = normalizedBaseUrl;
    } catch {
      // Fall through to stored settings for remote/manual connections.
    }
  }

  const settings = readOpenworkServerSettings();
  const normalizedBaseUrl = normalizeOpenworkServerUrl(settings.urlOverride ?? "") ?? "";
  const sameOriginBaseUrl =
    !normalizedBaseUrl && !isDesktopRuntime() && isWebDeployment() && typeof window !== "undefined"
      ? normalizeOpenworkServerUrl(window.location.origin) ?? ""
      : "";
  const resolvedToken = settings.token?.trim() ?? "";
  const resolvedHostToken =
    normalizedBaseUrl && isLoopbackOpenworkServerUrl(normalizedBaseUrl)
      ? settings.hostToken?.trim() ?? ""
      : "";
  const storedConnectionIsStaleDesktopRuntime = isStaleStoredDesktopConnection({
    desktopRuntime: isDesktopRuntime(),
    desktopServerReportedNotReady,
    storedBaseUrl: normalizedBaseUrl,
    runtimeReportedBaseUrl: staleDesktopRuntimeBaseUrl,
  });
  const source =
    !storedConnectionIsStaleDesktopRuntime && hasUsableConnection(normalizedBaseUrl, resolvedToken)
      ? "stored-settings"
      : hasUsableConnection(sameOriginBaseUrl, resolvedToken)
        ? "same-origin"
        : "empty";

  return {
    normalizedBaseUrl: source === "same-origin"
      ? sameOriginBaseUrl
      : source === "empty"
        ? ""
        : normalizedBaseUrl,
    resolvedToken: source === "empty" ? "" : resolvedToken,
    resolvedHostToken: source === "empty" ? "" : resolvedHostToken,
    hostInfo: null,
    source,
  };
}
