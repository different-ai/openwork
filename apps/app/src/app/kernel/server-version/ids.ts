import { normalizeOpenworkServerUrl } from "../../lib/openwork-server";

export const LOCAL_SERVER_ID = "srv_local";

export function createRemoteServerId(baseUrl: string) {
  const normalized = normalizeOpenworkServerUrl(baseUrl) ?? baseUrl.trim();
  return `srv_remote:${encodeURIComponent(normalized)}`;
}
