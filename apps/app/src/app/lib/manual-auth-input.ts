import { normalizeDenBaseUrl } from "./den";

export type ManualAuthInput = {
  grant: string;
  baseUrl?: string;
};

export function parseManualAuthInput(value: string): ManualAuthInput | null {
  const embedded = /openwork(?:-dev)?:\/\/den-auth[^\s"'<>]*/i.exec(value)?.[0];
  const trimmed = (embedded ?? value).trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    const routeHost = url.hostname.toLowerCase();
    const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
    const routeSegments = routePath.split("/").filter(Boolean);
    const routeTail = routeSegments[routeSegments.length - 1] ?? "";
    if (
      (protocol === "openwork:" || protocol === "openwork-dev:") &&
      (routeHost === "den-auth" ||
        routePath === "den-auth" ||
        routeTail === "den-auth")
    ) {
      const grant = url.searchParams.get("grant")?.trim() ?? "";
      const nextBaseUrl =
        normalizeDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ??
        undefined;
      return grant ? { grant, baseUrl: nextBaseUrl } : null;
    }
  } catch {
  }

  return trimmed.length >= 12 ? { grant: trimmed } : null;
}
