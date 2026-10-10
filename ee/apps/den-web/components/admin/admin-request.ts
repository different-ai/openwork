import { denApiCredentials, denBrowserEndpoint } from "../../app/(den)/_lib/den-api-origin";

const AUTH_TOKEN_STORAGE_KEY = "openwork:web:auth-token";

/**
 * Keeps password-login bearer credentials alongside the web-host session
 * cookie; the same-origin browser proxy forwards both to Den API.
 */
export function withStoredBearer(headers: Record<string, string>): Record<string, string> {
  if (typeof window === "undefined") return headers;
  const token = window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

export type AdminAccess = "ready" | "signed-out" | "forbidden" | "error";

export type AdminResult<T> =
  | { access: "ready"; data: T }
  | { access: Exclude<AdminAccess, "ready">; message: string };

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["message", "error"]) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return fallback;
}

/** GET an admin endpoint and map the response to the access states every admin page shows. */
export async function requestAdmin<T>(path: string, parse: (payload: unknown) => T | null, signal?: AbortSignal): Promise<AdminResult<T>> {
  const endpoint = denBrowserEndpoint(path);
  const response = await fetch(endpoint, {
    method: "GET",
    credentials: denApiCredentials(endpoint),
    signal,
    headers: withStoredBearer({ Accept: "application/json" }),
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (response.status === 401) return { access: "signed-out", message: "Sign in with an OpenWork admin account to continue." };
  if (response.status === 403) return { access: "forbidden", message: "This account is not on the OpenWork admin allowlist." };
  if (!response.ok) return { access: "error", message: errorMessage(payload, `The request failed with status ${response.status}.`) };
  const data = parse(payload);
  return data === null ? { access: "error", message: "The server returned data this page does not understand." } : { access: "ready", data };
}

/** PUT/POST JSON to an admin endpoint; returns the parsed payload or the server's error message. */
export async function sendAdmin(path: string, method: "PUT" | "POST", body: unknown): Promise<{ ok: true; payload: unknown } | { ok: false; message: string }> {
  const endpoint = denBrowserEndpoint(path);
  const response = await fetch(endpoint, {
    method,
    credentials: denApiCredentials(endpoint),
    headers: withStoredBearer({ Accept: "application/json", "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) return { ok: false, message: errorMessage(payload, `The request failed with status ${response.status}.`) };
  return { ok: true, payload };
}
