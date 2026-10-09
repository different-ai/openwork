/**
 * Device sign-in clients that may send the browser back to a page on the
 * person's own machine after Approve or Deny. The OpenCode plugin listens on a
 * loopback port at one fixed path; the redirect carries only the outcome, never
 * a code or token, and the client still receives its session by polling Den.
 *
 * The address is pinned to that exact page (127.0.0.1, a port, the plugin's
 * callback path, nothing else) so a crafted link cannot point the browser at
 * other services on the machine.
 */
const RETURN_PATHS: Readonly<Record<string, string>> = {
  "openwork-opencode-plugin": "/openwork/callback",
};

/** The loopback page to return to, or null when the client or URL is not allowed. */
export function deviceReturnUrl(raw: string | null | undefined, clientId: string | null): URL | null {
  const path = clientId ? RETURN_PATHS[clientId] : undefined;
  if (!raw || !path) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return null;
  if (url.pathname !== path || url.search || url.hash || url.username || url.password) return null;
  return url;
}

export function deviceReturnTarget(url: URL, result: "approved" | "denied"): string {
  const target = new URL(url);
  target.searchParams.set("result", result);
  return target.toString();
}
