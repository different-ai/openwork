import { DEFAULT_DEN_BASE_URL, normalizeDenBaseUrl } from "./den";
import { normalizeOpenworkServerUrl } from "./openwork-server";
import { normalizeBundleImportIntent, parseBundleDeepLink } from "../bundles/sources";
import type { BundleRequest } from "../bundles/types";

export type RemoteWorkspaceDefaults = {
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
  autoConnect?: boolean;
};

export type DenAuthDeepLink = {
  grant: string;
  denBaseUrl: string;
};

function isSupportedDeepLinkProtocol(protocol: string): boolean {
  const normalized = protocol.toLowerCase();
  return normalized === "openwork:" || normalized === "openwork-dev:" || normalized === "https:" || normalized === "http:";
}

export function parseRemoteConnectDeepLink(rawUrl: string): RemoteWorkspaceDefaults | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "connect-remote" && routePath !== "connect-remote" && routeTail !== "connect-remote") {
    return null;
  }

  const hostUrlRaw = url.searchParams.get("openworkHostUrl") ?? url.searchParams.get("openworkUrl") ?? "";
  const tokenRaw = url.searchParams.get("openworkToken") ?? url.searchParams.get("accessToken") ?? "";
  const normalizedHostUrl = normalizeOpenworkServerUrl(hostUrlRaw);
  const token = tokenRaw.trim();
  if (!normalizedHostUrl || !token) {
    return null;
  }

  const workerName = url.searchParams.get("workerName")?.trim() ?? "";
  const workerId = url.searchParams.get("workerId")?.trim() ?? "";
  const displayName = workerName || (workerId ? `Worker ${workerId.slice(0, 8)}` : "");
  const autoConnectRaw =
    url.searchParams.get("autoConnect") ??
    url.searchParams.get("bypassModal") ??
    url.searchParams.get("bypassAddWorkerModal") ??
    "";
  const autoConnect = ["1", "true", "yes", "on"].includes(autoConnectRaw.trim().toLowerCase());

  return {
    openworkHostUrl: normalizedHostUrl,
    openworkToken: token,
    directory: null,
    displayName: displayName || null,
    autoConnect,
  };
}

export function stripRemoteConnectQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of [
    "openworkHostUrl",
    "openworkUrl",
    "openworkToken",
    "accessToken",
    "workerId",
    "workerName",
    "autoConnect",
    "bypassModal",
    "bypassAddWorkerModal",
    "source",
  ]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

export function parseDenAuthDeepLink(rawUrl: string): DenAuthDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "den-auth" && routePath !== "den-auth" && routeTail !== "den-auth") {
    return null;
  }

  const grant = url.searchParams.get("grant")?.trim() ?? "";
  const denBaseUrl = normalizeDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ?? DEFAULT_DEN_BASE_URL;
  if (!grant) {
    return null;
  }

  return { grant, denBaseUrl };
}

function normalizeDebugDeepLinkInput(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";

  const directMatch = trimmed.match(/(?:openwork-dev|openwork|https?):\/\/[^\s"'<>]+/i);
  if (directMatch) return directMatch[0];

  const bareShareMatch = trimmed.match(/share\.openwork(?:labs\.com|\.software)\/b\/[^\s"'<>]+/i);
  if (bareShareMatch) return `https://${bareShareMatch[0]}`;

  return trimmed;
}

export function parseDebugDeepLinkInput(rawValue: string):
  | { kind: "bundle"; link: BundleRequest }
  | { kind: "remote"; link: RemoteWorkspaceDefaults }
  | { kind: "auth"; link: DenAuthDeepLink }
  | null {
  const normalized = normalizeDebugDeepLinkInput(rawValue);
  if (!normalized) return null;

  const denAuthLink = parseDenAuthDeepLink(normalized);
  if (denAuthLink) {
    return { kind: "auth", link: denAuthLink };
  }

  const bundleLink = parseBundleDeepLink(normalized);
  if (bundleLink) {
    return { kind: "bundle", link: bundleLink };
  }

  const remoteConnectLink = parseRemoteConnectDeepLink(normalized);
  if (remoteConnectLink) {
    return { kind: "remote", link: remoteConnectLink };
  }

  const bundleMatch = normalized.match(/ow_bundle=([^&\s]+)/i);
  if (bundleMatch?.[1]) {
    try {
      const bundleUrl = decodeURIComponent(bundleMatch[1]);
      const intentMatch = normalized.match(/(?:ow_intent|intent)=([^&\s]+)/i);
      const labelMatch = normalized.match(/ow_label=([^&\s]+)/i);
      const sourceMatch = normalized.match(/(?:ow_source|source)=([^&\s]+)/i);
      return {
        kind: "bundle",
        link: {
          bundleUrl,
          intent: normalizeBundleImportIntent(intentMatch?.[1] ? decodeURIComponent(intentMatch[1]) : undefined),
          label: labelMatch?.[1] ? decodeURIComponent(labelMatch[1]) : undefined,
          source: sourceMatch?.[1] ? decodeURIComponent(sourceMatch[1]) : undefined,
        },
      };
    } catch {
      // ignore fallback parsing errors
    }
  }

  const shareIdMatch = normalized.match(/share\.openwork(?:labs\.com|\.software)\/b\/([^\s/?#"'<>]+)/i);
  if (shareIdMatch?.[1]) {
    return {
      kind: "bundle",
      link: {
        bundleUrl: `https://share.openworklabs.com/b/${shareIdMatch[1]}`,
        intent: "new_worker",
      },
    };
  }

  return null;
}
