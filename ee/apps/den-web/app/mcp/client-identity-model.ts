/**
 * What the consent page says about the app asking for access. The redirect
 * host comes from the signed OAuth query Better Auth hands the consent page,
 * so it is the address the authorization code will actually be sent to.
 */
export type McpRedirectDescription = {
  host: string;
  /** Only loopback redirects: the code goes to whatever runs on this computer. */
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
      return { host: url.host, loopbackOnly: isLoopbackHost(url.hostname) };
    }
    // Native app schemes (e.g. cursor://) name the app that will receive the code.
    return { host: `${url.protocol}//`, loopbackOnly: false };
  } catch {
    return null;
  }
}

/** A readable fallback name when the client registered none. */
export function fallbackClientName(clientId: string): string {
  try {
    // Client ID Metadata Documents use an HTTPS URL as the client id.
    return new URL(clientId).host;
  } catch {
    return "An app without a name";
  }
}
