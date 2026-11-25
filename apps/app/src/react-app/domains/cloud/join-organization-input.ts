export type ParsedInviteLink = { url: string; origin: string; host: string };
export type ParsedServerUrl = { url: string; host: string };

function parseHttpUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function parseInviteLinkInput(value: string): ParsedInviteLink | null {
  const url = parseHttpUrl(value);
  if (!url) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if ((segments[segments.length - 1] ?? "").toLowerCase() !== "join-org") return null;
  if (!(url.searchParams.get("invite") ?? "").trim()) return null;
  return { url: url.toString(), origin: url.origin, host: url.host };
}

export function parseServerUrlInput(value: string): ParsedServerUrl | null {
  const url = parseHttpUrl(value);
  if (!url) return null;
  return { url: url.toString().replace(/\/+$/, ""), host: url.host };
}
