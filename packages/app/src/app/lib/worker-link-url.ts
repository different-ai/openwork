const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function maybeParseUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed);
  } catch {
    // Some values come as localhost:1455/path with no scheme.
    if (/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?(\/|$)/i.test(trimmed)) {
      try {
        return new URL(`http://${trimmed}`);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

export async function generateWorkerLinkUrl(
  inputUrl: string,
  registerLoopbackTarget: (targetUrl: string) => Promise<string>,
): Promise<string> {
  const parsed = maybeParseUrl(inputUrl);
  if (!parsed) return inputUrl;

  if (isLoopbackUrl(parsed)) {
    return registerLoopbackTarget(parsed.toString());
  }

  let replacedAny = false;
  const nextParams: Array<[string, string]> = [];

  for (const [key, value] of parsed.searchParams.entries()) {
    const nested = maybeParseUrl(value);
    if (!nested || !isLoopbackUrl(nested)) {
      nextParams.push([key, value]);
      continue;
    }
    nextParams.push([key, await registerLoopbackTarget(nested.toString())]);
    replacedAny = true;
  }

  if (!replacedAny) return parsed.toString();

  parsed.search = "";
  for (const [key, value] of nextParams) {
    parsed.searchParams.append(key, value);
  }

  return parsed.toString();
}
