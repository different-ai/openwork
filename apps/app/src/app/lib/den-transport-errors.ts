import type { DesktopStartupFailureReason } from "@openwork/types/den/diagnostics";

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (typeof current === "string") { parts.push(current); break; }
    if (typeof current !== "object") break;
    for (const key of ["name", "code", "message"]) {
      const value: unknown = Reflect.get(current, key);
      if (typeof value === "string") parts.push(value);
    }
    current = Reflect.get(current, "cause");
  }
  return parts.join(" ");
}

export function classifyStartupError(
  error: unknown,
  online: boolean = typeof navigator === "undefined" || navigator.onLine !== false,
): DesktopStartupFailureReason {
  const status = errorStatus(error);
  if (status === 401) return "session_expired";
  if (status !== null && status >= 500) return "server_error";
  if (!online) return "offline";
  const text = errorText(error);
  if (/\bCERT_|ERR_CERT|ERR_SSL|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED/.test(text) || /certificate/i.test(text)) return "certificate";
  if (/ERR_INTERNET_DISCONNECTED/.test(text)) return "offline";
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|getaddrinfo/.test(text)) return "dns";
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(text)) return "connection_refused";
  if (/ETIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|TimeoutError|AbortError|timed out|timeout/i.test(text)) return "timeout";
  return "unknown";
}
