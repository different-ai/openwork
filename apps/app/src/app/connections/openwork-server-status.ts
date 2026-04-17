import type { OpenworkServerInfo } from "../lib/tauri";
import type { OpenworkServerStatus } from "../lib/openwork-server";

export function resolveEffectiveOpenworkServerStatus(
  status: OpenworkServerStatus,
  hostInfo: OpenworkServerInfo | null | undefined,
): OpenworkServerStatus {
  const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
  if (hostInfo?.running === true && baseUrl) {
    return "connected";
  }
  return status;
}
