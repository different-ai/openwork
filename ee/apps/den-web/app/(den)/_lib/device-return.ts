const RETURN_PATHS: Readonly<Record<string, string>> = {
  "openwork-opencode-plugin": "/openwork/callback",
};

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
