import { DEFAULT_DEN_BASE_URL, normalizeDenBaseUrl } from "./den";

export type DenAuthDeepLink = {
  grant: string;
  denBaseUrl: string;
};

export type ConnectDeepLink = {
  /** The full deep link, relayed verbatim to the main process for verification. */
  rawUrl: string;
  key: string;
};

/** `openwork://chat?prompt=…&connector=…` — open a new chat with a seeded composer. */
export type ChatDeepLink = {
  prompt: string;
  /** Connector the prompt is about (rendered as a chip ahead of the prompt). */
  connector: string | null;
  /** Dedupe key so a replayed queue never seeds the same chat twice. */
  key: string;
};

const CHAT_DEEP_LINK_PROMPT_MAX_LENGTH = 4000;
const CHAT_DEEP_LINK_CONNECTOR_MAX_LENGTH = 80;

function isSupportedDeepLinkProtocol(protocol: string): boolean {
  const normalized = protocol.toLowerCase();
  return normalized === "openwork:"
    || normalized === "openwork-dev:"
    || normalized === "https:"
    || normalized === "http:";
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

export function parseChatDeepLink(rawUrl: string): ChatDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  // Chat seeding is a desktop handoff from Den; ordinary web URLs never
  // pre-fill the composer.
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "openwork:" && protocol !== "openwork-dev:") {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "chat" && routePath !== "chat" && routeTail !== "chat") {
    return null;
  }

  const prompt = (url.searchParams.get("prompt") ?? "").trim().slice(0, CHAT_DEEP_LINK_PROMPT_MAX_LENGTH);
  const connector = (url.searchParams.get("connector") ?? "")
    .trim()
    .replace(/[\[\]\n\r]/g, "")
    .slice(0, CHAT_DEEP_LINK_CONNECTOR_MAX_LENGTH);
  if (!prompt && !connector) {
    return null;
  }

  return {
    prompt,
    connector: connector || null,
    key: `chat:${connector}:${prompt}`,
  };
}
