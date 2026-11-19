/** Classify catalog input and extract pasted MCP addresses. */
export type SmartAddInputKind = "empty" | "url" | "domain" | "name" | "invalid";

const NAME_QUERY_PATTERN = /^[a-z0-9][a-z0-9 &_'-]{0,63}$/i;

export function classifySmartAddInput(rawQuery: string): SmartAddInputKind {
  const query = rawQuery.trim();
  if (!query) return "empty";
  if (query.length > 200) return "invalid";

  if (/^https?:\/\//i.test(query)) {
    try {
      const parsed = new URL(query);
      return parsed.username || parsed.password || parsed.hash ? "invalid" : "url";
    } catch {
      return "invalid";
    }
  }

  if (query.includes(".") && !/\s/.test(query)) {
    try {
      const parsed = new URL(`https://${query}`);
      return parsed.username || parsed.password || parsed.hash ? "invalid" : "domain";
    } catch {
      return "invalid";
    }
  }

  return NAME_QUERY_PATTERN.test(query) ? "name" : "invalid";
}

/**
 * The MCP address a catalog search holds, when it holds one: a full URL or a
 * bare domain (given https). Names and invalid input return null.
 */
export function pastedMcpAddress(rawQuery: string): { host: string; url: string } | null {
  const kind = classifySmartAddInput(rawQuery);
  if (kind !== "url" && kind !== "domain") return null;
  const query = rawQuery.trim();
  try {
    const parsed = new URL(kind === "url" ? query : `https://${query}`);
    if (!parsed.hostname) return null;
    return { host: parsed.host, url: kind === "url" ? query : `https://${query}` };
  } catch {
    return null;
  }
}
