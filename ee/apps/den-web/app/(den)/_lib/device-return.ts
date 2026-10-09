/**
 * Device sign-in clients that may send the browser back to a page on the
 * person's own machine after Approve or Deny. The OpenCode plugin listens on a
 * loopback port; the redirect carries only the outcome, never a code or token,
 * and the client still receives its session by polling Den.
 */
const RETURNING_CLIENTS = new Set(["openwork-opencode-plugin"]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The loopback page to return to, or null when the client or URL is not allowed. */
export function deviceReturnUrl(raw: string | null | undefined, clientId: string | null): URL | null {
  if (!raw || !clientId || !RETURNING_CLIENTS.has(clientId)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || !url.port) return null;
  if (url.username || url.password || url.hash) return null;
  return url;
}

export function deviceReturnTarget(url: URL, result: "approved" | "denied"): string {
  const target = new URL(url);
  target.searchParams.set("result", result);
  return target.toString();
}
