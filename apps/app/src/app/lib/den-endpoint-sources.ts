import { normalizeDenBaseUrl } from "./den";

export type DenEndpointSource = "custom" | "bootstrap" | "default";

export function describeDenEndpointSource(input: {
  storedValue: string | null;
  bootstrapValue: string | null;
  buildDefault: string;
}): { effective: string; source: DenEndpointSource } {
  const bootstrap = normalizeDenBaseUrl(input.bootstrapValue);
  if (bootstrap) {
    return { effective: bootstrap, source: "bootstrap" };
  }

  return {
    effective: normalizeDenBaseUrl(input.buildDefault) ?? input.buildDefault.trim(),
    source: "default",
  };
}

function parsedHttpUrl(input: string | null): URL | null {
  const normalized = normalizeDenBaseUrl(input);
  if (!normalized) return null;

  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function isLocalhostHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function describeCloudMcpTarget(input: {
  mcpUrl: string | null;
  effectiveApiBaseUrl: string;
}): { url: string | null; isLocalhost: boolean; matchesApi: boolean } {
  const mcp = parsedHttpUrl(input.mcpUrl);
  if (!mcp) {
    return { url: null, isLocalhost: false, matchesApi: false };
  }

  const api = parsedHttpUrl(input.effectiveApiBaseUrl);

  return {
    url: mcp.toString().replace(/\/+$/, ""),
    isLocalhost: isLocalhostHostname(mcp.hostname),
    matchesApi: api !== null && mcp.origin === api.origin,
  };
}
