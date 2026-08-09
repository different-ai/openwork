import { DEFAULT_DEN_BASE_URL, normalizeDenBaseUrl } from "./den";
import { normalizeOpenworkServerUrl } from "./openwork-server";

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

export type ConnectDeepLink = {
  /** The full deep link, relayed verbatim to the main process for verification. */
  rawUrl: string;
  key: string;
};

function isSupportedDeepLinkProtocol(protocol: string): boolean {
  const normalized = protocol.toLowerCase();
  return normalized === "openwork:"
    || normalized === "openwork-dev:"
    || normalized === "https:"
    || normalized === "http:";
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

  return {
    grant,
    denBaseUrl,
  };
}

export type OrgInviteLink = {
  /** Web origin of the Den deployment the invitation belongs to. */
  origin: string;
  host: string;
  token: string;
  /** Public, unauthenticated invitation preview endpoint on that origin. */
  previewUrl: string;
};

const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/;

function usesLocalHttpHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "localhost"
    || normalized.startsWith("localhost:")
    || normalized === "127.0.0.1"
    || normalized.startsWith("127.")
  );
}

/**
 * Recognize an organization invite link — the URL a teammate receives in the
 * "You're invited to join …" email or via the dashboard's "Copy invite link"
 * action: `https://<den-web-origin>/join-org?invite=<token>`.
 *
 * Ordinary web origins only: invites never ride the desktop scheme, and plain
 * http is accepted solely for local development hosts.
 */
export function parseOrgInviteLink(rawUrl: string): OrgInviteLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "https:" && !(protocol === "http:" && usesLocalHttpHost(url.host))) {
    return null;
  }

  if (url.pathname.replace(/\/+$/, "") !== "/join-org") {
    return null;
  }

  const token = url.searchParams.get("invite")?.trim() ?? "";
  if (!INVITE_TOKEN_PATTERN.test(token)) {
    return null;
  }

  const previewUrl = new URL("/api/den/v1/orgs/invitations/preview", url.origin);
  previewUrl.searchParams.set("id", token);

  return { origin: url.origin, host: url.host, token, previewUrl: previewUrl.toString() };
}

/**
 * Build the browser URL that finishes joining: the join page with the desktop
 * handoff flags, so after the person accepts the invite the web app offers
 * "Return to OpenWork" and signs this app in with a one-time grant.
 */
export function buildOrgInviteJoinUrl(
  link: OrgInviteLink,
  options: { desktopAuth: boolean; desktopScheme?: string },
): string {
  const url = new URL("/join-org", link.origin);
  url.searchParams.set("invite", link.token);
  if (options.desktopAuth) {
    url.searchParams.set("desktopAuth", "1");
    url.searchParams.set("desktopScheme", options.desktopScheme ?? "openwork");
  }
  return url.toString();
}

export function parseConnectDeepLink(rawUrl: string): ConnectDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  // Unlike sibling parsers, organization connect credentials only ride the
  // dedicated desktop scheme, never ordinary web URLs.
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "openwork:" && protocol !== "openwork-dev:") {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "connect" && routePath !== "connect" && routeTail !== "connect") {
    return null;
  }

  const token = url.searchParams.get("token")?.trim() ?? "";
  const code = url.searchParams.get("code")?.trim() ?? "";
  const apiBaseUrl = url.searchParams.get("apiBaseUrl")?.trim() ?? "";
  const signed = Boolean(token) && !code && !apiBaseUrl;
  const exchange = !token && /^[A-Za-z0-9_-]{24,128}$/.test(code) && Boolean(apiBaseUrl);
  if (!signed && !exchange) {
    return null;
  }

  return { rawUrl, key: signed ? `signed:${token}` : `exchange:${apiBaseUrl}:${code}` };
}

function normalizeDebugDeepLinkInput(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";

  const directMatch = trimmed.match(/(?:openwork-dev|openwork|https?):\/\/[^\s"'<>]+/i);
  if (directMatch) return directMatch[0];

  return trimmed;
}

export function parseDebugDeepLinkInput(rawValue: string):
  | { kind: "remote"; link: RemoteWorkspaceDefaults }
  | { kind: "auth"; link: DenAuthDeepLink }
  | null {
  const normalized = normalizeDebugDeepLinkInput(rawValue);
  if (!normalized) return null;

  const denAuthLink = parseDenAuthDeepLink(normalized);
  if (denAuthLink) {
    return { kind: "auth", link: denAuthLink };
  }

  const remoteConnectLink = parseRemoteConnectDeepLink(normalized);
  if (remoteConnectLink) {
    return { kind: "remote", link: remoteConnectLink };
  }

  return null;
}
