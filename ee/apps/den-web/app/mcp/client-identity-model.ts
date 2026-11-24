export type McpRedirectDescription = {
  host: string;
  url: string;
  loopbackOnly: boolean;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host);
}

export function describeMcpRedirect(redirectUri: string | null): McpRedirectDescription | null {
  if (!redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { host: url.host, url: url.href, loopbackOnly: isLoopbackHost(url.hostname) };
    }
    return { host: `${url.protocol}//`, url: url.href, loopbackOnly: false };
  } catch {
    return null;
  }
}

export function fallbackClientName(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return "An app without a name";
  }
}
